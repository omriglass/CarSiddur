import { toast } from "sonner";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useState } from "react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";

import { PassengerStepper } from "@/components/PassengerStepper";
import { InstallHint } from "@/components/InstallHint";
import { isStandalonePwa } from "@/lib/pwaPlatform";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsSadranAnywhere } from "@/features/auth/useIsSadran";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import { useExperimentalFeatures } from "@/features/member/useExperimentalFeatures";
import { useMyDepartments, useSetMyDefaultOriginMutation } from "@/features/auth/useMyDepartments";
import { useProfile, useUpdateProfileMutation } from "@/features/auth/useProfile";
import { usePushSubscriptionStatus } from "@/features/auth/usePushSubscriptionStatus";
import { useSession } from "@/features/auth/useSession";
import {
  useDestinations,
  useMyTemporaryCars,
  useRegisterTemporaryCarMutation,
} from "@/features/fleet/hooks";
import { MUTE_CATEGORIES } from "@/features/inbox/muteCategories";
import { sendTestNotification } from "@/features/auth/api";
import { he, tv } from "@/i18n/he";
import { isPushSupported, subscribeToPush, unsubscribeFromPush } from "@/lib/push";
import { showDiagnosticErrorToast, showErrorToast } from "@/lib/rpc";
import { supabase } from "@/integrations/supabase/client";

