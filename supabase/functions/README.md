# Edge Functions

Deno Edge Functions (ARCHITECTURE.md §3, §8). Supabase deploys only files under `supabase/functions/`, so the solver is
consumed through a build step (`npm run functions:bundle`, `scripts/bundle-solver.mjs`) rather than a relative import
into `src/`.

```
supabase/functions/
  _shared/
    cors.ts            shared CORS headers
    env.ts              env helpers, JSON responses, timing-safe compare, sha256
    supabaseAdmin.ts     service-role client factory, JWT verification helper
    rateLimit.ts         in-memory per-IP sliding-window limiter (answer-proposal)
    tz.ts                Asia/Jerusalem wall-clock <-> epoch-ms + week.days builder (on-ride-cancelled)
    solver.js             GENERATED — bundled src/solver, no external imports (do not hand-edit); the only
                          generated file — Edge Functions mirror the few solver types they need inline
  push-dispatch/index.ts
  answer-proposal/index.ts
  on-ride-cancelled/index.ts
  .env                  local secrets (gitignored) — see below
```

There is no `solve` Edge Function in this stage: it would mostly duplicate `on-ride-cancelled`'s
DB→SolverInput mapping code for a feature (server-side "auto-solve remaining" preview,
ARCHITECTURE.md §3 `solve` row) that isn't required for REQUIREMENTS §8 and isn't cheap to add
correctly (full week solve needs every request/car/pinned ride, not just one car's remaining
timeline) — noted here per the task instead of stubbed.

## What each function does

- **`push-dispatch`** — drains `push_outbox` via `web-push` (`npm:web-push`) using VAPID keys.
  Called by `push_outbox_notify_dispatch` (AFTER INSERT trigger) and `drain_push_outbox()`
  (`app.tick()`) via `pg_net`, both with `{ outbox_id }` and header `x-cron-secret`; also accepts
  `{ notificationIds: string[] }` (admin flush, requires either the same header or a bearer JWT of
  an `is_admin` profile) or an empty body (pulls every due `pending`/`failed` row itself, bounded to
  200). Marks rows `sent`/`failed` with the same 1/5/15/60-minute backoff as `drain_push_outbox()`;
  deletes the subscription on HTTP 404/410.
- **`answer-proposal`** — public, `verify_jwt = false` (the token is the credential, ARCHITECTURE §8).
  `GET ?token=` returns a summary (what changes, expiry, parties by name only, never phones).
  `POST { token, answer: 'accepted'|'declined', note? }` calls `answer_proposal()` with the service
  role (`via: 'session'` instead of `'token'` if the request also carries a verified user JWT).
  Rate-limited per IP (30 req/min, in-memory).
- **`on-ride-cancelled`** — called by `cancel_ride()` via `pg_net` with `{ offer_id }` and header
  `x-cron-secret` (rejects anything else). Loads the offer + `freed_slot_candidates()`, builds a
  `SolverInput`-compatible structure (this car's remaining-week timeline, the department's active
  policy, a fairness-history proxy — see the function's own comment for why it isn't the
  `fairness_stats()` RPC), ranks with the bundled solver's `matchFreedSlot()`, and hands the ranked
  list to `resolve_freed_offer()`, which does the actual writes (0 candidates → closed; 1 → assign +
  notify; >1 → notify all + Sadran contest — REQUIREMENTS §8). `enqueue_notification` is called by
  that RPC, not by this function.

## How the DB invokes them

Both hooks already exist in the migrations that predate this stage:

- `dispatch_push_outbox_row()` (`20260907091200_notifications.sql`, updated by
  `20260907092100_secure_app_settings.sql`) reads `app_settings.push_dispatch_url` /
  `app_secrets.cron_secret` and `net.http_post`s a no-op if `push_dispatch_url` is unset —
  safe by default for `db reset`/tests.
- `cancel_ride()` (`20260907091500_rpc.sql`, same update) does the same for
  `app_settings.on_ride_cancelled_url` / `app_secrets.cron_secret`.

