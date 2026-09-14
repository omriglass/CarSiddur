# Publish this app with free hosting

This is a procedure document: how to stand up and update the hosted
deployment. For what actually happened on a given date (which migrations
shipped, incidents and their fixes), see `docs/RELEASES.md`. For the ongoing
release/rollback workflow once the gated flow (below) is in place, see
`npm run release` (`scripts/release.mjs`) and `docs/RUNBOOK_ROLLBACK.md`.

## What you need

| Item | Purpose |
| --- | --- |
| GitHub repository | Stores the code and supplies Cloudflare builds. A private repository is suitable. |
| Cloudflare Workers (Free plan) | Hosts the React/Vite site over HTTPS as the `carsiddur` Worker, serving static assets from `dist/` (`wrangler.jsonc`). |
| Supabase Free project | Hosts PostgreSQL, authentication, scheduled database tasks and the Edge Functions. |
| Google Cloud project with an OAuth web client | Enables the app's production Google sign-in. No separate Google hosting is needed. |
| VAPID key pair and a random cron secret | Configures browser push and internal callbacks; these are generated credentials, not extra services. |
| A backup location | Keep regular database exports outside the live project and outside the code repository — Google Drive (owner decision 2026-09-14 #3). |

No separate application server, Vercel account, paid WhatsApp API, SMS service, or email provider is needed for the current Google-login/browser-push/manual-WhatsApp-link flow. A custom domain is optional; use the Worker's free `*.workers.dev` address initially.

## 1. Put the reviewed code on GitHub

Commit the intended source changes, migrations, package lock and generated solver bundle to your deployment branch. Keep `.env.local`, `supabase/functions/.env`, private keys and database exports out of Git. Deploy the current working changes, not an older committed version.

Cloudflare's Git integration builds the selected branch after pushes. This does not deploy database migrations or Supabase functions.

## 2. Create the hosted Supabase project

Choose the Free plan, save its database password, and record its project reference, project URL and browser-safe anon key. The app currently calls the browser key `VITE_SUPABASE_ANON_KEY`; never put a service-role key there.

From the repository root, after installing dependencies with `npm ci`:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

Confirm the linked project is the new hosted project before pushing. Use migrations for subsequent changes. Do not run database reset against production, and do not add `--include-seed`: this repository's `supabase/seed.sql` contains demo logins and rides.

**Never run `npx supabase config push`.** The checked-in `supabase/config.toml` is the **local** stack's configuration (`[auth] site_url = "http://localhost:8080"`, local redirect URLs, local-only auth toggles). Pushing it would overwrite the hosted project's real Auth URL configuration. Production Auth settings (Site URL, redirect URLs, the Google provider's client id/secret) are set by hand in the Supabase dashboard — see §5 below.

## 3. Generate and configure notification credentials

Generate one stable VAPID pair and a separate random secret:

```sh
npx web-push generate-vapid-keys
openssl rand -hex 32
```

Save these Supabase Edge Function secrets using the dashboard's secret editor:

- `VAPID_PUBLIC_KEY`: generated public key.
- `VAPID_PRIVATE_KEY`: matching private key.
- `VAPID_SUBJECT`: `mailto:YOUR_REAL_CONTACT_EMAIL`.
- `CRON_SECRET`: generated random secret.

Keep the VAPID pair stable across deployments so existing browser subscriptions continue to work. The frontend also requires the public key; its environment validation rejects an empty value.

Build and deploy the functions from this repository so its `supabase/config.toml` authentication settings are used:

```sh
npm run functions:bundle
npx supabase functions deploy push-dispatch --project-ref YOUR_PROJECT_REF
npx supabase functions deploy answer-proposal --project-ref YOUR_PROJECT_REF
npx supabase functions deploy on-ride-cancelled --project-ref YOUR_PROJECT_REF
npx supabase functions deploy destination-route --project-ref YOUR_PROJECT_REF
```

These functions perform their own authentication. In particular, `answer-proposal` must accept the app's proposal token without requiring a signed-in Supabase session; preserve the checked-in `verify_jwt = false` settings.

In the hosted project's SQL Editor, substitute the actual project reference and secret:

```sql
insert into public.app_settings (key, value) values
  ('on_ride_cancelled_url', jsonb_build_object('value', 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/on-ride-cancelled')),
  ('push_dispatch_url', jsonb_build_object('value', 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/push-dispatch'))
on conflict (key) do update set value = excluded.value;

insert into public.app_secrets (key, value)
values ('cron_secret', jsonb_build_object('value', 'YOUR_SAME_CRON_SECRET'))
on conflict (key) do update set value = excluded.value;
```

The URL settings alone are not sufficient: `app_secrets.cron_secret` must match the Edge Function secret. The existing migrations install the `app_tick` database cron job; verify it exists in Supabase Cron. No additional external scheduler is required.

## 4. Create the Cloudflare Worker site

In Cloudflare, open Workers & Pages → Create → **Workers** → Import a Git repository, and connect the GitHub repository. Cloudflare's Git integration builds and deploys with Wrangler, using the checked-in `wrangler.jsonc` (name `carsiddur`, `assets.directory = "./dist"`) rather than a separate output-directory setting:

| Setting | Value |
| --- | --- |
| Root directory | Repository root |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |

Once the initial owner setup below is done (see "One-time setup for the gated flow"), this connects to the `production` branch, not `main` — `production` only advances when the owner approves a release (`npm run release`, `docs/RUNBOOK_ROLLBACK.md`).

Record the Worker's `https://carsiddur.<your-subdomain>.workers.dev` URL (shown in the dashboard once the first deploy succeeds). Set these production build variables, then deploy/redeploy:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
VITE_VAPID_PUBLIC_KEY=YOUR_VAPID_PUBLIC_KEY
VITE_APP_URL=https://carsiddur.<your-subdomain>.workers.dev
```

All `VITE_` values are public browser configuration. Private VAPID, Google client and service-role secrets belong in Supabase, not these build variables. Changing these variables requires a new frontend build.

`wrangler.jsonc` enables `assets.not_found_handling = "single-page-application"`. Do not add `_redirects` rules to rewrite application routes to `index.html`: Workers' deployment validation rejects the previous rules as redirect loops. The native SPA fallback serves application navigation directly. There is no Vercel or Cloudflare Pages configuration; the Worker is the only production host.

**Security headers.** `public/_headers` (copied by Vite into `dist/`, applied by Cloudflare to every asset response) sets a Content-Security-Policy that allows scripts only from the app itself, styles and fonts from the app and Google Fonts (Heebo), and connections only to `*.supabase.co`, plus `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy` and a restrictive `Permissions-Policy`. If the Supabase project ever moves to a custom domain, or a new third-party origin is added (an image host, an analytics endpoint), update `connect-src`/`img-src` there in the same change, otherwise the browser blocks the request silently. Verify locally with `npm run build && npx wrangler dev` and `curl -I http://localhost:8787/`; in production check the response headers of `/` in the browser's network panel after each deploy. Do not add caching rules to that file (see the next paragraph).

After redeploying, directly open and refresh `/my`, `/admin/members`, and `/p/TOKEN` in a private window, then check browser Back/Forward. These must load the application without a hosting 404, including before a service worker is installed. Avoid custom caching rules over the service worker or HTML. See [Workers SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).

## 5. Configure Google sign-in

1. Create a Google OAuth consent configuration and an OAuth client of type **Web application**.
2. Set the authorized JavaScript origin to the Worker's URL (`https://carsiddur.<your-subdomain>.workers.dev`, or your custom domain).
3. Set the authorized redirect URI to the callback shown in Supabase's Google provider settings, normally `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.
4. Paste the Google client ID and client secret into Supabase Authentication's Google provider and enable it.
5. In Supabase Auth URL Configuration, set the Site URL and allowed redirect URL to the Worker's URL. The app redirects Google login to `VITE_APP_URL`.
6. While Google's OAuth application is in Testing mode, add your pilot accounts as test users. Configure its audience/publishing status appropriately before inviting everyone.
7. Keep production sign-in Google-only. The repository's email/password login form is development-only.

The Google callback URL and the website's post-login URL are different; configure both.

## 6. Initialize real application data

**Repository preparation still needed:** there is no separate production-only bootstrap script. Migrations create the schema, but most initial catalogs, notification templates and sample policies live in the development seed. Do not import that entire file.

For the first administrator, sign in with the intended Google account once. This creates its pending profile. Then use the hosted SQL Editor, replacing the placeholders with that exact account and real phone:

```sql
update public.profiles
set is_admin = true,
    approval_status = 'approved',
    approved_at = now(),
    phone = '+972YOUR_REAL_NUMBER'
where email = lower('YOUR_GOOGLE_EMAIL');
```

Verify exactly the intended profile was updated, then refresh/sign in again. A `member_invites` entry alone does not grant admin: its schema explicitly forbids `role = 'admin'`.

Create/import the real home destination, department, member memberships and Sadran roster, cars and codes/seat configurations, destinations/travel times, ride types (including `other`), and an active versioned priority policy. Set the department's home destination and weekly request/publication times. Prepare a reviewed bootstrap/import containing the needed notification templates and catalog defaults, excluding demo identities, rides and local endpoint/secret settings. Verify templates include all events and channels used by the app before inviting members.

If retaining existing local real data is desired, prepare a selective migration/import with hosted identity mapping; local demo passwords and fake users are not a production data migration.

## 7. Verify the actual hosted site

Use two real member accounts and a coordinator to check Google sign-in, request submission, solving, selected-day publication, a WhatsApp proposal link opened signed out, one-way driver volunteering, cancellation/reassignment, and browser push on the intended phones. Check Supabase function/cron logs and that unpublished days remain private. Local automated tests do not replace these hosted checks.

## 8. Releases, backups and rollback

Once the one-time setup below is done, the only supported way to ship a
release is:

```sh
npm run release            # add --dry-run first to preview, --status to check where things stand
```

`scripts/release.mjs` runs the full sequence — clean-tree check, `npm run
check`, solver-bundle freshness, a pre-release database backup
(`scripts/db-export.mjs --linked --yes-remote`; **copy the three files to
Google Drive** — owner decision 2026-09-14 #3: pre-release dump + weekly,
keep roughly the last 8), pending migrations (`supabase db push`), changed
edge functions, and finally an annotated `vYYYY.MM.DD-n` tag pushed to
`origin`. It refuses to touch the hosted project or push anything without an
explicit `--yes-remote`, mirroring `scripts/db-export.mjs`'s guard.

**Pushing the tag does not deploy the frontend.** It triggers CI
(`.github/workflows/ci.yml`): `check` and `database` run against the tag,
then the `promote` job waits on the GitHub `production` environment, which
requires the owner's approval. **The owner's "Approve" click is the one and
only "deploy frontend" action** — nothing reaches Cloudflare before it. Once
approved, `production` fast-forwards to the tag, and Cloudflare — now
building only from `production` (see the one-time setup below) — rebuilds
the `carsiddur` Worker.

Database migrations are **forward-fix only** (owner decision 2026-09-14 #4):
additive, expand/contract, never dropping or renaming a column the running
frontend still uses in the same release. `scripts/check-migrations.mjs`
(run in CI's `check` job and by `npm run release`) fails a new migration
that can't avoid a destructive statement unless it ships with a tested
`supabase/rollback/<ts>_down.sql` (`supabase/rollback/README.md`). A full
restore from a backup is the last resort, not routine rollback — it loses
every write since that backup.

If a release goes out and turns out to be wrong, see
**`docs/RUNBOOK_ROLLBACK.md`** for the decision tree and the exact commands
per layer (frontend, edge functions, database). It is never automatic;
every command there is typed by a human after reading the situation.

## One-time setup for the gated flow

Three actions only the owner can do (dashboard/GitHub admin access), done
once before the first gated release:

1. **Create the `production` branch.** The lead pushes it from the reviewed
   `main`: `git push origin main:production`. After this, `production` only
   _Done 2026-09-14: `production` was created at commit 1969f4e (the commit live on Cloudflare at that moment)._
   ever moves via the `promote` CI job (fast-forward only) or an explicit
   rollback command from `docs/RUNBOOK_ROLLBACK.md` — never a direct push.
2. **Repoint Cloudflare's build branch to `production`.** In the `carsiddur`
   Worker's dashboard → Settings → Build, change the connected branch from
   `main` to `production`. Today it builds from `main` on every push, even
   when CI is red; after this change, Cloudflare only ever sees code the
   owner has already approved.
3. **Create the GitHub `production` environment with the owner as a
   required reviewer.** Repository → Settings → Environments → New
   environment → name it `production` → Required reviewers → add the
   owner. This is what makes the `promote` job in `.github/workflows/ci.yml`
   pause for approval instead of running straight through.

Optional but recommended: branch protection on `main` requiring the `check`
and `database` CI jobs to pass before merge, so a red build never reaches
`main` in the first place.

## Free-plan limits and official references

- Supabase currently includes 500 MB database space, 50,000 monthly active users, 5 GB egress and 500,000 Edge Function invocations. Projects pause after one week of inactivity. This appears suitable for a small community rollout, but actual traffic, polling, audit growth and snapshots determine usage. Do not promise continuous availability on the free tier or rely on a keep-alive workaround. [Supabase pricing](https://supabase.com/pricing)
- Cloudflare Workers (Free plan) currently allows 500 builds/month through its Git integration (Workers Builds), plus the standard Workers Free request/CPU-time limits. Check current limits before launch. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Vite deployment guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/vite/)
- [Workers SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Supabase Google OAuth setup](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase backup guidance](https://supabase.com/docs/guides/platform/backups)
