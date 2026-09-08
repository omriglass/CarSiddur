import { Bell, CalendarDays, ClipboardList, Settings, User, Users } from "lucide-react";
import type { ComponentType } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { DepartmentContextSelector } from "@/components/DepartmentContextSelector";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { OfflineNotice } from "@/components/OfflineNotice";
import { AppLogoMark } from "@/components/AppLogoMark";
import { useIsSadranAnywhere } from "@/features/auth/useIsSadran";
import { useCanManageOperations } from "@/features/admin/useOperations";
import { Button } from "@/components/ui/button";
import { useUnreadCount } from "@/features/inbox/hooks";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  badge?: number;
}

/**
 * The four tabs shared by the mobile bottom bar and the md+ side nav
 * (ARCHITECTURE.md §4, UX_FLOWS.md §2.1/§2.2): הסידור / הבקשות שלי / הודעות / פרופיל.
 * A fifth tab, סדרן, is appended only while I am Sadran of at least one of
 * my departments for its open/live week; ניהול מערכת (Admin) is never a
 * bottom tab and only appears in the md+ nav (or from Profile).
 */
const BASE_NAV_ITEMS: readonly NavItem[] = [
  { to: "/siddur", label: he.nav.siddur, icon: CalendarDays },
  { to: "/my", label: he.nav.myRequests, icon: ClipboardList },
  { to: "/inbox", label: he.nav.inbox, icon: Bell },
  { to: "/profile", label: he.nav.profile, icon: User },
];

function NavLinks({
  items,
  orientation,
}: {
  items: readonly NavItem[];
  orientation: "horizontal" | "vertical";
}) {
  return (
    <>
      {items.map(({ to, label, icon: Icon, badge }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              "relative flex min-h-11 items-center gap-2 rounded-md text-sm font-medium transition-smooth",
              orientation === "horizontal"
                ? "flex-1 flex-col gap-0.5 py-2 text-xs"
                : "px-3 py-2",
              isActive
                ? orientation === "horizontal"
                  ? "text-primary"
                  : "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )
          }
        >
          {({ isActive }) => (
            <>
              <span className="relative">
                <Icon className="size-5" />
                {badge ? (
                  <span className="absolute -end-1.5 -top-1.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                    {badge > 9 ? "9+" : badge}
                  </span>
                ) : null}
              </span>
              <span>{label}</span>
              {orientation === "horizontal" ? (
                <span
                  className={cn(
                    "absolute -top-1 h-0.5 w-8 rounded-full bg-primary transition-smooth",
                    isActive ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden="true"
                />
              ) : null}
            </>
          )}
        </NavLink>
      ))}
    </>
  );
}

/** App-wide layout: skip link, offline banner, top bar / md+ side nav, mobile bottom tab bar, `<Outlet>`. */
export function AppShell() {
  const context = useActiveDepartment();
  const { isSadran } = useIsSadranAnywhere();
  const canManageOperations = !!useCanManageOperations().data;
  const unreadCount = useUnreadCount();

  const navItems: NavItem[] = [
    ...BASE_NAV_ITEMS.map((item) => (item.to === "/inbox" ? { ...item, badge: unreadCount } : item)),
    ...(isSadran ? [{ to: "/sadran", label: he.nav.sadran, icon: Users }] : []),
  ];
  const desktopNavItems: NavItem[] = [
    ...navItems,
    ...(canManageOperations ? [{ to: "/admin", label: he.nav.admin, icon: Settings }] : []),
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-background md:flex-row">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        {he.common.skipToContent}
      </a>

      <nav
        aria-label={he.app.name}
        className="hidden shrink-0 border-e bg-card md:flex md:w-56 md:flex-col md:gap-1 md:p-3"
      >
        <div className="flex items-center gap-2 px-2 py-2">
          <AppLogoMark />
          <span className="text-lg font-semibold leading-tight">{he.app.name}</span>
        </div>
        <NavLinks items={desktopNavItems} orientation="vertical" />
      </nav>

      <div className="flex flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
          <AppLogoMark />
          <span className="text-base font-semibold leading-tight">{he.app.name}</span>
          {canManageOperations ? (
            <Button asChild size="icon" variant="ghost" className="ms-auto">
              <Link to="/admin" aria-label={he.nav.admin}><Settings className="size-5" /></Link>
            </Button>
          ) : null}
        </header>
        <OfflineNotice />
        <main id="main-content" className="flex-1 overflow-y-auto pb-16 md:pb-0">
          <DepartmentContextSelector />
          <div key={context.departmentId}><Outlet /></div>
        </main>

        <nav
          aria-label={he.app.name}
          className="fixed inset-x-0 bottom-0 z-40 flex min-h-16 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_10px_-2px_hsl(var(--foreground)/0.08)] backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
        >
          <NavLinks items={navItems} orientation="horizontal" />
        </nav>
      </div>
    </div>
  );
}
