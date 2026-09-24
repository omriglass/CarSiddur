import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import {
  GuardLoading,
  RequireAdmin,
  RequireApproved,
  RequireAuth,
  RequireOnboarded,
  RequireOperations,
  RequireSadran,
} from "./guards";

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  useProfile: vi.fn(),
  useIsSadranAnywhere: vi.fn(),
  useCanManageOperations: vi.fn(),
}));

vi.mock("./useSession", () => ({ useSession: mocks.useSession }));
vi.mock("./useProfile", () => ({ useProfile: mocks.useProfile }));
vi.mock("./useIsSadran", () => ({ useIsSadranAnywhere: mocks.useIsSadranAnywhere }));
vi.mock("@/features/admin/useOperations", () => ({ useCanManageOperations: mocks.useCanManageOperations }));

/**
 * Renders a guard behind a real `<Routes>` tree so redirects are asserted by
 * final rendered content, not by inspecting router internals — `RequireAuth`
 * etc. only ever render `<Navigate>`/`<Outlet>`.
 */
function renderGuard(Guard: React.ComponentType, initialPath = "/protected") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<Guard />}>
            <Route path="/protected" element={<div>Protected content</div>} />
          </Route>
          <Route path="/login" element={<div>Login page</div>} />
          <Route path="/pending" element={<div>Pending page</div>} />
          <Route path="/onboarding" element={<div>Onboarding page</div>} />
          <Route path="/my" element={<div>My page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RequireAuth", () => {
  it("shows the loading placeholder while the session is resolving", () => {
    mocks.useSession.mockReturnValue({ session: null, isLoading: true });
    renderGuard(RequireAuth);
    expect(screen.getByText(he.common.loading)).toBeVisible();
  });

  it("redirects to /login without a session", () => {
    mocks.useSession.mockReturnValue({ session: null, isLoading: false });
    renderGuard(RequireAuth);
    expect(screen.getByText("Login page")).toBeVisible();
  });

  it("renders the protected route with a session", () => {
    mocks.useSession.mockReturnValue({ session: { user: { id: "user" } }, isLoading: false });
    renderGuard(RequireAuth);
    expect(screen.getByText("Protected content")).toBeVisible();
  });
});

describe("RequireApproved", () => {
  it("redirects to /pending while not approved", () => {
    mocks.useProfile.mockReturnValue({ isLoading: false, data: { approval_status: "pending" } });
    renderGuard(RequireApproved);
    expect(screen.getByText("Pending page")).toBeVisible();
  });

  it("redirects to /pending when blocked", () => {
    mocks.useProfile.mockReturnValue({ isLoading: false, data: { approval_status: "blocked" } });
    renderGuard(RequireApproved);
    expect(screen.getByText("Pending page")).toBeVisible();
  });

  it("renders the protected route once approved", () => {
    mocks.useProfile.mockReturnValue({ isLoading: false, data: { approval_status: "approved" } });
    renderGuard(RequireApproved);
    expect(screen.getByText("Protected content")).toBeVisible();
  });

  it("shows the loading placeholder while the profile is resolving", () => {
    mocks.useProfile.mockReturnValue({ isLoading: true, data: undefined });
    renderGuard(RequireApproved);
    expect(screen.getByText(he.common.loading)).toBeVisible();
  });
});

describe("RequireOnboarded", () => {
  it("redirects to /onboarding without a phone", () => {
    mocks.useProfile.mockReturnValue({ isLoading: false, data: { phone: null } });
    renderGuard(RequireOnboarded);
    expect(screen.getByText("Onboarding page")).toBeVisible();
  });

  it("renders the protected route once a phone is set", () => {
    mocks.useProfile.mockReturnValue({ isLoading: false, data: { phone: "0500000000" } });
    renderGuard(RequireOnboarded);
    expect(screen.getByText("Protected content")).toBeVisible();
  });
});

describe("RequireSadran", () => {
  it("redirects to /my when not a Sadran anywhere", () => {
    mocks.useIsSadranAnywhere.mockReturnValue({ isSadran: false, isLoading: false });
    renderGuard(RequireSadran);
    expect(screen.getByText("My page")).toBeVisible();
  });

  it("renders the protected route for a Sadran", () => {
    mocks.useIsSadranAnywhere.mockReturnValue({ isSadran: true, isLoading: false });
    renderGuard(RequireSadran);
    expect(screen.getByText("Protected content")).toBeVisible();
  });

  it("shows the loading placeholder while resolving", () => {
    mocks.useIsSadranAnywhere.mockReturnValue({ isSadran: false, isLoading: true });
    renderGuard(RequireSadran);
    expect(screen.getByText(he.common.loading)).toBeVisible();
  });
});

describe("RequireAdmin", () => {
  it("redirects to /my for a non-admin", () => {
    mocks.useProfile.mockReturnValue({ isLoading: false, data: { is_admin: false } });
    renderGuard(RequireAdmin);
    expect(screen.getByText("My page")).toBeVisible();
  });

  it("renders the protected route for an admin", () => {
    mocks.useProfile.mockReturnValue({ isLoading: false, data: { is_admin: true } });
    renderGuard(RequireAdmin);
    expect(screen.getByText("Protected content")).toBeVisible();
  });
});

describe("RequireOperations", () => {
  it("redirects to /my without operations access", () => {
    mocks.useCanManageOperations.mockReturnValue({ isLoading: false, data: false });
    renderGuard(RequireOperations);
    expect(screen.getByText("My page")).toBeVisible();
  });

  it("renders the protected route with operations access", () => {
    mocks.useCanManageOperations.mockReturnValue({ isLoading: false, data: true });
    renderGuard(RequireOperations);
    expect(screen.getByText("Protected content")).toBeVisible();
  });

  it("shows the loading placeholder while resolving", () => {
    mocks.useCanManageOperations.mockReturnValue({ isLoading: true, data: undefined });
    renderGuard(RequireOperations);
    expect(screen.getByText(he.common.loading)).toBeVisible();
  });
});

describe("GuardLoading", () => {
  it("renders the shared loading copy", () => {
    render(<GuardLoading />);
    expect(screen.getByText(he.common.loading)).toBeVisible();
  });
});
