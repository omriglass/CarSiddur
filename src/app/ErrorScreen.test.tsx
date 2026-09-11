import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { ErrorScreen } from "./ErrorScreen";

function ThrowingRoute(): never {
  throw new Error("boom: something exploded");
}

function renderThrowing() {
  const router = createMemoryRouter(
    [{ path: "/", element: <ThrowingRoute />, errorElement: <ErrorScreen /> }],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("ErrorScreen", () => {
  it("shows the Hebrew title and the error message in the collapsed details", () => {
    renderThrowing();
    expect(screen.getByText(he.errorScreen.title)).toBeInTheDocument();
    expect(screen.getByText(he.errorScreen.body)).toBeInTheDocument();
    expect(screen.getByText(he.errorScreen.detailsSummary)).toBeInTheDocument();
    expect(screen.getByText(/boom: something exploded/)).toBeInTheDocument();
  });

  it("renders reload and back-home actions", () => {
    renderThrowing();
    expect(screen.getByText(he.errorScreen.reload)).toBeInTheDocument();
    const homeLink = screen.getByText(he.errorScreen.backHome).closest("a");
    expect(homeLink).toHaveAttribute("href", "/");
  });
});
