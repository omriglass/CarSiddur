import { ensureDepartmentWeeks } from "@/features/siddur/api";
import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database, Json } from "@/integrations/supabase/types";

/**
 * The only file in the `sadran` feature that calls `supabase.from`/`.rpc`
 * (ui-dev.md "Structure"). Covers every screen (dashboard, board, proposal
 * composer, contested claims, publish, change log) since they all share the
 * same `(departmentId, weekStart)` scope and many of the same tables.
 */
export type WeekRow = Database["public"]["Tables"]["weeks"]["Row"];
export type RequestRow = Database["public"]["Tables"]["requests"]["Row"];
export type DepartmentSettingsRow = Database["public"]["Tables"]["department_settings"]["Row"];
export type MaintenanceBlockRow = Database["public"]["Tables"]["car_maintenance_blocks"]["Row"];
export type SolverRunRow = Database["public"]["Tables"]["solver_runs"]["Row"];
export type ProposalRow = Database["public"]["Tables"]["proposals"]["Row"];
export type ProposalPartyRow = Database["public"]["Tables"]["proposal_parties"]["Row"];
export type FreedSlotOfferRow = Database["public"]["Tables"]["freed_slot_offers"]["Row"];
export type FreedSlotClaimRow = Database["public"]["Tables"]["freed_slot_claims"]["Row"];
export type SiddurVersionRow = Database["public"]["Tables"]["siddur_versions"]["Row"];
export type AuditLogRow = Database["public"]["Tables"]["audit_log"]["Row"];
export type NotificationTemplateRow = Database["public"]["Tables"]["notification_templates"]["Row"];
export type PolicyRow = Database["public"]["Tables"]["policies"]["Row"];
export type PolicyVersionRow = Database["public"]["Tables"]["policy_versions"]["Row"];
export type BoardRide = Database["public"]["Views"]["v_board_rides"]["Row"];

/**
 * `requests` plus the joined names the board/dashboard need to show *which*
 * request is unmet (owner bug report #1: the unmet list/counters must be
 * usable without a solver run, straight from persisted data) — embedded via
 * PostgREST's FK-embed syntax rather than a new view/migration, since every
 * relationship already exists (`requests.requester_id -> profiles`,
 * `.destination_id -> destinations`, `.ride_type_id -> ride_types`) and RLS
 * on the joined tables already allows a signed-in Sadran to read them (the
 * same tables `v_board_rides`/`fetchProfilesByIds`/`fetchRideTypes` already
 * join/select). `requests` has two FKs to `profiles` (`requester_id`,
 * `filed_by`), so the embed must name the constraint explicitly
 * (`!requests_requester_id_fkey`) — same convention as
 * `features/requests/api.ts`'s `EDIT_SELECT`. Also embeds `request_children`
 * → `children.full_name` (child-display bugfix) so the unmet list can show
 * a child's actual name instead of always falling back to
 * `he.ridePublicDetails.unnamedChild`; RLS on `request_children` already
 * allows this for a Sadran/admin managing the week (`can_manage_week`), the
 * same condition this function is used under.
 */
export interface WeekRequestRow extends RequestRow {
  companions?: { profile_id: string; name: string }[];
  /** Named children (`request_children` → `children.full_name`), distinct from the guessed "unnamed child" fallback (`he.ridePublicDetails.unnamedChild`). */
  childNames?: string[];
  requester_full_name: string | null;
  destination_resolved_name: string | null;
  destination_travel_minutes: number | null;
  ride_type_code: string | null;
  ride_type_name_he: string | null;
  /** Quick-request-from-empty-slot (UX_FLOWS.md §18) — the car the member asked for, if any. */
  preferred_car_name: string | null;
}

const WEEK_REQUEST_SELECT = `*,
  requester:profiles!requests_requester_id_fkey(full_name),
  destination:destinations(name, travel_minutes),
  ride_type:ride_types(code, name_he),
  preferred_car:cars!requests_preferred_car_id_fkey(name),
  companions:request_companions(profile_id, profile:profiles!request_companions_profile_id_fkey(full_name)),
  request_children(child:children(full_name))`;

interface WeekRequestJoinRow extends RequestRow {
  companions: { profile_id: string; profile: { full_name: string } | null }[];
  request_children: { child: { full_name: string } | null }[];
  requester: { full_name: string } | null;
  destination: { name: string; travel_minutes: number | null } | null;
  ride_type: { code: string; name_he: string } | null;
  preferred_car: { name: string } | null;
}

