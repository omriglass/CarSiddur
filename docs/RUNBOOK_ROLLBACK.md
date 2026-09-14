# Rollback runbook

What to do when a release (`npm run release`, see `scripts/release.mjs`)
turns out to be bad, once it has already gone live — i.e. the owner already
approved the `promote` job's `production` environment and Cloudflare rebuilt
the `carsiddur` Worker. If the bad tag hasn't been approved yet, the fix is
simpler: don't approve it, or use GitHub's "Reject" on the pending
deployment — no rollback below is needed.

Rules that apply throughout (CLAUDE.md hard rules 7/10, owner decisions
2026-09-14 #1–#4):

- The `production` branch is what Cloudflare builds from. Nothing here ever
  repoints Cloudflare or edits the GitHub `production` environment's
  settings — that's the owner's one-time setup (`docs/FREE_DEPLOYMENT.md`
  "One-time setup for the gated flow").
- Database changes are **forward-fix only**. A down script (`supabase/rollback/`)
  is the tested, narrow exception for a migration that could not avoid a
  destructive statement — not a casual undo button. A full restore from the
  pre-release backup is the last resort and loses data; say so explicitly
  before running it.
- Nothing in this document is run automatically. Every command below is
  typed by a human after reading the situation.

## Decision tree

```
Something is wrong after a release. What, exactly?

├─ Only the UI/behavior changed for the worse (a rendering bug, a broken
│  flow, a bad copy change) and the database schema is untouched or the new
│  columns/tables are additive and unused by the rolled-back frontend?
│  → Frontend-only rollback (below). Never touch the database for this.
│
├─ An edge function is throwing/erroring (push-dispatch, answer-proposal,
│  on-ride-cancelled, destination-route) and the frontend itself is fine?
│  → Edge function rollback (below).
│
├─ A migration broke something (a constraint fires incorrectly, an RPC
│  errors, RLS blocks a query that should succeed) and the frontend still
│  needs the pre-migration shape?
│  → Database rollback (below). Prefer a forward-fix migration; only run a
│    down script or a full restore if the situation truly demands it.
│
└─ Not sure? Start with the frontend rollback — it's the cheapest, safest,
   fully reversible step, and often you'll find the "bug" was actually a
   database-side issue that a frontend rollback doesn't fix, in which case
   you've lost nothing and can move to the database section next.
```

## Frontend

Two ways to move `production` (what Cloudflare builds) back to a known-good
state. Both are things a human runs by hand — neither goes through the
`promote` job, which is fast-forward-only and would refuse a rollback anyway.

**Option A — Cloudflare's own rollback** (fastest, no git involved):

```sh
npx wrangler rollback [deployment-id]
```

Requires `CLOUDFLARE_API_TOKEN` in the environment (or a prior `wrangler
login`). Without a `deployment-id`, Wrangler rolls back to the previous
deployment. Use this when the bad deploy was the *most recent* one and you
just want "back to what worked an hour ago" without deciding which git tag
that was.

**Option B — force the `production` branch back to a previous release tag**
(when you need `production` itself to reflect a specific earlier tag, e.g.
because another push has since landed on it, or you want git history to
match what's actually live):

```sh
git push --force origin <previous-good-tag>^{commit}:production
```

This is the one place a force-push to `production` is expected — the
`promote` job's fast-forward-only push is for the *normal* forward flow, not
recovery. Use Option A when you just need the last deployment reverted right
now; use Option B when you need `production` to durably point at a specific
earlier tagged commit (and are prepared for Cloudflare's next automatic build
of `production` to redeploy from there).

After either option, confirm: open the site, check the version footer on
`/profile` shows the expected (older) tag, and run the post-release smoke
checklist below.

## Edge functions

Roll back one function to the code at a previous tag and redeploy it — this
does not touch the frontend or the database:

```sh
git checkout <previous-good-tag> -- supabase/functions
npx supabase functions deploy <fn>   # push-dispatch | answer-proposal | on-ride-cancelled | destination-route
git checkout HEAD -- supabase/functions   # restore your working tree afterward
```

If `supabase/functions/_shared/solver.js` is part of what needs reverting
(a solver regression reaching `on-ride-cancelled`'s freed-slot matching),
check out that path too and redeploy every function that imports it — the
same "`_shared` changed ⇒ all four" rule `scripts/release.mjs` uses.

## Database

**Prefer a forward-fix.** Write a new migration that corrects the problem
(add back a column with the right default, fix a broken constraint, adjust
an RPC) and ship it the normal way (`npx supabase db push`). This is almost
always safer than reverting: it doesn't discard whatever real data has
already been written since the bad migration ran.

**Non-additive migration with a down script:** if the migration that caused
the problem shipped with a tested `supabase/rollback/<ts>_down.sql` (see
`supabase/rollback/README.md`), run it and tell the migration history it's
reverted:

```sh
psql "$DB_URL" -f supabase/rollback/<ts>_down.sql
npx supabase migration repair --status reverted <ts>
```

`$DB_URL` is the hosted project's connection string (Supabase dashboard →
Project Settings → Database). `migration repair --status reverted` updates
Supabase's migration-history table so a later `supabase db push` doesn't
think the migration is still applied.

**Last resort — full restore from the pre-release backup.** Only when the
above two options genuinely cannot fix it (e.g. the migration corrupted data
beyond what a down script's schema change can address). **This loses every
write made to the database between the backup and now** — every request,
ride, proposal, profile change, push subscription made in that window is
gone. State that loss explicitly to the owner before running it; get
confirmation. Steps (docs/FREE_DEPLOYMENT.md §8):

```sh
psql "$DB_URL" -f backups/schema-<ts>.sql
psql "$DB_URL" -f backups/data-<ts>.sql
# roles-<ts>.sql only if the fresh cluster is missing expected Postgres roles
```

Use the pre-release backup `npm run release` just took (step 4), or, if the
bad release is more than one release old, an older weekly export from Google
Drive (owner decision 2026-09-14 #3: pre-release dump + weekly, keep ~8).

## Post-release smoke checklist

Run this after any release **and** after any rollback above, to confirm the
live site matches what you expect:

- [ ] Sign in with a real account.
- [ ] Siddur page loads for the current week.
- [ ] Board loads for a Sadran account.
- [ ] Department statistics page loads.
- [ ] The version footer on `/profile` shows the tag you expect (the new
      release tag, or the previous tag if you just rolled back).
- [ ] Supabase → Edge Functions → Logs show no new errors for the four
      functions.
- [ ] `npx supabase migration list --linked` matches the migration history
      you expect (nothing pending, nothing unexpectedly reverted).
