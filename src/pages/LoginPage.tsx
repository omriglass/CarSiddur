import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Navigate, useLocation } from "react-router-dom";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useSession } from "@/features/auth/useSession";
import { he, t } from "@/i18n/he";
import { env } from "@/lib/env";
import { showErrorToast } from "@/lib/rpc";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/PageHeader";

const devLoginSchema = z.object({
  email: z.string().email(he.errors.invalidEmail),
  password: z.string().min(1),
});

type DevLoginInput = z.infer<typeof devLoginSchema>;

/**
 * `/login` (UX_FLOWS.md §3.1 names it `/signin`; the scaffolded router uses
 * `/login` — kept as-is, both are the same screen). Google sign-in is the
 * only production path; the email/password form below only renders under
 * `import.meta.env.DEV` so the seeded demo users
 * (supabase/seed.sql: admin@nevo.local, sadran@nevo.local, member1@nevo.local,
 * member2@nevo.local — password nevo-demo-1234) can sign in locally and in
 * Playwright without a real Google OAuth round trip.
 */
export function LoginPage() {
  const { session, isLoading } = useSession();
  const location = useLocation();
  const [isSubmittingGoogle, setIsSubmittingGoogle] = useState(false);

  const form = useForm<DevLoginInput>({
    resolver: zodResolver(devLoginSchema),
    defaultValues: { email: "", password: "" },
  });

  if (!isLoading && session) {
    const from = (location.state as { from?: { pathname: string } } | null)?.from;
    return <Navigate to={from?.pathname ?? "/my"} replace />;
  }

  async function handleGoogleSignIn() {
    setIsSubmittingGoogle(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: env.VITE_APP_URL },
    });
    if (error) {
      showErrorToast(error);
      setIsSubmittingGoogle(false);
    }
  }

  async function handleDevLogin(values: DevLoginInput) {
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error) showErrorToast(error);
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-4">
      <PageHeader title={he.app.name} />
      <Button size="lg" onClick={handleGoogleSignIn} disabled={isSubmittingGoogle}>
        {t("action.signinGoogle")}
      </Button>

      {import.meta.env.DEV ? (
        <>
          <Separator />
          <div className="space-y-4">
            <p className="text-sm font-medium text-muted-foreground">{t("auth.devSectionTitle")}</p>
            <Form {...form}>
              <form className="space-y-3" onSubmit={form.handleSubmit(handleDevLogin)}>
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("field.email")}</FormLabel>
                      <FormControl>
                        <Input {...field} type="email" dir="ltr" autoComplete="email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("field.password")}</FormLabel>
                      <FormControl>
                        <Input {...field} type="password" dir="ltr" autoComplete="current-password" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" variant="outline" className="w-full">
                  {t("action.signInEmail")}
                </Button>
              </form>
            </Form>
            <p className="text-xs text-muted-foreground">{t("auth.devHint")}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}
