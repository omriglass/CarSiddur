# WhatsApp bot — research and proposal (2026-09-10)

Status: **research only, nothing implemented.** Owner decision pending. If adopted, `REQUIREMENTS.md` changes first (it currently lists "WhatsApp API" as out of scope, line ~339), then the other docs.

Goal as stated by the owner: members should be able to (1) file ride requests from WhatsApp and have the bot post the real request, (2) retrieve information ("which car am I taking tomorrow?"), (3) run simple predefined tasks, and (4) lower priority, receive notifications.

---

## 0. Executive summary

**Feasible, cheap, and fits the existing architecture.** Recommended shape:

| Decision | Recommendation | Why |
|---|---|---|
| Channel provider | **Meta WhatsApp Cloud API directly**, no BSP (Twilio/360dialog/Wati…) | Meta charges no platform fee; BSPs add €49+/month or a per-message markup. No App Review is needed for a first-party bot on your own number. |
| Alternative channels | Telegram is technically free and easier, but the community lives on WhatsApp. Unofficial libraries (Baileys, whatsapp-web.js) are ToS violations with real ban risk. **Not recommended.** | |
| Hosting | One new Supabase Edge Function `whatsapp-webhook` (Deno), `verify_jwt = false`, same `_shared` helpers as `answer-proposal` | No new infrastructure, free tier suffices (500K invocations/month). |
| Identity | Match the WhatsApp sender id (E.164 digits) to `profiles.phone` (already E.164, already required for approval). Unknown numbers get a "add your phone in the app" reply. | Meta authenticates the sender's number; the app already trusts `profiles.phone` for proposal links. |
| Acting as the member | One `security definer` wrapper RPC callable only by `service_role` that impersonates the member for the transaction (`set_config('request.jwt.claims', …, true)`) and then calls the **existing** `submit_request`, `withdraw_request`, etc. unchanged | Zero new authorization logic; RLS and every `auth.uid()` check behave exactly like a browser session. No JWT minting (fragile under Supabase's asymmetric-key migration), no parallel "actor id" RPC surface. |
| Interaction model | **Menu-first** (list messages, reply buttons, and a WhatsApp Flow form for the request), with an **optional free-text parser** (rule-based first; Claude API as an upgrade) that always ends in a confirmation card | Predictable, testable, no LLM cost by default; free text is additive. |
| Hebrew copy | New seeded, admin-editable table `bot_copy` (or `notification_templates` rows with `channel='whatsapp'`), never inline in the edge function | Hard rule 3. |
| Notifications (phase 3) | `whatsapp_outbox` fed by `enqueue_notification`, delivered by the same edge function with **approved utility templates**; requires an opt-in checkbox stored on the profile | Business-initiated messages need Meta-approved templates and user opt-in. |
| Cost | Today: inbound + replies are free. **From 1 Oct 2026 Meta charges for replies inside the 24h window too**, at the utility rate (Israel ≈ $0.005–0.008/message). Realistic total for ~300 members: **$5–40/month** depending on volume and on whether the reported 1,000 free replies/number/month materializes. | See §2.4. |

Biggest open risks: (a) **Hebrew/RTL rendering inside WhatsApp Flows is undocumented** — prototype before committing to Flows; (b) the **October 2026 pricing change** lands three weeks from now and its free-allowance detail is not confirmed on Meta's page; (c) Meta onboarding needs a **dedicated phone number** and a Meta Business Portfolio for the kibbutz entity.

---

## 1. What the bot would do (proposed task list)

Everything below maps onto an existing RPC or view; the bot adds no business logic.

| # | Task (Hebrew menu item) | Backend call | Phase |
|---|---|---|---|
| 1 | Main menu / help | — | 1 |
| 2 | **My rides** — "which car am I taking tomorrow / this week?" | new `my_upcoming_rides()` RPC (see §3.5) | 1 |
| 3 | **My requests** and their status | mirror `fetchMyRequests` (`requests` filtered by `requester_id`) | 1 |
| 4 | **New request** (round trip, one week ahead): day → depart → return → destination → passengers → confirm | `submit_request(payload)` | 1 |
| 5 | Withdraw a request / cancel my ride | `withdraw_request`, `cancel_ride` | 1 |
| 6 | Free-text request: "מחר 9-13 לחיפה" → parsed → confirmation card → task 4 | parser + `submit_request` | 2 |
| 7 | Quick one-way / "car now" (live week) | `submit_request` with `trip_shape`, `reserve_missing_driver` | 2 |
| 8 | Answer a proposal in-chat (accept / decline buttons) | `answer_proposal(p_token, …)` via the existing token | 2 |
| 9 | Ask to join a published ride | `submit_request` with `join_ride_id` | 2 |
| 10 | Who is the Sadran this week / contact | `sadran_contact_of` | 1 |
| 11 | Outbound notifications (assignment, publish, proposal, reminders) | `enqueue_notification` → `whatsapp_outbox` | 3 |

Out of scope for the bot: Sadran board operations, admin tasks, anything with drag/drop semantics. The Sadran keeps the app.

---

## 2. WhatsApp Business Platform facts (verified 2026-09-10)

### 2.1 Onboarding

- Needs: Meta Business Portfolio → Meta App with the WhatsApp product → WhatsApp Business Account (WABA) → a **business phone number**. Sources: [Meta WABA docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/whatsapp-business-accounts), [Meta access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/).
- **Phone number**: a number active in the consumer WhatsApp app must be deregistered first (Meta's "Coexistence" mode is a newer exception). Landlines work via voice OTP. Consumer VoIP numbers are often rejected. **Use a real SIM or a landline**, not a virtual number. Israeli numbers are a standard market.
- **No App Review** for a first-party bot: Meta's App Review page states that a Direct Developer using the API for their own business does not need Advanced Access or App Review ([source](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)). Use a System User permanent token.
- **Business verification is optional at launch.** Unverified: up to **250 unique recipients per rolling 24h** for business-initiated messages, 2 numbers, 250 templates. Verified: 1,000/day, auto-escalating. Replying to inbound messages within the 24h window is not limited by this. For 100–400 members, 250/day covers phase 1–2 entirely and probably phase 3 too. Verification for a kibbutz/amuta: registration certificate + address doc; common rejection causes are legal-name mismatch, no public web presence, and a Gmail contact address.
- **Test number** in the developer console: unlimited messages to at most **5 verified recipients**. Good for development, useless for rollout.
- **Display name approval** is a separate short review when registering the number.

### 2.2 Messaging capabilities that matter for the design

| Feature | Limit / note |
|---|---|
| Reply buttons | max **3** per message |
| List message | max **10 rows** total (across sections) — enough for 7 weekdays + 3 actions, or a destination shortlist |
| WhatsApp Flows (in-chat forms) | components: TextInput, TextArea, **DatePicker/CalendarPicker**, Dropdown (200 options), RadioButtons (20), Checkbox (20), OptIn. Can be sent as a **non-template interactive message inside the 24h window without template approval** ([Meta: sending a Flow](https://developers.facebook.com/docs/whatsapp/flows/guides/sendingaflow)); a Flow attached to a template (for outbound use) needs template approval. **RTL/Hebrew behaviour undocumented → prototype.** |
| Location messages | can request the user's location; not needed (destinations are a catalogue). |
| Typing indicator / read receipt | available; use only while an LLM call is in flight. |
| Free-form text | only inside the 24h customer-service window opened by the user's message. |
| Templates | required for business-initiated messages; approval usually minutes to 48h; categories Marketing / Utility / Authentication — ours are Utility. |
| Throughput | 80 msg/s default; irrelevant at our scale. |

### 2.3 Policy

- A **structured, purpose-specific bot is explicitly allowed**. Meta's 2026 ban covers only general-purpose, open-ended AI assistants (all WABAs since 15 Jan 2026). If an LLM is used as a parsing layer, disclose "automated system" in the first message and always offer a path to a human (the Sadran). Sources: [respond.io](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban), [turn.io](https://learn.turn.io/l/en/article/khmn56xu3a-whats-app-s-2026-ai-policy-explained).
- **Opt-in** is required for business-initiated (notification) messages: collected outside WhatsApp (our onboarding/profile screen), naming the sender and the message type, revocable. Not needed for replying to a member who wrote to the bot.
- Unofficial clients (Baileys, whatsapp-web.js) violate the ToS; ban waves are documented. Not an option.

### 2.4 Pricing

Model since 1 Jul 2025: **per delivered template message**, by category and recipient country ([Meta pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)).

What is free **today** (until 30 Sep 2026): all non-template replies inside the 24h window, and utility templates inside the window.

**Confirmed on Meta's page** ([non-template pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages)): *"Effective October 1, 2026, Meta will charge for service messages"* and for utility messages sent inside the window, per message, at the market's utility/authentication rate, with no volume tiers. **Not confirmed on Meta's page**: several BSP blogs (respond.io, SendPulse, PickyAssist) report **1,000 free service messages per business phone number per month**; Wati's blog says there is no free allowance. Treat the allowance as unknown until Meta's rate card is re-read after 1 Oct 2026.

Israel rates (USD per delivered message):

| Category | whale.co.il (Aug 2026, cites Meta card) | "Rest of world" bucket (chatmaxima, Jul 2026) |
|---|---|---|
| Utility / Authentication / Service (from Oct) | 0.0053 | 0.0077 |
| Marketing | 0.0353 | 0.0604 |

Single-sourced; confirm on the interactive rate card at business.whatsapp.com/products/platform-pricing before budgeting.

Worked estimates (300 members):

| Scenario | Messages / month | Cost / month |
|---|---|---|
| Phase 1–2 only: ~4 bot replies per member per week | ~5,200 | $0 today; **$28–40 from Oct 2026**, or $22–32 if 1,000 are free |
| Phase 3 notifications: 3 utility templates per member per week | ~3,900 | **$21–30** |
| Both | ~9,100 | **$45–70** worst case |

Levers: a lighter menu (fewer bot turns per task), sending notifications only for events without push delivery, and keeping the PWA push channel as primary. The web push channel stays free.

### 2.5 Alternatives compared

| Option | Monthly cost at our scale | Verdict |
|---|---|---|
| Meta Cloud API direct | Meta per-message only | **Recommended** |
| Kapso (BSP) | free tier: 2,000 msgs/month, 1 number | fallback if we do not want to own template management |
| respond.io | free tier, then $99 | inbox UI we do not need |
| 360dialog | €49–249 + Meta | too expensive |
| Wati / Gupshup | $49+ / markup | no |
| Twilio sandbox | free but join code, 72h re-join, no templates | dev only; production adds Twilio fee |
| Telegram Bot API | $0, no approvals, rich keyboards | technically best, wrong community |

### 2.6 Webhook mechanics

- Registration: Meta sends `GET ?hub.mode&hub.verify_token&hub.challenge`; respond `200` with the raw challenge string.
- Events: `POST` with `entry[].changes[].value.messages[]` (types `text`, `interactive` with `button_reply`/`list_reply`, `nfm_reply` for Flow responses) and `statuses[]` (delivery receipts). Header `X-Hub-Signature-256: sha256=<hmac of raw body with App Secret>` — verify over the raw bytes with `crypto.subtle`, constant-time.
- Retries: non-200 or unreachable → Meta retries with decreasing frequency for up to 7 days ([Meta webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks)); the same `message.id` can arrive twice → **dedupe on message id**.
- Respond fast; do the work after via `EdgeRuntime.waitUntil` (free plan: 2s CPU, 150s wall clock).

---

## 3. Fit with carshare-nevo

### 3.1 What exists today

- WhatsApp is **manual and outbound-only**: `src/features/sadran/proposals/waLink.ts` builds `wa.me` links; `WhatsappDialog` lets the Sadran edit and tap-to-send; `/p/:token` has a "talk to the Sadran" link. `notification_templates` has 7 `channel='whatsapp'` rows that only the composer reads; `enqueue_notification` never touches that channel. `ARCHITECTURE.md` §9 says so explicitly.
- `REQUIREMENTS.md` lists "WhatsApp API" as out of scope (cost). This proposal reverses that on the strength of §2.4.

### 3.2 Identity: phone ↔ profile

- `profiles.phone` is E.164 (`^\+[1-9][0-9]{7,14}$`), required before approval (invariant 14), column-privilege-restricted (`phone_of()`), normalized client-side from Israeli `05x` formats. WhatsApp's `wa_id` is the same number without `+`. Lookup: `where phone = '+' || wa_id`; add a unique index on `profiles.phone` (check for duplicates first; an admin can set phones via `admin_update_member`).
- Trust model: Meta verifies possession of the number; the app already sends proposal tokens to that number. Reusing it for a bot session is equivalent trust. Residual risk: a member changes numbers and the old number is reassigned. Mitigations: (a) phase 1 keeps the bot to reads and the member's own requests; (b) optional one-time **link code** shown in the app profile and typed into WhatsApp once, storing `profiles.whatsapp_linked_at`; recommended for phase 2+ writes.
- Unmatched number → reply with a fixed text pointing to the app's profile screen (Hebrew from `bot_copy`).

### 3.3 Acting as the member from the edge function

Options considered (details in the research notes of 2026-09-10):

| Option | Verdict |
|---|---|
| Mint an HS256 user JWT with the legacy JWT secret | Works only until the project rotates to asymmetric signing keys and revokes the legacy secret; not durable. |
| Service role + new RPCs taking an `actor uuid` | Duplicates every RPC's authorization; `submit_request` compares `auth.uid()` in several places (`v_requester_id <> v_actor`, `is_approved()`), so a bare service-role call with null actor is rejected by `is_approved()` and would need a parallel code path. |
| **Impersonation wrapper** `bot_call(p_phone text, p_fn text, p_args jsonb)` (`security definer`, raises unless `auth.role() = 'service_role'`), which does `perform set_config('request.jwt.claims', jsonb_build_object('sub', profile_id, 'role','authenticated')::text, true)` and `set_config('request.jwt.claim.sub', …, true)`, then calls the whitelisted existing RPC in the same transaction | **Recommended.** `auth.uid()` (which reads exactly those settings) resolves to the member; RLS and every check behave as in the browser; settings are transaction-local so nothing leaks across pooled connections. Whitelist the callable functions explicitly; never `execute` arbitrary names. |

The edge function keeps the service-role key (never the browser, hard rule 4) and calls `bot_call` only. Rate-limit per phone (reuse `checkRateLimit` from `answer-proposal`).

### 3.4 New schema (phase 1)

| Object | Purpose |
|---|---|
| `bot_sessions (phone pk, profile_id, department_id, state text, data jsonb, expires_at, updated_at)` | conversation state machine, one row per phone; swept by `housekeeping()` (`app.tick()`), TTL ~30 min |
| `bot_inbound (wa_message_id pk, phone, received_at, payload jsonb)` | idempotency (`on conflict do nothing`) + audit; short retention |
| `bot_copy (key pk, text_he, updated_at)` seeded | all bot Hebrew strings, admin-editable (hard rule 3) |
| `profiles.whatsapp_linked_at`, `profiles.whatsapp_opt_in_at` | link confirmation (phase 2) and notification opt-in (phase 3) |
| `bot_call(...)` RPC | §3.3 |
| `app_settings.whatsapp_*` | phone number id, WABA id, verify token name (secrets themselves live in edge-function secrets) |

RLS: `bot_*` tables have no `authenticated` policies except admin read of `bot_copy`/`bot_inbound` for debugging; all writes via the service role from the edge function. `rls_smoke.sql` rules still hold (forced RLS, per-command policies).

### 3.5 Read paths

- "Which car tomorrow?": today the Home screen composes this client-side (`fetchMyUpcomingRides`: `ride_requests` → `rides` → `v_board_rides` → `cars`). Add a SQL RPC `my_upcoming_rides(p_from timestamptz, p_to timestamptz)` returning ride, car name, driver, times, and use it from **both** the app and the bot. This also closes the noted `v_my_requests` visibility gap in `src/features/requests/api.ts`.
- "Tomorrow" is computed in SQL with `at time zone 'Asia/Jerusalem'` (hard rule 6); weekday letters come from `weekday_labels`.
- Department: the member's `default_department_id`, or a list-message choice if they belong to several.

### 3.6 Request flow (phase 1, menu-driven)

Two implementations to prototype; pick after the Hebrew/RTL test:

1. **WhatsApp Flow form** (one screen: date picker limited to the open week, depart/return dropdowns in 15-minute steps, destination dropdown from `destinations`, adults/child seats/boosters, notes). Sent as an interactive `flow` message inside the window, no template approval. Response arrives as `nfm_reply` JSON → mapped to the `submit_request` payload → confirmation with the `warnings` and `is_late` returned by the RPC.
2. **Step-by-step lists** (day list → depart time list → return time list → destination list top-9 + "other" → seats buttons → confirm buttons). Robust, no Flow dependency, more turns (cost after Oct 2026).

Validation stays in `submit_request`; SQLSTATE errors map to `bot_copy` texts the same way `toAppError()` maps them to `he.errors.*`.

### 3.7 Free-text parsing (phase 2)

- **Rule-based first**: Hebrew relative days (מחר, מחרתיים, יום א׳…ש׳, weekday names), time ranges (`9-13`, `9:00 עד 13:00`), destination via `destinations.name`/aliases, passenger counts. Deterministic, no cost, testable with Vitest. Always ends in a confirmation card with buttons; nothing is filed without a tap.
- **LLM layer (optional)**: Claude API from the edge function (`npm:@anthropic-ai/sdk` or `fetch`) with a strict tool schema (`file_request`, `show_rides`, `withdraw`, `unknown`) so output is structured, not prose. Default per the project's API skill is `claude-opus-5`; a cheaper model is the owner's call.

| Model | Approx. cost per parsed message (~1.5K in / 150 out tokens) | 2,000 parses / month |
|---|---|---|
| claude-opus-5 ($5 / $25 per MTok) | ~$0.011 | ~$22 |
| claude-sonnet-5 ($2 / $10) | ~$0.0045 | ~$9 |
| claude-haiku-4-5 ($1 / $5) | ~$0.002 | ~$4.50 |

Prompt caching on the fixed system prompt cuts input cost further. Policy note: disclose automation in the greeting and keep the Sadran contact one tap away.

### 3.7a How the LLM layer would be applied (added 2026-09-10)

**Principle: the model extracts, the code decides.** The LLM never calls the database and never composes the reply. It turns one Hebrew message into a typed intent object; everything after that is the same deterministic path the menu uses (validation in `submit_request`, confirmation card, `bot_copy` texts).

Pipeline for a free-text inbound message:

1. Webhook verifies, dedupes, resolves the member, returns 200; the rest runs in `EdgeRuntime.waitUntil`.
2. **Cheap pre-checks first**: button/list/Flow replies and the rule-based parser handle what they can with no model call. Only unparsed text goes to the model.
3. **One `messages.parse` call** with a zod schema (`output_config.format`) so the result is always valid JSON, never prose. Intent union: `file_request`, `show_rides`, `show_requests`, `withdraw`, `contact_sadran`, `unclear`. Each field that the model cannot resolve is `null`; an `unclear` intent carries one short clarifying question.
4. **Context in the prompt, not knowledge in the model**: today's date and weekday in Asia/Jerusalem, the open week's date range, the member's default seats, and the department's destination names and aliases (id + name) so the model returns a `destination_id` or `destination_text`, never a guess. Resolution of "מחר" into a date is done in code from the model's relative output (`day_offset`/`weekday`), keeping hard rule 6 in one place.
5. **Confirmation gate**: the extracted request is rendered as a card with accept/edit buttons. Nothing is filed without a tap. Missing slots fall back into the menu flow at the missing step.
6. **Failure modes**: API error, timeout (>8s), `stop_reason` other than `end_turn`, or `parsed_output === null` → reply with the menu. The feature sits behind `app_settings.bot_llm_enabled`.

Request shape (Deno, `npm:@anthropic-ai/sdk`):

```ts
const response = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 1024,
  thinking: { type: "adaptive" },
  output_config: { effort: "low", format: zodOutputFormat(BotIntentSchema) },
  system: [
    { type: "text", text: STABLE_INSTRUCTIONS },                       // frozen
    { type: "text", text: destinationsCatalogue(dept), cache_control: { type: "ephemeral", ttl: "1h" } },
  ],
  messages: [{ role: "user", content: `${todayBlock}\n\n${memberText}` }], // volatile part last
});
```

Cost levers: the catalogue and instructions are cached (one write per hour, reads at ~10%); the volatile date block lives in the user turn so it never invalidates the cache; `effort: "low"` keeps thinking short for extraction. Model choice is the owner's call (table in §3.7).

Policy: the greeting from `bot_copy` states the bot is automated, and every menu has the Sadran contact. The model sees only the member's own message plus catalogue data; no other members' data enters the prompt.

Testing: collect real inbound messages (anonymized) into an eval set of message → expected intent; run it in Vitest against a recorded fixture for unit tests and against the live API on demand (`/claude-api build-eval`). Track the rule-based parser's hit rate to decide whether the model layer earns its cost.

### 3.8 Notifications (phase 3, lowest priority)

- `enqueue_notification` gains a branch: if the recipient has `whatsapp_opt_in_at` and a `channel='whatsapp'` template exists for the event, insert a `whatsapp_outbox` row (mirror of `push_outbox`: status, attempts, backoff). `drain_whatsapp_outbox()` joins `app.tick()`; delivery via the edge function with `x-cron-secret`, like `push-dispatch`.
- Templates must be **pre-approved by Meta** per event/variant; Hebrew body with `{{1}}`… placeholders; category Utility. Our 24 events → start with `ride_assigned`, `week_published`, `proposal_received` (with accept/decline buttons that hit `answer_proposal` via the existing token), `ride_reminder`.
- Cost per §2.4; consider WhatsApp only for members without an active push subscription.
- The existing `notification_templates` `{{link}}` CHECK on whatsapp rows and the manual composer keep working unchanged.

### 3.9 Docs and rules impact

- `REQUIREMENTS.md`: remove "WhatsApp API" from out-of-scope; add §"WhatsApp bot" with the task list, identity rule, opt-in, and the "bot never decides" principle (it files requests; the Sadran still solves).
- `ARCHITECTURE.md` §8/§9: new edge function, `bot_call` impersonation, outbox channel. `DATA_MODEL.md`: tables above, RLS matrix rows. `UX_FLOWS.md`: conversation scripts as the canonical Hebrew copy, mirrored in `bot_copy` seed.
- CLAUDE.md hard rule 3 gains a fourth Hebrew location (`bot_copy`), or we fold bot strings into `notification_templates` with `channel='whatsapp'` and new `variant` values to avoid a fourth place. Owner's call; the second option keeps the rule intact.
- Solver untouched.

---

## 4. Phased plan and effort

| Phase | Scope | Est. effort | Prereqs |
|---|---|---|---|
| 0 | Meta setup: Business Portfolio, app, WABA, number, System User token, webhook registered against a deployed stub; **Hebrew/RTL test of buttons, lists and a Flow** with the 5 test numbers | 0.5–1 day + Meta review waits | a phone number; kibbutz entity for the portfolio |
| 1 | `whatsapp-webhook` edge function (verify, signature, dedupe, state machine), `bot_call`, `bot_sessions`/`bot_inbound`/`bot_copy`, `my_upcoming_rides()`, menu: my rides, my requests, new request (lists or Flow), withdraw, Sadran contact. Tests: SQL suite for `bot_call`, Vitest for the state machine, one Deno bundle test | 4–6 days | phase 0 |
| 2 | Link code, rule-based Hebrew parser + confirmation card, quick one-way, ask-to-join, proposal answer in chat; optional Claude parser behind a feature flag | 3–4 days | phase 1 in use |
| 3 | Opt-in on profile, `whatsapp_outbox`, template approvals, `enqueue_notification` branch, drain in `app.tick()` | 2–3 days + template approvals | phase 1; budget decision after Oct 2026 pricing is visible |

Effort assumes the usual gate (`npm run check`, `db:reset`, `db:test`, one Playwright spec for the opt-in/link UI) and that solver and board are untouched.

---

## 5. Open questions for the owner

1. **Phone number**: is there a kibbutz SIM/landline that can be dedicated to the bot (not someone's personal WhatsApp)?
2. **Legal entity** for the Meta Business Portfolio: the kibbutz itself or an amuta? Needed only if we later want business verification.
3. **Request form**: Flow form (single screen, needs the RTL test) vs step lists (robust, more turns)? Default: prototype both in phase 0, decide on the evidence.
4. **Link code** for writes (extra safety vs one more step)? Recommendation: yes from phase 2.
5. **LLM parsing**: include at all, and which model? Recommendation: ship rule-based first; add Claude behind a flag once real messages show what the rules miss.
6. **Notifications**: worth ~$20–30/month at 300 members, given push already exists? Recommendation: WhatsApp only for members without push, decided after phase 1 usage data.
7. **Hebrew location**: fourth place (`bot_copy`) or reuse `notification_templates`?

---

## 6. Sources

Meta: [pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) · [Oct 2026 service/utility change](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages) · [App Review for direct developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review) · [access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/) · [webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks) · [list messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages/) · [reply buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages) · [sending a Flow](https://developers.facebook.com/docs/whatsapp/flows/guides/sendingaflow) · [Flow components](https://developers.facebook.com/docs/whatsapp/flows/reference/components) · [opt-in](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in) · [On-Premises sunset](https://developers.facebook.com/docs/whatsapp/on-premises/sunset)

Secondary (pricing/limits, dated 2026): [whale.co.il Israel rates](https://whale.co.il/en/blog/meta-whatsapp-pricing-2026) · [chatmaxima rate table](https://chatmaxima.com/whatsapp-api-pricing/) · [respond.io on Oct 2026](https://respond.io/blog/whatsapp-pricing-change-2026) · [Wati on Oct 2026](https://www.wati.io/en/blog/whatsapp-service-message-pricing/) · [SendPulse](https://sendpulse.com/blog/whatsapp-service-message-pricing) · [messaging limits](https://chatarmin.com/en/blog/whats-app-messaging-limits) · [unverified WABA limits](https://blueticks.co/blog/whatsapp-api-without-meta-verification) · [test number limits](https://help.wanotifier.com/en/article/test-phone-number-limitations-in-direct-setup-kt0ly2/) · [Flows guide](https://wanotifier.com/whatsapp-flows-101-guide/) · [AI chatbot policy](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban) · [Twilio sandbox](https://www.twilio.com/docs/whatsapp/best-practices-and-faqs) · [360dialog pricing](https://360dialog.com/pricing) · [Kapso pricing](https://kapso.com/pricing) · [unofficial libraries risk](https://whatsapp.checkleaked.cc/blog/whatsapp-cloud-api-vs-unofficial)

Supabase: [Edge Function secrets/env](https://supabase.com/docs/guides/functions/secrets) · [background tasks](https://supabase.com/docs/guides/functions/background-tasks) · [limits](https://supabase.com/docs/guides/functions/limits) · [JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys) · [`auth.uid()` definition](https://github.com/supabase/auth/blob/master/migrations/20211202183645_update_auth_uid.up.sql)