The secret and the URLs live in two different tables on purpose (DATA_MODEL.md §6.1 item
12): `app_settings`' SELECT policy is `is_approved()` (any approved member can read it via
PostgREST — fine for a URL, not for a shared header value), while `app_secrets` has RLS
enabled and forced with **no policies at all**, so only `service_role` and `SECURITY
DEFINER` functions (like the two above) can ever read `cron_secret`. Neither table's row is
seeded (`seed.sql` is out of this stage's write scope), so local testing needs one manual
SQL step (below) to point them at the local edge runtime.

## Env vars

| Var | Used by | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | all | injected automatically by `supabase start`/`functions serve`; **reserved** — do not set in `.env`, the CLI skips them with a warning |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | push-dispatch | `npx web-push generate-vapid-keys`; subject is a `mailto:` or `https://` URL |
| `CRON_SECRET` | push-dispatch, on-ride-cancelled | shared `x-cron-secret` header value; must match `app_secrets.cron_secret` (not `app_settings` — DATA_MODEL.md §6.1 item 12) |

Local: `supabase/functions/.env` (gitignored by the root `.env`/`.env.*` patterns — no `.gitignore`
change was needed). Production: `npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=... CRON_SECRET=...` (never commit real values).

## Local verification

```bash
npm run db:start                 # or npm run db:reset for a clean seeded DB
npm run functions:bundle         # bundles src/solver -> _shared/solver.js, runs the Node smoke test
npx web-push generate-vapid-keys # paste the two keys into supabase/functions/.env
npx supabase functions serve --env-file supabase/functions/.env
```

Wire the `app_settings` URLs and the `app_secrets` secret so `cancel_ride()`/
`dispatch_push_outbox_row()` actually reach the local edge runtime (pg_net runs inside the
`supabase_db_<project>` container, so the URL must be a docker-network address, not
`127.0.0.1`; the Kong container is the reliable one — calling the `edge-runtime` container
directly returned `503 Worker failed to boot` in testing):

```bash
docker exec -i "$(docker ps --format '{{.Names}}' | grep '^supabase_db_')" \
  psql -U postgres -d postgres <<'SQL'
insert into public.app_settings (key, value) values
  ('on_ride_cancelled_url', '{"value":"http://supabase_kong_carshare-nevo:8000/functions/v1/on-ride-cancelled"}'::jsonb),
  ('push_dispatch_url',     '{"value":"http://supabase_kong_carshare-nevo:8000/functions/v1/push-dispatch"}'::jsonb)
on conflict (key) do update set value = excluded.value;
insert into public.app_secrets (key, value) values
  ('cron_secret', '{"value":"local-dev-cron-secret-change-me"}'::jsonb)
on conflict (key) do update set value = excluded.value;
SQL
```

(`local-dev-cron-secret-change-me` must match `CRON_SECRET` in `supabase/functions/.env`.)

Get local keys any time with `npx supabase status -o env` (or `npx supabase status` for the plain
JSON block — this doc's examples use the fixed local demo `ANON_KEY`/`SERVICE_ROLE_KEY`, which are
the same every `db reset` since the JWT secret is fixed in `config.toml`).

### push-dispatch

```bash
ANON_KEY=<local anon key>
SERVICE_KEY=<local service role key>

# Cron path: a real push_outbox row (see DATA_MODEL §3.11 for the table shape) —
# insert one via psql, then:
curl -X POST http://127.0.0.1:54321/functions/v1/push-dispatch \
  -H "Content-Type: application/json" -H "x-cron-secret: local-dev-cron-secret-change-me" \
  -d '{"outbox_id": 1}'
# => {"dispatched":1,"sent":0 or 1,"failed":0 or 1,"dead":0}

# Admin flush (no cron secret, a real admin session instead):
RESP=$(curl -s -X POST "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"admin@nevo.local","password":"nevo-demo-1234"}')
TOKEN=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -X POST http://127.0.0.1:54321/functions/v1/push-dispatch \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{}'
# => {"dispatched":<n>,...} — pulls every due pending/failed row
```

Verified in this stage: unauthorized request → `401 not_authorized`; a row with a well-formed but
undeliverable subscription → `failed` with `last_error` set and the same 1/5/15/60 backoff written to
`next_attempt_at`; the admin-JWT path dispatches successfully for `admin@nevo.local` (seed's
`is_admin = true` profile).

### answer-proposal

Create a real proposal as the seeded Sadran first (there is none in `seed.sql` — out of this
stage's write scope):

```bash
SADRAN_TOKEN=$(curl -s -X POST "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"sadran@nevo.local","password":"nevo-demo-1234"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

PROP_ID=$(curl -s -X POST "http://127.0.0.1:54321/rest/v1/rpc/create_proposal" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $SADRAN_TOKEN" -H "Content-Type: application/json" \
  -d '{"p_request_id":"00000000-0000-0000-0000-000000000211","p_ride_id":null,"p_type":"shift",
       "p_payload":{"depart_at":"2026-09-15T08:30:00+00:00","return_at":"2026-09-15T16:30:00+00:00"},
       "p_reason_he":"בדיקה","p_party_profile_ids":[]}' | tr -d '"')

TOKEN=$(curl -s -X POST "http://127.0.0.1:54321/rest/v1/rpc/send_proposal" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $SADRAN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"p_proposal_id\":\"$PROP_ID\",\"p_sent_via\":[\"whatsapp\"]}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['proposal_token'])")

curl "http://127.0.0.1:54321/functions/v1/answer-proposal?token=$TOKEN"
# => {"proposalId":"...","type":"shift","status":"sent","reasonHe":"בדיקה",
#     "expiresAt":"...","payload":{...},"request":{...},"parties":[{"profileId":"...",
#     "fullName":"חבר ראשון","response":"pending","isYou":true}]}

curl -X POST http://127.0.0.1:54321/functions/v1/answer-proposal \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"answer\":\"accepted\",\"note\":\"בדיקה\"}"
# => {"accepted":true,"proposal_id":"..."}
```

Verified in this stage: GET on an unknown token → `404 invalid_token`; GET/POST rate-limited at
30 req/min per IP → `429 rate_limited`; a correct token accepts, records `answered_via = 'token'`,
and (department default `auto_apply_accepted_proposals = true`, single-party proposal) auto-applies
— the request's `depart_at`/`return_at`/`status` update in the same call.

### on-ride-cancelled

```bash
MEMBER_TOKEN=$(curl -s -X POST "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"member1@nevo.local","password":"nevo-demo-1234"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# Cancelling the seeded live-week ride 00000000-0000-0000-0000-000000000301 (car "יונדאי 1")
# opens a freed_slot_offers row and pg_net fires on-ride-cancelled automatically once the
# app_settings/app_secrets rows above are set:
curl -X POST "http://127.0.0.1:54321/rest/v1/rpc/cancel_ride" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MEMBER_TOKEN" -H "Content-Type: application/json" \
  -d '{"p_ride_id":"00000000-0000-0000-0000-000000000301","p_reason":"CANCELLED_BY_MEMBER","p_expected_version":null}'

# Manual invocation (e.g. to retry, or if app_settings/app_secrets isn't wired):
curl -X POST http://127.0.0.1:54321/functions/v1/on-ride-cancelled \
  -H "Content-Type: application/json" -H "x-cron-secret: local-dev-cron-secret-change-me" \
  -d '{"offer_id": "<freed_slot_offers.id>"}'
# => {"offerId":"...","outcome":"closed"|"auto_assigned"|"pending_approval","candidates":<n>,"ranked":[...]}
```

Verified in this stage, seeding extra `waitlisted` requests to exercise each branch: 0 matching
candidates → offer `closed`; exactly 1 → `resolve_freed_offer` creates the ride, sets the request
`assigned`/`FREED_SLOT_AUTO`, and enqueues `freed_slot_auto`; 2 candidates → offer
`pending_approval`, one `freed_slot_claims` row `offered` per candidate. Also confirmed unauthorized
(missing/wrong `x-cron-secret`) → `401`, and that pg_net reaching the Kong container from inside
Postgres (`http://supabase_kong_<project>:8000/functions/v1/...`) works where reaching the
`edge-runtime` container directly on port 8081 does not (see the `app_settings`/`app_secrets` step above).

## Deploy

```bash
npm run functions:bundle                              # regenerate _shared/solver.js first
npx supabase functions deploy push-dispatch
npx supabase functions deploy answer-proposal
npx supabase functions deploy on-ride-cancelled
npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=... CRON_SECRET=...
```

After deploying, an admin sets `app_settings.push_dispatch_url` / `on_ride_cancelled_url` to the
project's real `https://<ref>.functions.supabase.co/<name>` URLs (or the `.../functions/v1/<name>`
form) and `app_secrets.cron_secret` (not `app_settings` — see DATA_MODEL.md §6.1 item 12) to the
same value as the `CRON_SECRET` secret.

## Not verified locally (and why)

- **Real Web Push delivery** (an actual browser/service-worker receiving a notification) — needs a
  real, non-fake `push_subscriptions` row from a browser's Push API subscription; only the
  request/response plumbing (auth, batching, backoff, 404/410 pruning) was exercised, against a
  syntactically-shaped but fake subscription.
- **`push-dispatch`'s automatic trigger firing** (`push_outbox_notify_dispatch`) — works the same way
  as `on-ride-cancelled`'s pg_net call (same `dispatch_push_outbox_row()` mechanism, same
  `app_settings.push_dispatch_url`), which *was* verified indirectly by wiring the setting and
  observing `net._http_response`, but no test in this stage produced a push_outbox row through
  `enqueue_notification()` itself (would need a real notification-triggering RPC call rather than a
  direct INSERT).
