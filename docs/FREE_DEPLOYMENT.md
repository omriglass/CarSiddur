# Publish this app with free hosting

## Quick update for the existing site

For the redirect-loop failure, the source fix removes `public/_redirects` and keeps Workers native SPA routing. Commit and push the fix; Cloudflare will rebuild and deploy it. No additional database migration is needed for this routing correction. Cloudflare build command: `npm run build`; deploy command: `npx wrangler deploy`.

Checked against provider documentation on 2026-09-07. This is a deployment checklist, not a record of a completed deployment.

## What you need

| Item | Purpose |
| --- | --- |
| GitHub repository | Stores the code and supplies Cloudflare builds. A private repository is suitable. |
| Cloudflare Pages Free | Hosts the React/Vite site over HTTPS at a free `PROJECT.pages.dev` address. |
| Supabase Free project | Hosts PostgreSQL, authentication, scheduled database tasks and the three Edge Functions. |
| Google Cloud project with an OAuth web client | Enables the app's production Google sign-in. No separate Google hosting is needed. |
| VAPID key pair and a random cron secret | Configures browser push and internal callbacks; these are generated credentials, not extra services. |
| A backup location | Keep regular database exports outside the live project and outside the code repository. |

No separate application server, Vercel account, paid WhatsApp API, SMS service, or email provider is needed for the current Google-login/browser-push/manual-WhatsApp-link flow. A custom domain is optional; use the free Pages address initially.

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

## 4. Create the Cloudflare Pages site

In Cloudflare, open Workers & Pages, create a Pages application, and connect the GitHub repository. Select the deployment branch and configure:

| Setting | Value |
| --- | --- |
| Root directory | Repository root |
| Build command | `npm run build` |
| Output directory | `dist` |

Record the final `https://PROJECT.pages.dev` URL. Set these production build variables, then deploy/redeploy:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
VITE_VAPID_PUBLIC_KEY=YOUR_VAPID_PUBLIC_KEY
VITE_APP_URL=https://PROJECT.pages.dev
```

All `VITE_` values are public browser configuration. Private VAPID, Google client and service-role secrets belong in Supabase, not these build variables. Changing these variables requires a new frontend build.

The existing deployment is the **Cloudflare Worker `carsiddur`**. Use the checked-in `wrangler.jsonc`, which enables `assets.not_found_handling = "single-page-application"`. Do not add `_redirects` rules to rewrite application routes to `index.html`: Workers' deployment validation rejects the previous rules as redirect loops. The native SPA fallback serves application navigation directly. For a separate Pages deployment, its default SPA behavior applies when there is no top-level `404.html`. Vercel deployments use `vercel.json`.

After redeploying, directly open and refresh `/my`, `/admin/members`, and `/p/TOKEN` in a private window, then check browser Back/Forward. These must load the application without a hosting 404, including before a service worker is installed. Avoid custom caching rules over the service worker or HTML. See [Pages SPA routing](https://developers.cloudflare.com/pages/configuration/serving-pages/) and [Workers SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).

## 5. Configure Google sign-in

1. Create a Google OAuth consent configuration and an OAuth client of type **Web application**.
2. Set the authorized JavaScript origin to `https://PROJECT.pages.dev`.
3. Set the authorized redirect URI to the callback shown in Supabase's Google provider settings, normally `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.
4. Paste the Google client ID and client secret into Supabase Authentication's Google provider and enable it.
5. In Supabase Auth URL Configuration, set the Site URL and allowed redirect URL to the final Pages site URL. The app redirects Google login to `VITE_APP_URL`.
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

## 8. Updates and backups

Frontend changes deploy through GitHub/Cloudflare. Database changes require a separate reviewed `supabase db push`; function changes require bundling and deploying the affected functions. Apply backward-compatible backend changes before frontend code that depends on them.

Free Supabase does not include automatic database backups. Schedule regular CLI database exports to protected off-site storage and test restoration. Follow Supabase's backup instructions for schema, data, roles and any separately stored files; a code repository is not a backup of live bookings.

## Free-plan limits and official references

- Supabase currently includes 500 MB database space, 50,000 monthly active users, 5 GB egress and 500,000 Edge Function invocations. Projects pause after one week of inactivity. This appears suitable for a small community rollout, but actual traffic, polling, audit growth and snapshots determine usage. Do not promise continuous availability on the free tier or rely on a keep-alive workaround. [Supabase pricing](https://supabase.com/pricing)
- Cloudflare Pages Free currently allows 500 builds/month. Check its other current limits before launch. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare Vite deployment and free Pages URL](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/)
- [Cloudflare SPA routing](https://developers.cloudflare.com/pages/configuration/serving-pages/)
- [Supabase Google OAuth setup](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase backup guidance](https://supabase.com/docs/guides/platform/backups)

## Recovery: `gen_random_bytes(integer) does not exist` during migration 0915

Some hosted projects use a migration connection search path that excludes the
`extensions` schema. Migration 0915 validates `generate_token()` before the
existing pgcrypto wrappers in migration 0918 have been installed.

1. Open `supabase/migrations/20260907091800_pgcrypto_public_wrappers.sql` locally and copy its entire contents.
2. In the target Supabase project's SQL Editor, open a new query, paste the SQL and run it as the default postgres role. This creates/replaces only the existing crypto wrappers; it does not reset tables or data.
3. Run `npx supabase db push` again. Completed migrations remain recorded and are skipped; 0915 is retried. Migration 0918 can safely run again because it uses `create or replace function` and repeatable grants.

Do not mark 0915 as applied manually or reset the cloud database to work around this error.


## Deploy the 2026-09-08 reliability fixes

Apply the four new migrations (admin member RPCs, status event enum, production notification templates/triggers, and week recovery) with `npx supabase db push` before redeploying the frontend. The new frontend calls the new admin and week RPCs. Do not import demo seed data. Notification templates now arrive through migrations and preserve existing customizations.

Missing current/upcoming weeks are recovered when an authorized member or admin loads their department, as well as by the regular cron tick. Existing closed or published weeks are preserved. A recovered week whose deadline has passed is solving; members can still submit late requests. Keep the `app_tick` cron job enabled for scheduled openings/reminders while nobody is using the app. Browser push still requires subscriptions and the push-dispatch credentials configured above; inbox notifications persist independently.

Redeploy the site with its matching hosting configuration. The checked-in Worker name is `carsiddur`, matching the existing deployment. Verify fresh direct URLs, an admin profile edit, ordinary-member roster assignment, signup approval notifications, and requests in both current and upcoming weeks on the hosted app.