function flattenWeekRequest(row: WeekRequestJoinRow): WeekRequestRow {
  const { requester, destination, ride_type, preferred_car, companions, request_children, ...rest } = row;
  return {
    ...rest,
    requester_full_name: requester?.full_name ?? null,
    companions: (companions ?? []).flatMap((person) => person.profile ? [{ profile_id: person.profile_id, name: person.profile.full_name }] : []),
    childNames: (request_children ?? []).flatMap((entry) => entry.child?.full_name ? [entry.child.full_name] : []),
    destination_resolved_name: destination?.name ?? rest.destination_text ?? null,
    destination_travel_minutes: destination?.travel_minutes ?? null,
    ride_type_code: ride_type?.code ?? null,
    ride_type_name_he: ride_type?.name_he ?? null,
    preferred_car_name: preferred_car?.name ?? null,
  } as WeekRequestRow;
}

// ---------------------------------------------------------------------------
// Week / phase overrides
// ---------------------------------------------------------------------------

export async function fetchWeekRow(departmentId: string, weekStart: string): Promise<WeekRow | null> {
  await ensureDepartmentWeeks(departmentId);
  const { data, error } = await supabase
    .from("weeks")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data;
}

// ---------------------------------------------------------------------------
// Requests / board reads (rides come from `v_board_rides`, RLS already scopes
// drafts to the Sadran/driver only — supabase/migrations/20260907091400_rls.sql
// `rides_select` — so this is safe to reuse from a signed-in Sadran session)
// ---------------------------------------------------------------------------

export async function fetchWeekRequests(departmentId: string, weekStart: string): Promise<RequestRow[]> {
  const { data, error } = await supabase
    .from("requests")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (error) throw toAppError(error);
  return data ?? [];
}

/**
 * Same rows as `fetchWeekRequests`, plus the requester/destination/ride-type
 * names the board's `UnmetList` and the dashboard's counters need (bug #1) —
 * a separate function (rather than changing `fetchWeekRequests` itself)
 * because `solverRun.ts#gatherSolverContext` only needs the plain columns
 * `buildSolverInput` maps and re-fetching with joins there would be wasted
 * work on every solve.
 */
export async function fetchWeekRequestsWithNames(
  departmentId: string,
  weekStart: string,
): Promise<WeekRequestRow[]> {
  const { data, error } = await supabase
    .from("requests")
    .select(WEEK_REQUEST_SELECT)
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as WeekRequestJoinRow[]).map(flattenWeekRequest);
}

// ---------------------------------------------------------------------------
// Department settings / maintenance blocks / policy (for `buildSolverInput`)
// ---------------------------------------------------------------------------

export async function fetchDepartmentSettings(departmentId: string): Promise<DepartmentSettingsRow> {
  const { data, error } = await supabase
    .from("department_settings")
    .select("*")
    .eq("department_id", departmentId)
    .single();
  if (error) throw toAppError(error);
  return data;
}

export async function fetchMaintenanceBlocksForDepartment(departmentId: string): Promise<MaintenanceBlockRow[]> {
  const { data, error } = await supabase
    .from("car_maintenance_blocks")
    .select("*")
    .eq("department_id", departmentId);
  if (error) throw toAppError(error);
  return data ?? [];
}

export interface ActivePolicy {
  policyId: string;
  name: string;
  policyVersionId: string;
  versionNo: number;
  rules: unknown;
}

interface ActivePolicyJoinRow {
  id: string;
  name: string;
  current_version_id: string | null;
  current_version: PolicyVersionRow | PolicyVersionRow[] | null;
}

/**
 * The selected department's active policy. One request via a PostgREST FK
 * embed (`policies.current_version_id -> policy_versions.id`, constraint
 * `policies_current_version_fk`) instead of the policy row then its version
 * as two sequential round trips (docs/HARDENING_2026-09.md §3 item 3).
 */