import type { HomeWeekPreference, NotificationEvent } from "@/lib/enums";

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
  const active = useActiveDepartment();
  const { isSadran } = useIsSadranAnywhere();
  const isAdmin = !!profileQuery.data?.is_admin;
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const experimental = useExperimentalFeatures();

  // REQ §13.93: "נקודת יציאה קבועה" for the active department — `department_members.default_origin_id`.
  const originDestinationsQuery = useDestinations(active.departmentId);
  const setDefaultOriginMutation = useSetMyDefaultOriginMutation();
  const activeMembership = (departmentsQuery.data ?? []).find((d) => d.department_id === active.departmentId);

  const pushStatus = usePushSubscriptionStatus();
  const [pushBusy, setPushBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  /** Owner 2026-10-11: send myself a test notification; say how many devices it went to. */
  async function sendTest() {
    setTestBusy(true);
    try {
      const { devices } = await sendTestNotification();
      if (devices === 0) toast(he.profileExtra.testNotificationNoDevice);
      else if (devices === 1) toast.success(he.profileExtra.testNotificationSentOne);
      else toast.success(tv("profileExtra.testNotificationSent", { n: String(devices) }));
    } catch (error) {
      showErrorToast(error);
    } finally {
      setTestBusy(false);
    }
  }
  const needsIosInstall =
    typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent) && !isStandalonePwa();

  const temporaryCarsQuery = useMyTemporaryCars(profileId);
  const registerCarMutation = useRegisterTemporaryCarMutation();
  const hasCars = (temporaryCarsQuery.data ?? []).length > 0;
  const [addingCar, setAddingCar] = useState(false);
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
      showDiagnosticErrorToast(error);
    } finally {
      setPushBusy(false);
    }
  }

  async function handleRegisterCar() {
    if (!profileQuery.data || !active.departmentId || !active.canSubmit) return;
    await registerCarMutation.mutateAsync({
      departmentId: active.departmentId,
      ownerId: profileQuery.data.id,
      name: carName,
      licensePlate: carPlate,
      seatConfig: carSeats,
    });
    setCarName("");
    setCarPlate("");
    setAddingCar(false);
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
            <Label htmlFor="profile-display-name">{he.profileExtra.displayName}</Label>
            <Input
              id="profile-display-name"
              key={profileQuery.data?.display_name ?? ""}
              defaultValue={profileQuery.data?.display_name ?? ""}
              placeholder={profileQuery.data?.google_name ?? profileQuery.data?.full_name ?? ""}
              onBlur={(e) => {
                // Owner 2026-10-11: say so once the name really changed (the field saves on leaving it).
                const next = e.target.value.trim();
                if (next === (profileQuery.data?.display_name ?? "").trim()) return;
                updateProfileMutation.mutate({ display_name: e.target.value }, {
                  onSuccess: () => toast.success(next ? he.profileExtra.displayNameSaved : he.profileExtra.displayNameCleared),
                });
              }}
            />
            <p className="text-xs text-muted-foreground">{he.profileExtra.displayNameHelp}</p>
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
          <div className="flex items-center justify-between border-t pt-3">
            <div className="space-y-0.5">
              <Label htmlFor="profile-does-not-drive">{he.profileExtra.doesNotDriveLabel}</Label>
              <p className="text-xs text-muted-foreground">{he.profileExtra.doesNotDriveHelp}</p>
            </div>
            <Switch
              id="profile-does-not-drive"
              checked={profileQuery.data?.does_not_drive ?? false}
              onCheckedChange={(checked) => updateProfileMutation.mutate({ does_not_drive: checked })}
            />
          </div>
          {/* REQ §13.110 (e): the old field-by-field request form instead of the sentence layout. */}
          <div className="flex items-center justify-between border-t pt-3">
            <div className="space-y-0.5">
              <Label htmlFor="profile-classic-request-form">{he.profileExtra.classicRequestFormLabel}</Label>
              <p className="text-xs text-muted-foreground">{he.profileExtra.classicRequestFormHelp}</p>
            </div>
            <Switch
              id="profile-classic-request-form"
              checked={profileQuery.data?.classic_request_form ?? false}
              onCheckedChange={(checked) => updateProfileMutation.mutate({ classic_request_form: checked })}
            />
          </div>
          {/* Owner 2026-10-11: `/my` opens as the week grid (one column per day) instead of the list. */}
          <div className="flex items-center justify-between border-t pt-3">
            <div className="space-y-0.5">
              <Label htmlFor="profile-my-rides-week-view">{he.profileExtra.myRidesWeekViewLabel}</Label>
              <p className="text-xs text-muted-foreground">{he.profileExtra.myRidesWeekViewHelp}</p>
            </div>
            <Switch
              id="profile-my-rides-week-view"
              checked={profileQuery.data?.my_rides_week_view ?? false}
              onCheckedChange={(checked) => updateProfileMutation.mutate({ my_rides_week_view: checked })}
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
          <CardTitle className="text-base">{he.profileExtra.defaultOriginTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {active.departmentId ? (
            <>
              <Label htmlFor="profile-default-origin">{he.profileExtra.defaultOriginLabel}</Label>
              <Select
                value={activeMembership?.default_origin_id ?? ""}
                onValueChange={(next) =>
                  setDefaultOriginMutation.mutate({ departmentId: active.departmentId as string, originId: next || null })
                }
              >
                <SelectTrigger id="profile-default-origin">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{he.profileExtra.defaultOriginHome}</SelectItem>
                  {(originDestinationsQuery.data ?? []).map((destination) => (
                    <SelectItem key={destination.id} value={destination.id}>
                      {destination.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{he.profileExtra.defaultOriginHelp}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{he.profileExtra.defaultOriginNoDepartment}</p>
          )}
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
          <CardTitle className="text-base">{he.profileExtra.themeTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>{he.profileExtra.themeLabel}</Label>
          <ToggleGroup
            type="single"
            value={themePreference}
            onValueChange={(next) => next && setThemePreference(next as ThemePreference)}
            className="justify-start"
          >
            <ToggleGroupItem value="light" className="h-11 px-3 text-sm">
              {he.profileExtra.themeLight}
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" className="h-11 px-3 text-sm">
              {he.profileExtra.themeDark}
            </ToggleGroupItem>
            <ToggleGroupItem value="system" className="h-11 px-3 text-sm">
              {he.profileExtra.themeSystem}
            </ToggleGroupItem>
          </ToggleGroup>
        </CardContent>
      </Card>

      {/* Owner 2026-10-12: per-device opt-in (localStorage, no account data) for features still being tried out. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{he.profileExtra.experimentalTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="profile-experimental">{he.profileExtra.experimentalLabel}</Label>
              <p className="text-xs text-muted-foreground">{he.profileExtra.experimentalHelp}</p>
            </div>
            <Switch id="profile-experimental" checked={experimental.enabled} onCheckedChange={experimental.setEnabled} data-testid="profile-experimental" />
          </div>
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
          <Button type="button" variant="outline" size="sm" className="w-full" disabled={testBusy} onClick={() => void sendTest()} data-testid="test-notification">
            {he.profileExtra.testNotification}
          </Button>

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
          {!hasCars ? (
            <p className="text-sm text-muted-foreground">{he.profileExtra.tempCarNone}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {(temporaryCarsQuery.data ?? []).map((car) => (
                <li key={car.id} className="flex min-h-11 items-center justify-between gap-2">
                  <Link
                    to={paths.car(car.id)}
                    className="flex min-h-11 flex-wrap items-center gap-1 rounded-md border px-3 py-2 hover:bg-muted"
                    data-testid="my-private-car"
                  >
                    <span>{car.name}</span>
                    {car.license_plate ? (
                      <>
                        <span aria-hidden>·</span>
                        <span dir="ltr">{car.license_plate}</span>
                      </>
                    ) : null}
                  </Link>
                  {car.status === "retired" ? (
                    <span className="text-xs text-muted-foreground">{he.profileExtra.tempCarRevoked}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {hasCars && !addingCar ? (
            <Button size="sm" variant="outline" onClick={() => setAddingCar(true)}>
              {he.profileExtra.tempCarAddAnother}
            </Button>
          ) : null}
          {!hasCars || addingCar ? (
            <div className="space-y-2 border-t pt-3">
              <div className="space-y-1">
                <Label htmlFor="temporary-car-name">{he.profileExtra.tempCarNickname}</Label>
                <Input id="temporary-car-name" value={carName} onChange={(e) => setCarName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="temporary-car-plate">{he.profileExtra.tempCarPlate}</Label>
                <Input id="temporary-car-plate" dir="ltr" value={carPlate} onChange={(e) => setCarPlate(e.target.value)} />
              </div>
              <Label>{he.profileExtra.tempCarSeats}</Label>
              <PassengerStepper value={carSeats} onChange={setCarSeats} />
              <Button
                size="sm"
                disabled={!active.canSubmit || !carName || !carPlate || registerCarMutation.isPending}
                onClick={handleRegisterCar}
              >
                {he.action.registerTempCar}
              </Button>
            </div>
          ) : null}
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

      <footer className="space-y-1 pt-2 text-center text-xs text-muted-foreground">
        <div>{he.profileExtra.version} <span dir="ltr">{__APP_VERSION__}</span></div>
        <div className="flex justify-center gap-4">
          <Link to={paths.privacy()} className="underline-offset-2 hover:underline">{he.legal.privacyLink}</Link>
          <Link to={paths.terms()} className="underline-offset-2 hover:underline">{he.legal.termsLink}</Link>
        </div>
      </footer>
    </div>
  );
}
