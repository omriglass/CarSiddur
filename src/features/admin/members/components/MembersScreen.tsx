import { useMemo, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useDepartments } from "@/features/siddur/hooks";
import { useSession } from "@/features/auth/useSession";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { Users } from "lucide-react";
import { CompanionPicker } from "@/components/CompanionPicker";

import { parseInviteLines, type ParsedInviteRow } from "../lib/parseInviteLines";
import {
  useUpdateMemberDetailsMutation,
  useAllDepartmentMembers,
  useAllProfiles,
  useApproveMemberMutation,
  useGrantAdminMutation,
  useImportAllowListMutation,
  useMemberInvites,
  usePhones,
  useRejectMemberMutation,
  useRevokeAdminMutation,
  useSetMemberRoleMutation,
  useManagedChildren,
  useCreateChildMutation,
} from "../hooks";
import type { Profile } from "../api";

const ROLE_LABEL: Record<"member" | "sadran" | "admin", string> = {
  member: he.adminMembers.roleMember,
  sadran: he.adminMembers.roleSadran,
  admin: he.adminMembers.roleAdmin,
};

function MembersTab() {
  const { session } = useSession();
  const profilesQuery = useAllProfiles();
  const deptMembersQuery = useAllDepartmentMembers();
  const departmentsQuery = useDepartments();
  const grantAdminMutation = useGrantAdminMutation();
  const revokeAdminMutation = useRevokeAdminMutation();
  const setRoleMutation = useSetMemberRoleMutation();
  const updateDetailsMutation = useUpdateMemberDetailsMutation();
  const [editing, setEditing] = useState<{ profileId: string; fullName: string; displayName: string; removedDepartmentIds: string[]; phone: string; departmentId?: string } | null>(null);

  const approvedProfiles = (profilesQuery.data ?? []).filter((p) => p.approval_status !== "pending");
  const profileIds = approvedProfiles.map((p) => p.id);
  const phonesQuery = usePhones(profileIds);

  const departmentsById = useMemo(
    () => new Map((departmentsQuery.data ?? []).map((d) => [d.id, d.name])),
    [departmentsQuery.data],
  );
  const membershipsByProfile = useMemo(() => {
    const map = new Map<string, { departmentId: string; role: "member" | "sadran" | "admin" }[]>();
    for (const dm of deptMembersQuery.data ?? []) {
      const list = map.get(dm.profile_id) ?? [];
      list.push({ departmentId: dm.department_id, role: dm.role });
      map.set(dm.profile_id, list);
    }
    return map;
  }, [deptMembersQuery.data]);

  async function toggleAdmin(profile: Profile) {
    try {
      if (profile.is_admin) {
        await revokeAdminMutation.mutateAsync(profile.id);
      } else {
        await grantAdminMutation.mutateAsync(profile.id);
      }
      toast.success(he.adminCommon.savedToast);
    } catch (error) {
      showErrorToast(error);
    }
  }

  if (approvedProfiles.length === 0) {
    return <EmptyState icon={Users} message={he.adminMembers.empty} />;
  }

  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{he.adminMembers.columnName}</TableHead>
          <TableHead>{he.adminMembers.columnEmail}</TableHead>
          <TableHead>{he.adminMembers.columnPhone}</TableHead>
          <TableHead>{he.adminMembers.columnDepartments}</TableHead>
          <TableHead>{he.adminMembers.columnAdmin}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {approvedProfiles.map((profile) => {
          const memberships = membershipsByProfile.get(profile.id) ?? [];
          return (
            <TableRow key={profile.id}>
              <TableCell>
                <Button variant="link" className="h-auto p-0" onClick={() => setEditing({
                  profileId: profile.id, fullName: profile.google_name, displayName: profile.display_name ?? "", removedDepartmentIds: [], phone: phonesQuery.data?.[profile.id] ?? "",
                })} disabled={phonesQuery.isPending || phonesQuery.isError}>{profile.full_name}</Button>
              </TableCell>
              <TableCell dir="ltr">{profile.email}</TableCell>
              <TableCell dir="ltr">{phonesQuery.data?.[profile.id] ?? "—"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {memberships.map((m) => (
                    <Select
                      key={m.departmentId}
                      value={m.role}
                      disabled={setRoleMutation.isPending}
                      onValueChange={(role) =>
                        setRoleMutation.mutate({
                          departmentId: m.departmentId,
                          profileId: profile.id,
                          role: role as "member" | "sadran" | "admin",
                        }, { onSuccess: () => toast.success(he.adminCommon.savedToast), onError: showErrorToast })
                      }
                    >
                      <SelectTrigger className="h-7 w-auto gap-1 px-2 text-xs">
                        <Badge variant="outline" className="me-1">
                          {departmentsById.get(m.departmentId) ?? m.departmentId}
                        </Badge>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">{ROLE_LABEL.member}</SelectItem>
                        <SelectItem value="sadran">{ROLE_LABEL.sadran}</SelectItem>
                      </SelectContent>
                    </Select>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <Button size="sm" variant={profile.is_admin ? "default" : "outline"} onClick={() => toggleAdmin(profile)}
                  disabled={revokeAdminMutation.isPending || (profile.is_admin && profile.id === session?.user.id && (profilesQuery.data ?? []).filter((candidate) => candidate.is_admin && candidate.approval_status === "approved").length === 1)}>
                  {profile.is_admin ? he.adminMembers.revokeAdmin : he.adminMembers.grantAdmin}
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
      <DialogContent>
        <DialogHeader><DialogTitle>{he.adminMembers.editDetails}</DialogTitle></DialogHeader>
        <label className="grid gap-2">{he.adminMembers.googleName}
          <Input value={editing?.fullName ?? ""} readOnly />
        </label>
        <label className="grid gap-2">{he.adminMembers.displayName}
          <Input aria-describedby="member-display-name-help" value={editing?.displayName ?? ""} placeholder={editing?.fullName} onChange={(e) => setEditing((old) => old && ({ ...old, displayName: e.target.value }))} />
        </label>
        <p id="member-display-name-help" className="text-sm text-muted-foreground">{he.adminMembers.displayNameHelp}</p>
        <label className="grid gap-2">{he.adminMembers.columnPhone}
          <Input type="tel" dir="ltr" value={editing?.phone ?? ""} onChange={(e) => setEditing((old) => old && ({ ...old, phone: e.target.value }))} />
        </label>
        <div className="grid gap-2">
          <span>{he.adminMembers.columnDepartments}</span>
          {(membershipsByProfile.get(editing?.profileId ?? "") ?? []).map((membership) => {
            const removing = editing?.removedDepartmentIds.includes(membership.departmentId);
            return <div key={membership.departmentId} className="flex items-center justify-between gap-2">
              <span className={removing ? "line-through text-muted-foreground" : ""}>{departmentsById.get(membership.departmentId)}</span>
              <Button variant="outline" size="sm" onClick={() => setEditing((old) => old && ({ ...old,
                removedDepartmentIds: removing ? old.removedDepartmentIds.filter((id) => id !== membership.departmentId)
                  : [...old.removedDepartmentIds, membership.departmentId],
              }))}>{removing ? he.adminMembers.undoRemoval : he.adminMembers.removeDepartment}</Button>
            </div>;
          })}
          <p className="text-sm text-muted-foreground">{he.adminMembers.removalHelp}</p>
          <label htmlFor="member-add-department">{he.adminMembers.addDepartment}</label>
          <Select value={editing?.departmentId ?? "none"} onValueChange={(value) => setEditing((old) => old && ({ ...old, departmentId: value === "none" ? undefined : value }))}>
            <SelectTrigger id="member-add-department"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{he.adminMembers.keepDepartments}</SelectItem>
              {(departmentsQuery.data ?? []).filter((department) => department.is_active &&
                !(membershipsByProfile.get(editing?.profileId ?? "") ?? []).some((membership) => membership.departmentId === department.id))
                .map((department) => <SelectItem key={department.id} value={department.id}>{department.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">{he.adminMembers.departmentMembershipHelp}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>{he.adminCommon.cancel}</Button>
          <Button disabled={!editing || updateDetailsMutation.isPending} onClick={async () => {
            if (!editing) return;
            try {
              await updateDetailsMutation.mutateAsync(editing);
              toast.success(he.adminCommon.savedToast);
              setEditing(null);
            } catch (error) { showErrorToast(error); }
          }}>{he.adminCommon.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function ChildrenTab() {
  const profilesQuery = useAllProfiles();
  const departmentsQuery = useDepartments();
  const childrenQuery = useManagedChildren();
  const createMutation = useCreateChildMutation();
  const [departmentId, setDepartmentId] = useState("");
  const [fullName, setFullName] = useState("");
  const [guardianIds, setGuardianIds] = useState<string[]>([]);
  const profiles = (profilesQuery.data ?? []).filter((profile) => profile.approval_status === "approved");
  const profileNames = new Map(profiles.map((profile) => [profile.id, profile.full_name]));

  return <div className="space-y-5">
    <div className="grid gap-3 rounded-md border p-4">
      <label className="grid gap-2">מחלקה
        <Select value={departmentId} onValueChange={setDepartmentId}><SelectTrigger><SelectValue placeholder="בחרו מחלקה" /></SelectTrigger><SelectContent>{(departmentsQuery.data ?? []).filter((d) => d.is_active).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent></Select>
      </label>
      <label className="grid gap-2">שם הילד/ה <Input value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
      <div className="grid gap-2"><span>משויך/ת ל</span><CompanionPicker members={profiles.map((p) => ({ id: p.id, name: p.full_name }))} value={guardianIds} onChange={setGuardianIds} label="הוספת הורים" /></div>
      <Button disabled={!departmentId || !fullName.trim() || createMutation.isPending} onClick={async () => { try { await createMutation.mutateAsync({ departmentId, fullName, guardianIds }); setFullName(""); setGuardianIds([]); toast.success(he.adminCommon.savedToast); } catch (error) { showErrorToast(error); } }}>הוספת ילד/ה</Button>
    </div>
    <div className="space-y-2">{(childrenQuery.data ?? []).map((child) => <div key={child.id} className="rounded-md border p-3"><div className="font-medium">{child.full_name}</div><div className="text-sm text-muted-foreground">{child.guardian_ids.map((id) => profileNames.get(id)).filter(Boolean).join(" · ") || "ללא שיוך"}</div></div>)}</div>
  </div>;
}

function PendingTab() {
  const profilesQuery = useAllProfiles();
  const departmentsQuery = useDepartments();
  const approveMutation = useApproveMemberMutation();
  const rejectMutation = useRejectMemberMutation();
  const [selectedDept, setSelectedDept] = useState<Record<string, string>>({});

  const pending = (profilesQuery.data ?? []).filter((p) => p.approval_status === "pending");

  if (pending.length === 0) {
    return <EmptyState icon={Users} message={he.adminMembers.emptyPending} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {pending.map((profile) => (
        <div key={profile.id} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-medium">{profile.full_name}</div>
            <div className="text-sm text-muted-foreground" dir="ltr">
              {profile.email}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={selectedDept[profile.id] ?? ""}
              onValueChange={(v) => setSelectedDept((s) => ({ ...s, [profile.id]: v }))}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder={he.adminDepartments.fieldName} />
              </SelectTrigger>
              <SelectContent>
                {(departmentsQuery.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!selectedDept[profile.id]}
              onClick={async () => {
                try {
                  await approveMutation.mutateAsync({ profileId: profile.id, departmentId: selectedDept[profile.id]! });
                  toast.success(he.adminCommon.savedToast);
                } catch (error) {
                  showErrorToast(error);
                }
              }}
            >
              {he.action.approve}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await rejectMutation.mutateAsync(profile.id);
                  toast.success(he.adminCommon.savedToast);
                } catch (error) {
                  showErrorToast(error);
                }
              }}
            >
              {he.action.reject}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ImportTab() {
  const profilesQuery = useAllProfiles();
  const invitesQuery = useMemberInvites();
  const departmentsQuery = useDepartments();
  const importMutation = useImportAllowListMutation();

  const [text, setText] = useState("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [preview, setPreview] = useState<ParsedInviteRow[] | null>(null);

  const existingEmails = useMemo(() => {
    const set = new Set<string>();
    for (const p of profilesQuery.data ?? []) set.add(p.email.toLowerCase());
    for (const i of invitesQuery.data ?? []) set.add(i.email.toLowerCase());
    return set;
  }, [profilesQuery.data, invitesQuery.data]);

  function handleParse() {
    setPreview(parseInviteLines(text, existingEmails));
  }

  const importableRows = (preview ?? []).filter((r) => r.status === "new" || r.status === "existing");

  async function handleImport() {
    if (!departmentId || importableRows.length === 0) return;
    try {
      const result = await importMutation.mutateAsync({
        rows: importableRows.map((r) => ({ name: r.name, email: r.email })),
        departmentId,
      });
      toast.success(
        tv("adminMembers.importSuccess", {
          count: String(result.insertedInvites + result.updatedInvites + result.updatedProfiles),
        }),
      );
      setText("");
      setPreview(null);
    } catch (error) {
      showErrorToast(error);
    }
  }

  const statusLabel: Record<ParsedInviteRow["status"], string> = {
    new: he.adminMembers.importRowNew,
    existing: he.adminMembers.importRowExisting,
    invalid_email: he.adminMembers.importRowInvalidEmail,
    duplicate: he.adminMembers.importRowDuplicate,
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{he.adminMembers.importInstructions}</p>
      <Textarea
        aria-label={he.adminMembers.importTextareaLabel}
        rows={8}
        dir="ltr"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"דנה כהן, dana@example.com\nרון לוי, ron@example.com"}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={departmentId} onValueChange={setDepartmentId}>
          <SelectTrigger className="w-48" aria-label={he.adminMembers.importDepartmentLabel}>
            <SelectValue placeholder={he.adminMembers.importDepartmentLabel} />
          </SelectTrigger>
          <SelectContent>
            {(departmentsQuery.data ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={handleParse} disabled={!text.trim()}>
          {he.adminMembers.importParse}
        </Button>
      </div>

      {preview ? (
        preview.length === 0 ? (
          <EmptyState icon={Users} message={he.adminMembers.importEmptyPreview} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{he.adminMembers.columnName}</TableHead>
                  <TableHead>{he.adminMembers.columnEmail}</TableHead>
                  <TableHead>{he.adminCommon.active}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((row, i) => (
                  <TableRow key={`${row.email}-${i}`}>
                    <TableCell>{row.name || "—"}</TableCell>
                    <TableCell dir="ltr">{row.email}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === "invalid_email" || row.status === "duplicate" ? "destructive" : "outline"}>
                        {statusLabel[row.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button onClick={handleImport} disabled={!departmentId || importableRows.length === 0}>
              {tv("adminMembers.importSubmit", { count: String(importableRows.length) })}
            </Button>
          </>
        )
      ) : null}
    </div>
  );
}

export function MembersScreen() {
  const profilesQuery = useAllProfiles();
  const pendingCount = (profilesQuery.data ?? []).filter((p) => p.approval_status === "pending").length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <PageHeader title={he.screen.admin.members} />
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">{he.adminMembers.tabMembers}</TabsTrigger>
          <TabsTrigger value="pending">
            {he.adminMembers.tabPending}
            {pendingCount > 0 ? ` (${pendingCount})` : ""}
          </TabsTrigger>
          <TabsTrigger value="import">{he.adminMembers.tabImport}</TabsTrigger>
          <TabsTrigger value="children">ילדים</TabsTrigger>
        </TabsList>
        <TabsContent value="members">
          <MembersTab />
        </TabsContent>
        <TabsContent value="pending">
          <PendingTab />
        </TabsContent>
        <TabsContent value="import">
          <ImportTab />
        </TabsContent>
        <TabsContent value="children"><ChildrenTab /></TabsContent>
      </Tabs>
    </div>
  );
}