export async function fetchActivePolicy(departmentId: string): Promise<ActivePolicy | null> {
  const { data, error } = await supabase
    .from("policies")
    .select("id, name, current_version_id, current_version:policy_versions!policies_current_version_fk(*)")
    .eq("department_id", departmentId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw toAppError(error);

  const policyRow = data as unknown as ActivePolicyJoinRow | null;
  const version = Array.isArray(policyRow?.current_version) ? policyRow?.current_version[0] : policyRow?.current_version;
  if (!policyRow?.current_version_id || !version) return null;

  return {
    policyId: policyRow.id,
    name: policyRow.name,
    policyVersionId: version.id,
    versionNo: version.version_no,
    rules: version.rules,
  };
}

export interface PolicyOption {
  policyId: string;
  name: string;
  policyVersionId: string;
  versionNo: number;
  rules: unknown;
  isActive: boolean;
  /** `policy_versions.note` (board policy-versions dialog, UX_FLOWS.md §4.2) — free text, may be empty. */
  note: string | null;
  /** `policy_versions.created_at`, Asia/Jerusalem-formatted by the caller (`src/lib/time.ts`). */
  createdAt: string;
}

/** Policies belonging to this department for the board switcher. */
export async function fetchPolicyOptions(departmentId: string): Promise<PolicyOption[]> {
  const { data: policies, error } = await supabase
    .from("policies")
    .select("id, name, current_version_id, is_active, department_id")
    .eq("department_id", departmentId);
  if (error) throw toAppError(error);

  const versionIds = (policies ?? []).map((p) => p.current_version_id).filter((id): id is string => !!id);
  if (versionIds.length === 0) return [];
  const { data: versions, error: versionsError } = await supabase
    .from("policy_versions")
    .select("*")
    .in("id", versionIds);
  if (versionsError) throw toAppError(versionsError);
  const versionById = new Map((versions ?? []).map((v) => [v.id, v]));

  return (policies ?? [])
    .filter((p) => p.current_version_id && versionById.has(p.current_version_id))
    .map((p) => {
      const version = versionById.get(p.current_version_id as string)!;
      return {
        policyId: p.id,
        name: p.name,
        policyVersionId: version.id,
        versionNo: version.version_no,
        rules: version.rules,
        isActive: p.is_active,
        note: version.note,
        createdAt: version.created_at,
      };
    });
}

export async function fetchFairnessStats(
  departmentId: string,
  weekStart: string,
  lookbackWeeks: number,
): Promise<Database["public"]["Functions"]["fairness_stats"]["Returns"]> {
  const { data, error } = await supabase.rpc("fairness_stats", {
    p_department_id: departmentId,
    p_week_start: weekStart,
    p_lookback_weeks: lookbackWeeks,
  });
  if (error) throw toAppError(error);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Solver runs (Run solver / record preview / apply draft)
// ---------------------------------------------------------------------------

export async function fetchLatestSolverRun(departmentId: string, weekStart: string): Promise<SolverRunRow | null> {
  const { data, error } = await supabase
    .from("solver_runs")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data;
}

export async function recordSolverPreview(departmentId: string, weekStart: string, payload: Json): Promise<string> {
  return rpc("record_solver_preview", { p_department_id: departmentId, p_week_start: weekStart, p_payload: payload });
}

/**
 * `apply_solver_result`'s return shape changed from a bare run-id uuid to a
 * structured summary jsonb (bug-fix pass, `supabase/migrations/
 * 20260907093300_apply_solver_result_atomic_summary.sql`) so the caller can
 * show exactly what an apply did — never a silently partial result. See
 * `applySolve.ts`'s `ApplySolverResultSummary`.
 */
export interface ApplySolverResultResponse {
  run_id: string;
  inserted: number;
  deleted: number;
  unchanged: number;
  unassigned_requests: string[];
  /**
   * Multi-day requests ("series", REQ §13.77) this apply could not place on the car the
   * solver chose for the whole span — their legs return to `submitted`/`SERIES_CAR_
   * UNAVAILABLE`; the rest of the solve still applied (20260910093500_apply_solver_result_
   * series.sql).
   */
  skippedSeries?: { series_id: string; reason: string }[];
}

export async function applySolverResult(
  departmentId: string,
  weekStart: string,
  payload: Json,
): Promise<ApplySolverResultResponse> {
  const result = await rpc("apply_solver_result", {
    p_department_id: departmentId,
    p_week_start: weekStart,
    p_payload: payload,
  });
  return result as unknown as ApplySolverResultResponse;
}

// ---------------------------------------------------------------------------
// Single-ride edits (board drag/resize/reassign/pin/cancel, RideSheet)
// ---------------------------------------------------------------------------

export interface EditRideServedLeg {
  request_id: string;
  role: Database["public"]["Enums"]["ride_role"];
  leg?: Database["public"]["Enums"]["ride_leg"];
  car_mode: Database["public"]["Enums"]["leg_car_mode"];
  detour_minutes?: number;
}

export interface EditRideInput {
  id?: string;
  department_id: string;
  week_start: string;
  car_id: string;
  starts_at: string;
  ends_at: string;
  origin_id: string;
  destination_id: string;
  driver_id: string | null;
  needs_driver?: boolean;
  allow_conflict?: boolean;
  notes?: string | null;
  overflow_allowed?: boolean;
  overnight_ack?: boolean;
  is_pinned?: boolean;
  pin_reason?: string | null;
  served?: EditRideServedLeg[];
}

export async function editRide(input: EditRideInput, expectedVersion?: number): Promise<string> {
  return rpc("edit_ride", { p_ride: input as unknown as Json, p_expected_version: expectedVersion });
}

export async function cancelRide(rideId: string, reason: string, expectedVersion?: number): Promise<void> {
  await rpc("cancel_ride", { p_ride_id: rideId, p_reason: reason, p_expected_version: expectedVersion });
}

export async function unassignRide(rideId: string, expectedVersion: number): Promise<void> {
  await rpc("unassign_ride", { p_ride_id: rideId, p_expected_version: expectedVersion });
}

// ---------------------------------------------------------------------------
// Proposals (composer, list)
// ---------------------------------------------------------------------------

export async function fetchProposalsForWeek(departmentId: string, weekStart: string): Promise<ProposalRow[]> {
  const { data, error } = await supabase
    .from("proposals")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("created_at", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchProposalParties(proposalId: string): Promise<ProposalPartyRow[]> {
  const { data, error } = await supabase.from("proposal_parties").select("*").eq("proposal_id", proposalId);
  if (error) throw toAppError(error);
  return data ?? [];
}

export interface CreateProposalInput {
  requestId: string;
  rideId: string | null;
  type: Database["public"]["Enums"]["proposal_type"];
  payload: Json;
  reasonHe: string;
  partyProfileIds?: string[];
  createdVia?: string;
}

export async function createProposal(input: CreateProposalInput): Promise<string> {
  return rpc("create_proposal", {
    p_request_id: input.requestId,
    p_ride_id: input.rideId as unknown as string,
    p_type: input.type,
    p_payload: input.payload,
    p_reason_he: input.reasonHe,
    p_party_profile_ids: input.partyProfileIds ?? [],
    p_created_via: input.createdVia ?? "sadran",
  });
}

export interface SendProposalResult {
  proposal_token: string;
  party_tokens: Record<string, string>;
}

export async function sendProposal(
  proposalId: string,
  sentVia: Database["public"]["Enums"]["notification_channel"][] = [],
  replacement?: { id: string; version: number },
): Promise<SendProposalResult> {
  const result = await rpc("send_proposal", {
    p_proposal_id: proposalId, p_sent_via: sentVia,
    p_replace_proposal_id: replacement?.id,
    p_replace_expected_version: replacement?.version,
  });
  return result as unknown as SendProposalResult;
}

export async function recordAnswerOnBehalf(
  proposalId: string,
  profileId: string,
  accept: boolean,
  note?: string,
): Promise<void> {
  await rpc("record_answer_on_behalf", {
    p_proposal_id: proposalId,
    p_profile_id: profileId,
    p_accept: accept,
    p_note: note,
  });
}

export async function applyProposal(proposalId: string): Promise<string> {
  return rpc("apply_proposal", { p_proposal_id: proposalId });
}

/** The 5 seeded `wa.*` variants (UX_FLOWS.md §6.2) — `external`/`chauffeur` are documented but not seeded (stage 2b report). */
export async function fetchWhatsappTemplates(): Promise<NotificationTemplateRow[]> {
  const { data, error } = await supabase
    .from("notification_templates")
    .select("*")
    .eq("event", "proposal_received")
    .eq("channel", "whatsapp");
  if (error) throw toAppError(error);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Contested freed slots
// ---------------------------------------------------------------------------

export async function fetchFreedOffersForWeek(departmentId: string, weekStart: string): Promise<FreedSlotOfferRow[]> {
  const { data, error } = await supabase
    .from("freed_slot_offers")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("created_at", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchClaimsForOffer(offerId: string): Promise<FreedSlotClaimRow[]> {
  const { data, error } = await supabase.from("freed_slot_claims").select("*").eq("offer_id", offerId);
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function approveClaim(offerId: string, requestId: string): Promise<string> {
  return rpc("approve_claim", { p_offer_id: offerId, p_request_id: requestId });
}

export async function closeOffer(offerId: string): Promise<void> {
  await rpc("close_offer", { p_offer_id: offerId });
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export async function fetchSiddurVersions(departmentId: string, weekStart: string): Promise<SiddurVersionRow[]> {
  const { data, error } = await supabase
    .from("siddur_versions")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("version_no", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchLatestSiddurVersion(departmentId: string, weekStart: string): Promise<SiddurVersionRow | null> {
  const versions = await fetchSiddurVersions(departmentId, weekStart);
  return versions[0] ?? null;
}

export async function fetchPublishFingerprint(departmentId: string, weekStart: string): Promise<string> {
  return rpc("publish_scores_fingerprint", { p_department_id: departmentId, p_week_start: weekStart });
}

export interface PublicationDay {
  day: string;
  published: boolean;
  requestCount: number;
  /**
   * "Nobody placed this request" plus "an assigned request's legs are not
   * all covered" combined — kept for backward-compatible display; no longer
   * a blocker (REQ §13.75, DATA_MODEL.md §7.4a "`publication_readiness()`
   * gained a key"). `incompleteAssignments` below is the actual defect
   * (`ready`/publication blocks on it instead).
   */
  unresolvedRequests: number;
  /** The real defect split out of `unresolvedRequests`: an assigned/merged request whose legs are not all covered. `ready` keys off this, not `unresolvedRequests`. */
  incompleteAssignments: number;
  pendingProposals: number;
  missingDriverRides: number;
  conflictRides: number;
  ready: boolean;
}
export interface PublicationOptions { days?: string[]; allowUnanswered?: boolean }

export async function fetchPublicationReadiness(departmentId: string, weekStart: string): Promise<PublicationDay[]> {
  return await rpc("publication_readiness", { p_department_id: departmentId, p_week_start: weekStart }) as unknown as PublicationDay[];
}

export async function reopenWeek(departmentId: string, weekStart: string, phase: "open" | "solving", expectedFingerprint: string): Promise<void> {
  await rpc("reopen_week", { p_department_id: departmentId, p_week_start: weekStart, p_phase: phase, p_expected_fingerprint: expectedFingerprint });
}

export async function publishSiddur(departmentId: string, weekStart: string, scores: Json, fingerprint: string, policyScores: Json, options: PublicationOptions = {}): Promise<string> {
  return rpc("publish_siddur", { p_department_id: departmentId, p_week_start: weekStart,
    p_profile_scores: scores, p_expected_fingerprint: fingerprint, p_policy_scores: policyScores,
    p_days: options.days, p_allow_unanswered: options.allowUnanswered ?? false });
}

/** All non-cancelled rides of the week, for the publish diff and blocking-conflicts checks (same RLS as the board). */
export async function fetchAllWeekRides(departmentId: string, weekStart: string): Promise<BoardRide[]> {
  const { data, error } = await supabase
    .from("v_board_rides")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (error) throw toAppError(error);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profiles (recipient names/phones for the proposal composer)
// ---------------------------------------------------------------------------

export interface ProfileContact {
  id: string;
  full_name: string;
  phone: string | null;
}

export async function fetchProfilesByIds(profileIds: string[]): Promise<ProfileContact[]> {
  if (profileIds.length === 0) return [];
  const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", profileIds);
  if (error) throw toAppError(error);
  const rows = data ?? [];
  const phones = await rpc("profile_phones", { p_ids: profileIds });
  const phoneById = new Map((phones ?? []).map((row) => [row.id, row.phone]));
  return rows.map((row) => ({ ...row, phone: phoneById.get(row.id) ?? null }));
}

export async function fetchAuditLog(departmentId: string, weekStart: string): Promise<AuditLogRow[]> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("at", { ascending: false })
    .limit(300);
  if (error) throw toAppError(error);
  return data ?? [];
}
