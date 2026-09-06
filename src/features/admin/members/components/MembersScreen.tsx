import { useMemo, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useDepartments } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { Users } from "lucide-react";

import { parseInviteLines, type ParsedInviteRow } from "../lib/parseInviteLines";
import {
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
} from "../hooks";
import type { Profile } from "../api";

const ROLE_LABEL: Record<"member" | "sadran" | "admin", string> = {
  member: he.adminMembers.roleMember,
  sadran: he.adminMembers.roleSadran,
  admin: he.adminMembers.roleAdmin,
};

function MembersTab() {
  const profilesQuery = useAllProfiles();
  const deptMembersQuery = useAllDepartmentMembers();
  const departmentsQuery = useDepartments();
  const grantAdminMutation = useGrantAdminMutation();
  const revokeAdminMutation = useRevokeAdminMutation();
  const setRoleMutation = useSetMemberRoleMutation();

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
              <TableCell>{profile.full_name}</TableCell>
              <TableCell dir="ltr">{profile.email}</TableCell>
              <TableCell dir="ltr">{phonesQuery.data?.[profile.id] ?? "—"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {memberships.map((m) => (
                    <Select
                      key={m.departmentId}
                      value={m.role}
                      onValueChange={(role) =>
                        setRoleMutation.mutate({
                          departmentId: m.departmentId,
                          profileId: profile.id,
                          role: role as "member" | "sadran" | "admin",
                        })
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
                <Button size="sm" variant={profile.is_admin ? "default" : "outline"} onClick={() => toggleAdmin(profile)}>
                  {profile.is_admin ? he.adminMembers.revokeAdmin : he.adminMembers.grantAdmin}
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
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
      </Tabs>
    </div>
  );
}
