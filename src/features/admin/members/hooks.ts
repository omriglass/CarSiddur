import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  updateMemberDetails,
  addMemberToDepartment,
  approveMember,
  fetchAllDepartmentMembers,
  fetchAllProfiles,
  fetchMemberInvites,
  fetchPhones,
  grantAdmin,
  importAllowList,
  rejectMember,
  removeMemberFromDepartment,
  revokeAdmin,
  setMemberRole,
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

export function useAddMemberToDepartmentMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ departmentId, profileId, role }: { departmentId: string; profileId: string; role?: Role }) =>
      addMemberToDepartment(departmentId, profileId, role),
    onSuccess: invalidate,
  });
}

export function useRemoveMemberFromDepartmentMutation() {
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ departmentId, profileId }: { departmentId: string; profileId: string }) =>
      removeMemberFromDepartment(departmentId, profileId),
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
    mutationFn: ({ profileId, fullName, phone, departmentId, displayName, removedDepartmentIds }: { profileId: string; fullName: string; phone: string; departmentId?: string; displayName?: string; removedDepartmentIds?: string[] }) =>
      updateMemberDetails(profileId, fullName, phone, departmentId, displayName, removedDepartmentIds),
    onSuccess: invalidate,
  });
}