- **`npx supabase functions deploy`** (an actual remote project) — no project is linked in this
  environment; only local `functions serve` was exercised.

## Destination route estimates

`destination-route` accepts `POST { department_id, destination_id }` with a signed-in user's bearer token. It verifies the token using Supabase Auth, checks `can_manage_operations(department_id)` under that user's JWT, and reads only destinations belonging to that department. It uses the department's configured home destination as origin. Coordinates take precedence over destination names; name-based addresses use the Israel region. It returns `{ distance_km, travel_minutes }` for review without writing to the database. Distances round to 0.1 km, time rounds up to whole minutes. This is a traffic-unaware driving estimate, not a live traffic promise.

Configure `GOOGLE_MAPS_API_KEY` in Supabase Edge Function secrets and deploy `destination-route`. Enable Google Routes API for that key's Google Cloud project. Never put the key in `VITE_*` variables. Missing credentials return `maps_not_configured`; manual catalog entry continues to work. Other error codes include `home_not_configured`, `destination_not_found`, `not_authorized`, `route_not_found`, and `maps_request_failed`; responses never expose upstream error bodies or secrets.

Implementation follows [Google's computeRoutes reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes): POST to `directions/v2:computeRoutes` with an explicit `routes.distanceMeters,routes.duration` field mask. Local tests inject mock authentication, catalog reads, and HTTP responses and make no billable Google requests.
