-- Function grants were default-open (docs/HARDENING_2026-09.md §1.1).
--
-- Supabase's default privileges grant EXECUTE on every new function in `public` to
-- anon, authenticated and service_role. Earlier migrations only revoked `from public,
-- anon` on a handful of RPCs, so internal and cron functions (try_auto_approve,
-- housekeeping, enqueue_notification, resolve_freed_offer, …) were callable by any
-- signed-in member through PostgREST `/rpc/<name>`.
--
-- 1. New functions start with NO grants: every migration that adds an RPC must
--    `grant execute … to authenticated` explicitly (DATA_MODEL §4.2, /add-migration).
-- 2. Every non-extension function in `public` is revoked from public and anon.
-- 3. Internal / cron / helper functions are revoked from authenticated. Guarded RPCs the app
--    does not call today (merge_destination, move_series, set_manual_boost, …) keep their
--    grant: they re-check authorization themselves. Helpers that
--    RLS policies, views, check constraints or index expressions reference keep their
--    grant because they execute as the querying role.
-- service_role is untouched (edge functions call answer_proposal / resolve_freed_offer /
-- push outbox helpers with it).

-- Both the schema-scoped and the global entry: per-schema defaults are *added* to the
-- global ones, so a global grant would still leak through.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges revoke execute on functions from public, anon, authenticated;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;

-- Internal-only: never called by the browser. Callable from pg_cron (app.tick), from
-- other SECURITY DEFINER functions (owner context) and by service_role.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and p.proname in (
        -- cron steps and their helpers
        'advance_week_phases', 'send_due_reminders', 'expire_proposals', 'expire_freed_offers',
        'drain_push_outbox', 'dispatch_push_outbox_row', 'housekeeping', 'materialize_templates',
        'materialize_department_weeks',
        -- notification plumbing
        'enqueue_notification', 'notification_context', 'notification_default_url',
        'notify_waitlist_contested', 'car_care_recipients',
        -- placement internals reached only through submit_request / publish_siddur / edge functions
        'try_auto_approve', 'try_auto_approve_series', 'resolve_freed_offer', 'freed_slot_candidates',
        'maybe_apply_accepted_proposal', 'create_waitlist_group',
        'settle_waitlist_cluster', 'join_waitlist_group', 'ensure_upcoming_week', 'place_series',
        'release_request_draft_rides', 'reserve_live_one_way_slot', 'refresh_car_turnarounds',
        'required_turnaround_minutes', 'compute_week_stats', 'merge_request_fingerprint',
        -- assertions and pure helpers used inside RPCs
        'assert_car_chain', 'assert_ride_seats_fit', 'assert_named_passenger_counts',
        'assert_publication_scores', 'assert_ride_driver', 'assert_ride_request_day',
        'assert_same_day_window', 'car_location_at', 'car_fits', 'week_state_fingerprint',
        'weekday_short_label', 'generate_token', 'raise_stale_version', 'week_range',
        'publication_conflicting_ride_ids', 'prepare_manual_ride_window',
        'prepare_manual_ride_window_before_planning', 'shares_ride_with',
        -- inner variants: the browser calls the outer wrapper, which re-checks authorization
        'cancel_ride_before_series', 'cancel_ride_change_before_planning',
        'cancel_ride_without_passengers', 'edit_ride_before_planning', 'edit_ride_before_series',
        'respond_ride_change_before_planning'
      )
  loop
    execute format('revoke execute on function %s from authenticated', f.sig);
  end loop;
end $$;

-- set_request_children was created without pg_temp in its search_path (hard rule 4).
alter function public.set_request_children(uuid, uuid[]) set search_path = public, pg_temp;
