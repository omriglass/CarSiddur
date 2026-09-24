import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useActiveDepartment } from "./useActiveDepartment";

const state = vi.hoisted(() => ({
  session: undefined as { user: { id: string } } | undefined,
  profile: { data: undefined as { default_department_id?: string } | undefined, isLoading: false },
  memberships: { data: undefined as { department_id: string }[] | undefined, isLoading: false },
  departments: [] as { id: string; is_active: boolean }[],
}));

vi.mock("./useSession", () => ({ useSession: () => ({ session: state.session }) }));
vi.mock("./useProfile", () => ({ useProfile: () => state.profile }));
vi.mock("./useMyDepartments", () => ({ useMyDepartments: () => state.memberships }));
vi.mock("@/features/siddur/api", () => ({ fetchDepartments: () => Promise.resolve(state.departments) }));

function department(id: string) {
  return { id, is_active: true };
}

function renderActive(path = "/my", userId = "user") {
  state.session = { user: { id: userId } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useActiveDepartment(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

afterEach(() => {
  localStorage.clear();
  state.profile = { data: undefined, isLoading: false };
  state.memberships = { data: undefined, isLoading: false };
  state.departments = [];
});

describe("useActiveDepartment fallback chain", () => {
  it("prefers the route param over every other source", async () => {
    const [a, b, c] = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];
    state.departments = [department(a), department(b), department(c)];
    state.profile.data = { default_department_id: b };
    state.memberships.data = [{ department_id: c }];
    const { result } = renderActive(`/siddur/${a}`, "route-user");
    await waitFor(() => expect(result.current.departmentId).toBe(a));
  });

  it("falls back to the per-user localStorage selection when there is no route param", async () => {
    const [a, b] = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    state.departments = [department(a), department(b)];
    state.profile.data = { default_department_id: a };
    localStorage.setItem("carshare:department:stored-user", b);
    const { result } = renderActive("/my", "stored-user");
    await waitFor(() => expect(result.current.departmentId).toBe(b));
  });

  it("skips a stale/invalid stored department id and falls through to the profile default", async () => {
    const [a, b] = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    state.departments = [department(a), department(b)];
    state.profile.data = { default_department_id: a };
    localStorage.setItem("carshare:department:stale-user", "does-not-exist");
    const { result } = renderActive("/my", "stale-user");
    await waitFor(() => expect(result.current.departmentId).toBe(a));
  });

  it("falls back to the first membership when there is no route, storage or profile default", async () => {
    const [a, b] = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    state.departments = [department(a), department(b)];
    state.memberships.data = [{ department_id: b }];
    const { result } = renderActive("/my", "membership-user");
    await waitFor(() => expect(result.current.departmentId).toBe(b));
  });

  it("falls back to the first known department as a last resort", async () => {
    const [a, b] = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    state.departments = [department(a), department(b)];
    const { result } = renderActive("/my", "no-signal-user");
    await waitFor(() => expect(result.current.departmentId).toBe(a));
  });

  it("ignores an unknown id passed to setDepartmentId", async () => {
    const a = "11111111-1111-1111-1111-111111111111";
    state.departments = [department(a)];
    const { result } = renderActive("/my", "guard-user");
    await waitFor(() => expect(result.current.departmentId).toBe(a));
    act(() => result.current.setDepartmentId("not-a-real-department"));
    expect(localStorage.getItem("carshare:department:guard-user")).toBeNull();
    expect(result.current.departmentId).toBe(a);
  });

  it("keeps selections isolated per user key", async () => {
    const [a, b] = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    state.departments = [department(a), department(b)];
    const first = renderActive("/my", "user-a");
    await waitFor(() => expect(first.result.current.departmentId).toBe(a));
    act(() => first.result.current.setDepartmentId(b));
    expect(localStorage.getItem("carshare:department:user-a")).toBe(b);
    first.unmount();

    const second = renderActive("/my", "user-b");
    await waitFor(() => expect(second.result.current.departmentId).toBe(a));
    expect(localStorage.getItem("carshare:department:user-b")).toBeNull();
  });
});
