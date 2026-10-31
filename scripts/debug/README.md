# Debug copy of production

A local copy of production's data for reproducing and fixing problems inside a week
(`scripts/debug/debug.mjs`, `npm run debug -- <command>`). Production is only **read** — one
`pg_dump` of the `public` data and one `SELECT` (applied migrations, time of the pull). Everything
is written to the dedicated stack `carshare-debug`, never to the owner's stack (54321) or any other.

| What | Where |
|---|---|
| App | http://localhost:6073 |
| API | http://127.0.0.1:60731 |
| Database | `postgresql://postgres:postgres@127.0.0.1:60732/postgres` (container `supabase_db_carshare-debug`) |
| Studio | http://127.0.0.1:60733 |
| Reserved | 6073 and 60730–60739 |

Dumps and logins live in `.debug/` (gitignored). They hold member names and rides: never commit
them and never paste them into chat, issues or logs.

## Commands

```sh
npm run debug -- pull                      # dump production now → .debug/dumps/<YYYY-MM-DD_HHmm>/
npm run debug -- load                      # newest dump (pulls one if there is none): this week + next week
npm run debug -- load --week 2026-10-25    # one week (any day of it works; also this|next|prev)
npm run debug -- load --week this --with-previous   # a week and the one before it
npm run debug -- load --with-previous      # last week, this week, next week
npm run debug -- load --all                # every week, archived ones included
npm run debug -- load --dump .debug/dumps/2026-10-31_1957   # an older dump
npm run debug -- load --migrate            # …then apply this branch's newer migrations (test a fix)
npm run debug -- migrate                   # the same, on what is loaded now
npm run debug -- app                       # the app on :6073 against the debug copy
npm run debug -- login "אלי"               # a one-click sign-in link as that member (name or email)
npm run debug -- logins                    # everyone's local login
npm run debug -- status | stop
```

"This week" / "next week" are counted from the moment the dump was **pulled**, not from now, so an old
dump still loads the weeks it was taken for.

## What a load does

1. Copies `supabase/` into `.debug/stack` with project id `carshare-debug`, ports 6073x, the app URL on
   6073 and the seed turned off, keeping **only the migrations production has** (the dump records
   them). The checkout must contain all of them — check out the released code if production is ahead.
2. Starts the stack, or resets it (`db reset`), so the schema is exactly production's.
3. In one transaction with triggers and FK checks off (`session_replication_role = replica`): empties
   every `public` table (migrations seed catalogs), loads the dump, then drops the weeks not asked for.
   Rows pointing at a dropped row are fixed until nothing dangles: an optional one-column link is
   cleared (e.g. a template made from an older week's request), a required one deletes the row. The
   load prints what it cleared and deleted.
4. Strips secrets and anything that could reach the outside: push subscriptions and the push outbox
   are deleted, `app_secrets` is emptied, every `app_settings` `*_url` (edge-function endpoints) is
   blanked, car lockbox codes become `1234`/`5678`, invite emails/phones are replaced, proposal tokens
   become `debug:<id>` (no `/p/` link works). Names and all ride data stay.
5. Every member gets a local login: email `p-<first 8 of id>@debug.local`, password
   `debug-local-1234`, and a placeholder phone (else the app sends them to onboarding).
6. Pauses pg_cron, so weeks never change phase, nothing expires and no reminder goes out.

`--migrate` afterwards applies this branch's newer migrations, so "it fails on production's schema"
and "it works with my fix" are two separate steps.

## Signing in as someone

`npm run debug -- login <name>` prints a link; open it in a private window (or another browser
profile) to be that member — no Google. The dev sign-in form on the login page works too, with the
email from `logins` and the password above. Localhost only: a phone cannot reach 127.0.0.1.

## Not included

- Edge functions do not run on the debug stack (`answer-proposal`, `on-ride-cancelled`,
  `push-dispatch`, `destination-route`); their URLs are blanked, so the database never calls them.
- Realtime runs; Storage and the mail catcher do not.
- `auth` data is not copied — logins are rebuilt from `profiles`.
