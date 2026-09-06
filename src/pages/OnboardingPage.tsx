import { useState } from "react";
import { Link, Navigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PhoneStep } from "@/features/auth/components/PhoneStep";
import { PushPermissionStep } from "@/features/auth/components/PushPermissionStep";
import { useProfile, useUpdateProfileMutation } from "@/features/auth/useProfile";
import { t } from "@/i18n/he";

type Step = "details" | "notifications" | "done";

const STEP_TITLES: Record<Step, string> = {
  details: t("onboarding.stepDetails"),
  notifications: t("onboarding.stepNotifications"),
  done: t("onboarding.stepDone"),
};

/**
 * `/onboarding` (UX_FLOWS.md §3.2): three short steps, skippable except
 * phone. Sits behind `RequireApproved` but *not* `RequireOnboarded` (that
 * guard is what sends members here in the first place).
 */
export function OnboardingPage() {
  const profileQuery = useProfile();
  const updateProfile = useUpdateProfileMutation();
  const [step, setStep] = useState<Step>(profileQuery.data?.phone ? "notifications" : "details");

  if (profileQuery.data?.phone && step === "details") {
    // Phone already set (e.g. back-navigation) — nothing left to gate on.
    return <Navigate to="/my" replace />;
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-4">
      <div className="flex justify-center gap-1.5" aria-hidden="true">
        {(["details", "notifications", "done"] as const).map((s) => (
          <span
            key={s}
            className={`h-1.5 w-8 rounded-full ${s === step ? "bg-primary" : "bg-muted"}`}
          />
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("screen.onboarding.title")}</CardTitle>
          <CardDescription>{STEP_TITLES[step]}</CardDescription>
        </CardHeader>
        <CardContent>
          {step === "details" ? (
            <PhoneStep
              defaultPhone={profileQuery.data?.phone ?? undefined}
              isSubmitting={updateProfile.isPending}
              onSubmit={({ phone }) => {
                updateProfile.mutate(
                  { phone },
                  { onSuccess: () => setStep("notifications") },
                );
              }}
            />
          ) : null}
          {step === "notifications" ? (
            <PushPermissionStep onNext={() => setStep("done")} />
          ) : null}
          {step === "done" ? (
            <div className="space-y-4 text-center">
              <p>{t("onboarding.doneBody")}</p>
              <Button asChild className="w-full">
                <Link to="/requests/new">{t("action.firstRequest")}</Link>
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
