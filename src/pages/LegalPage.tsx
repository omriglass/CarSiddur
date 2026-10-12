import { Fragment, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { paths } from "@/app/routes";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSession } from "@/features/auth/useSession";
import { he } from "@/i18n/he";
import { legalDocuments } from "@/i18n/he.legalDocs";

type LegalLang = "he" | "en";

/** `{{email}}` → a mailto link to `he.legal.contactEmail`. */
function withEmail(text: string): ReactNode {
  const parts = text.split("{{email}}");
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? (
        <a href={`mailto:${he.legal.contactEmail}`} className="underline underline-offset-2" dir="ltr">{he.legal.contactEmail}</a>
      ) : null}
    </Fragment>
  ));
}

/**
 * `/privacy` and `/terms` (owner 2026-10-12) — public, no sign-in: Google's OAuth consent screen links here. Hebrew by
 * default, English with `?lang=en` (the switch keeps the URL shareable). Text from `src/i18n/he.legalDocs.ts`.
 */
export function LegalPage({ doc }: { doc: "privacy" | "terms" }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const lang: LegalLang = searchParams.get("lang") === "en" ? "en" : "he";
  const document = legalDocuments[doc][lang];
  const { session } = useSession();
  const other = doc === "privacy" ? { to: paths.terms(lang === "en" ? "en" : undefined), label: he.legal.termsLink } : { to: paths.privacy(lang === "en" ? "en" : undefined), label: he.legal.privacyLink };

  function setLang(next: LegalLang) {
    const params = new URLSearchParams(searchParams);
    if (next === "en") params.set("lang", "en");
    else params.delete("lang");
    setSearchParams(params, { replace: true });
  }

  return (
    <div className="min-h-dvh bg-background px-4 py-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link to={session ? "/" : "/login"} className="text-sm text-primary underline-offset-2 hover:underline">{he.legal.backToApp}</Link>
          <ToggleGroup type="single" value={lang} onValueChange={(next) => { if (next === "he" || next === "en") setLang(next); }} aria-label={he.legal.languageLabel}>
            <ToggleGroupItem value="he" className="h-9 px-3 text-sm" data-testid="legal-lang-he">{he.legal.hebrew}</ToggleGroupItem>
            <ToggleGroupItem value="en" className="h-9 px-3 text-sm" data-testid="legal-lang-en">{he.legal.english}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <article dir={lang === "en" ? "ltr" : "rtl"} lang={lang} className="space-y-5 text-start" data-testid={`legal-${doc}`}>
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold">{document.title}</h1>
            <p className="text-sm text-muted-foreground">{document.updated}</p>
          </header>
          <p className="leading-relaxed">{withEmail(document.intro)}</p>
          {document.sections.map((section) => (
            <section key={section.heading} className="space-y-2">
              <h2 className="text-lg font-semibold">{section.heading}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph} className="leading-relaxed text-foreground/90">{withEmail(paragraph)}</p>
              ))}
            </section>
          ))}
        </article>
        <footer className="border-t pt-4 text-sm">
          <Link to={other.to} className="text-primary underline-offset-2 hover:underline">{other.label}</Link>
        </footer>
      </div>
    </div>
  );
}
