import {
  AlertTriangle,
  Building2,
  Calendar,
  Car,
  MapPin,
  MessageSquare,
  ScrollText,
  Settings,
  Signpost,
  Users,
} from "lucide-react";
import type { ComponentType } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCarIssues } from "@/features/admin/cars/hooks";
import { useProfile } from "@/features/auth/useProfile";
import { he } from "@/i18n/he";

interface AdminCard {
  to: string;
  title: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}

export function AdminHomeScreen() {
  const isAdmin = !!useProfile().data?.is_admin;
  const issuesQuery = useCarIssues();
  const openIssuesCount = (issuesQuery.data ?? []).filter((i) => i.status === "open").length;

  const cards: AdminCard[] = [
    { to: "/admin/departments", title: he.screen.admin.departments, subtitle: he.adminHome.cardDepartments, icon: Building2 },
    { to: "/admin/members", title: he.screen.admin.members, subtitle: he.adminHome.cardMembers, icon: Users },
    { to: "/admin/roster", title: he.screen.admin.roster, subtitle: he.adminHome.cardRoster, icon: Calendar },
    { to: "/admin/cars", title: he.screen.admin.cars, subtitle: he.adminHome.cardCars, icon: Car },
    { to: "/admin/issues", title: he.screen.admin.issues, subtitle: he.adminHome.cardIssues, icon: AlertTriangle },
    { to: "/admin/destinations", title: he.screen.admin.destinations, subtitle: he.adminHome.cardDestinations, icon: MapPin },
    { to: "/admin/ride-types", title: he.screen.admin.rideTypes, subtitle: he.adminHome.cardRideTypes, icon: Signpost },
    { to: "/admin/policies", title: he.screen.admin.policies, subtitle: he.adminHome.cardPolicies, icon: ScrollText },
    { to: "/admin/templates", title: he.screen.admin.templates, subtitle: he.adminHome.cardTemplates, icon: MessageSquare },
    { to: "/admin/settings", title: he.screen.admin.settings, subtitle: he.adminHome.cardSettings, icon: Settings },
  ];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">{he.screen.admin.home}</h1>
        <p className="text-sm text-muted-foreground">{he.adminHome.subtitle}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        {cards.filter((card) => isAdmin || !["/admin/departments", "/admin/members", "/admin/roster"].includes(card.to)).map(({ to, title, subtitle, icon: Icon }) => (
          <Link key={to} to={to}>
            <Card className="h-full bg-gradient-card shadow-card transition-smooth hover:shadow-elegant">
              <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </span>
                  {title}
                </CardTitle>
                {to === "/admin/issues" && openIssuesCount > 0 ? (
                  <Badge variant="destructive">{openIssuesCount}</Badge>
                ) : null}
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{subtitle}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
