import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  updateMemberDetails,
  approveMember,
  fetchAllDepartmentMembers,
  fetchAllProfiles,
  fetchMemberInvites,
  fetchManagedChildren,
  createChild,
  updateChild,
  fetchPhones,
  grantAdmin,
  importAllowList,
  rejectMember,
  revokeAdmin,
  setMemberRole,
  updateMemberDefaultOrigin,
  type ImportRow,
  type Role,
} from "./api";
import { memberAdminKeys } from "./queryKeys";

export function useAllProfiles() {
  return useQuery({ queryKey: memberAdminKeys.profiles(), queryFn: fetchAllProfiles, staleTime: 30_000 });
}

export function useAllDepartmentMembers() {
  return useQuery({
    queryKey: memberAdminKeys.departmentMembers(),
    queryFn: fetchAllDepartmentMembers,
    staleTime: 30_000,
  });
}

export function useMemberInvites() {
  return useQuery({ queryKey: memberAdminKeys.invites(), queryFn: fetchMemberInvites, staleTime: 30_000 });
}

export function useManagedChildren() {
  return useQuery({ queryKey: [...memberAdminKeys.all, "children"], queryFn: fetchManagedChildren, staleTime: 30_000 });
}

export function useCreateChildMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: ({ departmentId, fullName, birthYear, guardianIds }: { departmentId: string; fullName: string; birthYear: number | null; guardianIds: string[] }) => createChild(departmentId, fullName, birthYear, guardianIds), onSuccess: invalidate });
}

export function useUpdateChildMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: ({ childId, departmentId, fullName, birthYear, guardianIds }: { childId: string; departmentId: string; fullName: string; birthYear: number | null; guardianIds: string[] }) => updateChild(childId, departmentId, fullName, birthYear, guardianIds), onSuccess: invalidate });
}

export function usePhones(profileIds: string[]) {
  return useQuery({
    queryKey: memberAdminKeys.phones(profileIds),
    queryFn: () => fetchPhones(profileIds),
    enabled: profileIds.length > 0,
    staleTime: 60_000,
  });
}

function useInvalidateMembers() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: memberAdminKeys.all });
    // Deliberately unscoped: a member's name, role or department membership shows on nearly
    // every screen (board, siddur, requests, auth guards). Admin actions are rare and only
    // mounted queries refetch, so a full refresh beats listing every dependent key.
    void queryClient.invalidateQueries();
  };
}

export function useApproveMemberMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ profileId, departmentId }: { profileId: string; departmentId: string }) =>
      approveMember(profileId, departmentId),
    onSuccess: invalidate,
  });
}

export function useRejectMemberMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: (profileId: string) => rejectMember(profileId), onSuccess: invalidate });
}

export function useGrantAdminMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: (profileId: string) => grantAdmin(profileId), onSuccess: invalidate });
}

export function useRevokeAdminMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: (profileId: string) => revokeAdmin(profileId), onSuccess: invalidate });
}

export function useSetMemberRoleMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ departmentId, profileId, role }: { departmentId: string; profileId: string; role: Role }) =>
      setMemberRole(departmentId, profileId, role),
    onSuccess: invalidate,
  });
}

export function useUpdateMemberDefaultOriginMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ departmentId, profileId, originId }: { departmentId: string; profileId: string; originId: string | null }) =>
      updateMemberDefaultOrigin(departmentId, profileId, originId),
    onSuccess: invalidate,
  });
}

export function useImportAllowListMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ rows, departmentId }: { rows: ImportRow[]; departmentId: string }) =>
      importAllowList(rows, departmentId),
    onSuccess: invalidate,
  });
}

export function useUpdateMemberDetailsMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ profileId, fullName, phone, departmentId, displayName, removedDepartmentIds, doesNotDrive }: { profileId: string; fullName: string; phone: string; departmentId?: string; displayName?: string; removedDepartmentIds?: string[]; doesNotDrive?: boolean }) =>
      updateMemberDetails(profileId, fullName, phone, departmentId, displayName, removedDepartmentIds, doesNotDrive),
    onSuccess: invalidate,
  });
}
