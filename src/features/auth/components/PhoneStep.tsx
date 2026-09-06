import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/he";

import { onboardingPhoneSchema, type OnboardingPhoneInput } from "../schema";

interface PhoneStepProps {
  defaultPhone?: string;
  isSubmitting?: boolean;
  onSubmit: (values: { phone: string }) => void;
}

/**
 * Onboarding step 1, phone only (UX_FLOWS.md §3.2): "טלפון (חובה)" with
 * Israeli mobile validation, stored E.164. Name/department fields from the
 * wireframe are out of scope for this stage — `profiles.full_name` is
 * already set by `handle_new_user()` from the Google profile and
 * `default_department_id` has no UI yet (single-department seed data).
 */
export function PhoneStep({ defaultPhone, isSubmitting, onSubmit }: PhoneStepProps) {
  const form = useForm<OnboardingPhoneInput>({
    resolver: zodResolver(onboardingPhoneSchema),
    defaultValues: { phone: defaultPhone ?? "" },
  });

  return (
    <Form {...form}>
      <form
        className="space-y-4"
        onSubmit={form.handleSubmit((values) => onSubmit({ phone: values.phone as string }))}
      >
        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("field.phone")}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="tel"
                  dir="ltr"
                  inputMode="tel"
                  placeholder="050-1234567"
                  autoComplete="tel"
                />
              </FormControl>
              <p className="text-sm text-muted-foreground">{t("onboarding.phoneHint")}</p>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {t("common.save")}
        </Button>
      </form>
    </Form>
  );
}
