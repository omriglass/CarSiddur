import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ParentOfCardView } from "@/features/member/components/ParentOfCard";
import { guardedChildLabel } from "@/features/member/guardedChildLabel";
import { isProfileTab } from "@/features/member/profileTabs";

vi.mock("@/features/auth/useActiveDepartment", () => ({
  useActiveDepartment: () => ({ departmentId: null, canSubmit: false }),
}));
vi.mock("@/features/auth/useSession", () => ({ useSession: () => ({ session: null }) }));
vi.mock("@/features/auth/useIsSadran", () => ({ useIsSadranAnywhere: () => ({ isSadran: false }) }));
vi.mock("@/features/auth/useProfile", () => ({
  useProfile: () => ({ data: undefined }),
  useUpdateProfileMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/auth/useMyDepartments", () => ({
  useMyDepartments: () => ({ data: [] }),
  useSetMyDefaultOriginMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/auth/usePushSubscriptionStatus", () => ({
  usePushSubscriptionStatus: () => ({ isSubscribed: false, isLoading: false, refresh: vi.fn() }),
}));
vi.mock("@/features/fleet/hooks", () => ({
  useDestinations: () => ({ data: [] }),
  useMyTemporaryCars: () => ({ data: [] }),
  useRegisterTemporaryCarMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/features/member/hooks", () => ({
  useGuardedChildrenQuery: () => ({ data: [] }),
  useRideEditorsQuery: () => ({ data: undefined }),
  useSetRideEditorsMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/auth/useDepartmentMembers", () => ({ useDepartmentMembers: () => ({ data: undefined }) }));
vi.mock("@/features/member/components/ThemePicker", () => ({ ThemePicker: () => <div data-testid="theme-picker" /> }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut: vi.fn() } } }));

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "test";
const { ProfilePage } = await import("./ProfilePage");

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <ProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("guarded children rows", () => {
  it("shows the age when the birth year is known", () => {
    expect(guardedChildLabel({ id: "1", name: "נועה", age: 7 })).toBe("נועה (גיל: 7 שנים)");
    expect(guardedChildLabel({ id: "1", name: "נועה", age: 0 })).toBe("נועה (גיל: 0 שנים)");
  });
  it("shows just the name without a birth year", () => {
    expect(guardedChildLabel({ id: "2", name: "דני", age: null })).toBe("דני");
  });
  it("renders rows, and nothing when empty", () => {
    const { container, unmount } = render(<ParentOfCardView children={[{ id: "1", name: "נועה", age: 7 }]} />);
    expect(screen.getByText("נועה (גיל: 7 שנים)")).toBeInTheDocument();
    unmount();
    const empty = render(<ParentOfCardView children={[]} />);
    expect(empty.container).toBeEmptyDOMElement();
    expect(container).toBeDefined();
  });
});

describe("profile tabs", () => {
  it("validates the tab value", () => {
    expect(isProfileTab("look")).toBe(true);
    expect(isProfileTab("nope")).toBe(false);
    expect(isProfileTab(null)).toBe(false);
  });
  it("opens the details tab by default and for an unknown value", () => {
    renderAt("/profile?tab=bogus");
    expect(screen.getByTestId("profile-tab-details")).toHaveAttribute("data-state", "active");
  });
  it("opens the look tab from ?tab=look", () => {
    renderAt("/profile?tab=look");
    expect(screen.getByTestId("profile-tab-look")).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("theme-picker")).toBeInTheDocument();
  });
});
