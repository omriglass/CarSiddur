import { useState } from "react";
import { Link } from "react-router-dom";

import { PassengerStepper } from "@/components/PassengerStepper";
import { InstallHint, isStandalonePwa } from "@/components/InstallHint";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useIsSadranAnywhere } from "@/features/auth/useIsSadran";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile, useUpdateProfileMutation } from "@/features/auth/useProfile";
import { usePushSubscriptionStatus } from "@/features/auth/usePushSubscriptionStatus";
import { useSession } from "@/features/auth/useSession";
import {
  useMyTemporaryCars,
  useRegisterTemporaryCarMutation,
} from "@/features/fleet/hooks";
import { MUTE_CATEGORIES } from "@/features/inbox/muteCategories";
import { he } from "@/i18n/he";
import { isPushSupported, subscribeToPush, unsubscribeFromPush } from "@/lib/push";
import { showErrorToast } from "@/lib/rpc";
import { supabase } from "@/integrations/supabase/client";

import type { Database } from "@/integrations/supabase/types";

type HomeWeekPreference = Database["public"]["Enums"]["home_week_preference"];
type NotificationEvent = Database["public"]["Enums"]["notification_event"];

/**
 * `/profile` (UX_FLOWS.md §3.8). Departments, home-week preference, mute
 * switches, push subscription, temporary-car registration, and the
 * Sadran/Admin management entry points.
 */
export function ProfilePage() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const profileQuery = useProfile();
  const updateProfileMutation = useUpdateProfileMutation();
  const departmentsQuery = useMyDepartments();
  const { isSadran } = useIsSadranAnywhere();
  const isAdmin = !!profileQuery.data?.is_admin;

  const pushStatus = usePushSubscriptionStatus();
  const [pushBusy, setPushBusy] = useState(false);
  const needsIosInstall =
    typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent) && !isStandalonePwa();

  const temporaryCarsQuery = useMyTemporaryCars(profileId);
  const registerCarMutation = useRegisterTemporaryCarMutation();
  const [carName, setCarName] = useState("");
  const [carPlate, setCarPlate] = useState("");
  const [carSeats, setCarSeats] = useState({ adults: 4, childSeats: 0, boosters: 0 });

  const mutedEvents = new Set(profileQuery.data?.muted_events ?? []);

  function toggleCategory(events: readonly NotificationEvent[], enabled: boolean) {
    const next = new Set(mutedEvents);
    for (const event of events) {
      if (enabled) next.delete(event);
      else next.add(event);
    }
    updateProfileMutation.mutate({ muted_events: [...next] });
  }

  async function togglePush(nextEnabled: boolean) {
    setPushBusy(true);
    try {
      if (nextEnabled) {
        await subscribeToPush();
      } else {
        await unsubscribeFromPush();
      }
      pushStatus.refresh();
    } catch (error) {
      showErrorToast(error);
    } finally {
      setPushBusy(false);
    }
  }

  async function handleRegisterCar() {
    if (!profileQuery.data || !departmentsQuery.data?.[0]) return;
    await registerCarMutation.mutateAsync({
      departmentId: departmentsQuery.data[0].department_id,
      ownerId: profileQuery.data.id,
      name: carName,
      licensePlate: carPlate,
      seatConfig: carSeats,
    });
    setCarName("");
    setCarPlate("");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <h1 className="text-xl font-semibold">{he.screen.profile.title}</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{he.profileExtra.detailsTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>{he.field.fullName}</Label>
            <Input value={profileQuery.data?.full_name ?? ""} readOnly />
          </div>
          <div className="space-y-1">
            <Label>{he.profileExtra.email}</Label>
            <Input dir="ltr" value={profileQuery.data?.email ?? ""} readOnly />
          </div>
          <div className="space-y-1">
            <Label>{he.field.phone}</Label>
            <Input
              dir="ltr"
              defaultValue={profileQuery.data?.phone ?? ""}
              onBlur={(e) => updateProfileMutation.mutate({ phone: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{he.profileExtra.departmentsTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(departmentsQuery.data ?? []).map((d) => (
            <span
              key={d.department_id}
              className="rounded-full border px-3 py-1 text-sm"
            >
              {d.department.name}
              {profileQuery.data?.default_department_id === d.department_id ? ` · ${he.profileExtra.defaultBadge}` : ""}
            </span>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{he.profileExtra.homeWeekTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>{he.profileExtra.homeWeekLabel}</Label>
          <Select
            value={profileQuery.data?.home_week_preference ?? "auto"}
            onValueChange={(next) => updateProfileMutation.mutate({ home_week_preference: next as HomeWeekPreference })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{he.profileExtra.homeWeekAuto}</SelectItem>
              <SelectItem value="live">{he.profileExtra.homeWeekLive}</SelectItem>
              <SelectItem value="open">{he.profileExtra.homeWeekOpen}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{he.profileExtra.homeWeekHelper}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{he.profileExtra.notificationsTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {needsIosInstall ? (
            <InstallHint />
          ) : isPushSupported() ? (
            <div className="flex items-center justify-between">
              <span className="text-sm">
                {pushStatus.isSubscribed ? he.profileExtra.pushEnabled : he.profileExtra.pushDisabled}
              </span>
              <Switch
                checked={pushStatus.isSubscribed}
                disabled={pushBusy || pushStatus.isLoading}
                onCheckedChange={togglePush}
              />
            </div>
          ) : null}

          <div className="space-y-2 border-t pt-3">
            {MUTE_CATEGORIES.map((category) => (
              <div key={category.key} className="flex items-center justify-between">
                <span className="text-sm">{category.label}</span>
                <Switch
                  checked={!category.events.some((e) => mutedEvents.has(e))}
                  onCheckedChange={(checked) => toggleCategory(category.events, checked)}
                />
              </div>
            ))}
            <div className="flex items-center justify-between opacity-60">
              <span className="text-sm">{he.nav.sadran}</span>
              <span className="text-xs text-muted-foreground">{he.profileExtra.sadranEventsNote}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{he.profileExtra.tempCarTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(temporaryCarsQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{he.profileExtra.tempCarNone}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {(temporaryCarsQuery.data ?? []).map((car) => (
                <li key={car.id} className="flex items-center justify-between">
                  <span>{car.name}</span>
                  {car.status === "retired" ? (
                    <span className="text-xs text-muted-foreground">{he.profileExtra.tempCarRevoked}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-2 border-t pt-3">
            <div className="space-y-1">
              <Label>{he.profileExtra.tempCarNickname}</Label>
              <Input value={carName} onChange={(e) => setCarName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>{he.profileExtra.tempCarPlate}</Label>
              <Input dir="ltr" value={carPlate} onChange={(e) => setCarPlate(e.target.value)} />
            </div>
            <Label>{he.profileExtra.tempCarSeats}</Label>
            <PassengerStepper value={carSeats} onChange={setCarSeats} />
            <Button
              size="sm"
              disabled={!carName || !carPlate || registerCarMutation.isPending}
              onClick={handleRegisterCar}
            >
              {he.action.registerTempCar}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        {isSadran ? (
          <Button asChild variant="outline">
            <Link to="/sadran">{he.nav.sadran}</Link>
          </Button>
        ) : null}
        {isAdmin ? (
          <Button asChild variant="outline">
            <Link to="/admin">{he.nav.admin}</Link>
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => supabase.auth.signOut()}>
          {he.action.signOut}
        </Button>
      </div>
    </div>
  );
}
