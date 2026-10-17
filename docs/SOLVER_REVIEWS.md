# Solver reviews

One section per reviewed week, newest first. How to run one: `.claude/skills/solver-review/SKILL.md`
(tooling in `scripts/replay/`). Names appear only where a finding needs them; no ids, phones or emails.

## Week of 18–24.10.2026 — Nevo (Givat Haviva)

- **Export:** 16.10, before publication. The Sadran's edits were still in progress, so "final" means "final so far". The coordinator also solved the week by hand in the old spreadsheet (tab `18-24.10`), which serves as a second reference.
- **Release:** `v2026.10.16-2` (= `main` at review time).
- **Parity:** the local re-run reproduces production's first run (`a9611d56`, 16.10 07:49) exactly: 78/78 placements identical (car and times), the same 36 unmet; run summary identical (78 served, 38 unmet, 8 needing a driver, 2 relocations).
- **First run → current state:** placed 78 → 80, driverless 8 → 6. Of 114 live requests: 47 unchanged, 20 moved to another car, 3 moved in time, 8 unplaced by hand, 10 placed by hand, 26 unmet on both sides.
- **Against the spreadsheet:** the coordinator served all but about 10 requests with the same cars (plus a 9th "elections" car on Tue/Wed). See REQUIREMENTS item 136 for the per-day comparison.

### Changes measured on this replay

| Change | Served | Driverless | Difference from production's first run |
|---|---|---|---|
| Baseline (`v2026.10.16-2`) | 78 | 8 | identical |
| 136 (a) shared rides, whole round trips (2026-10-17) | 79 | 8 | Sunday: Galfi rides with Aviv (Rita); the freed Tosia serves Yan (was unmet). Everything else unchanged. A first version also pooled two different free-text places (Yakum into "the north", Ya'ar HaMeginim into Hof HaCarmel) — fixed in `merge.ts` before commit. |
| 136 (a) follow-ups: unmet round trips take a seat; merge suggestions may shift the host (2026-10-17) | 79 | 8 | no further change on this week (no unmet round trip fits a passing ride inside everyone's flexibility) |
| 136 (c) solver side: never away from base at week end (2026-10-17) | 77 | 8 | Friday: the one-way to Nahariya stays unplaced. Thursday: Yan's one-way to Binyamina (nothing would bring the car back) and the driverless ride that depended on it stay unplaced; the capacity serves Omri Glass (Rita). All 8 cars end the week at home. 36 rides moved car as a knock-on of the placement order. |

Why (a) alone moves little here: most of the coordinator's sharing needed times outside the members' declared flexibility (agreed on WhatsApp), was one direction only (drop-offs, one-way legs — 136 b/d), or involved free-text places that cannot be matched.

### Chains of manual changes

| Day | What the Sadran did | Principle |
|---|---|---|
| Tue, Wed, Thu | Omri Glass (prefers Bruno, unplaced by the solver all three days) placed on Bruno. Freeing Bruno moved Yair (Tue: Bruno → Tosia, Wed: Bruno → Marisa) and 3–4 more rides each day. Two driverless rides were dropped on Tue (Shafner's drop-off, Elisha's one-way from Haifa); Agata was unplaced on Thu. | 136 (f) preferences in a fixing stage. Mostly a **data problem**: Raanana is free text (distance 0), so Glass scored lowest of the week (4.70, fairness 0). |
| Thu–Sat | Yarden's trip to Shitim (Thu single day + Fri–Sat series) placed on Tosia. Shachar and Amit moved Tosia → Rita, Servi (Thu, Binyamina) unplaced, Noni (Fri) moved Tosia → Marisa. | 136 (e) multi-day repair: move the blockers. |
| Mon | Agata (Kfar Glickson, unmet) placed on Mishel. Servi moved Mishel → Marisa, Katya's driverless ride dropped. | New: **a ride without a driver never blocks a request whose requester drives** (supports 136 b). |
| Sun, Fri | Amit / Eli's kindergarten runs moved to Bruno, the car Amit is responsible for. | Possibly extra knowledge (the family keeps child seats in Bruno?); to ask. |
| Wed | Noga's Ashkelon trip unplaced; Servi moved Marisa → Mishel. | Extra knowledge (Noga is that week's coordinator). |

### Policy and data findings

- **43 of 114 requests named a free-text place**, including places already on the list (Metzer ×4, Pardes Hanna ×2, Givat Haviva ×3). Free text gets distance 0 and public transport 0.5, and can never be shared (no managed place). Missing from the list: Raanana, Hof HaCarmel, Karkur, Kfar Saba, Rishon LeZion, Tel HaShomer, Netanya, Herzliya, Akko, Oranim, Tivon, Rehovot, Ashdod, Ashkelon, Nof HaGalil, Ein Carmel, Ein Ayala, Shitim, Yakum, Kfar Glickson, Agur and others. 33 of the department's 52 places have no public-transport score.
- **Distance (28%) decides most contests.** A far "אחר" trip (Tel Aviv leisure, 9.50) outranks a Binyamina work commute (7.05) and kindergarten-plus-work (8.55). Revisit the weights only once the place data is complete.
- **Fairness counts hours,** so a regular long workday (Raanana 07:15–19:00, three days a week) sinks to 0 within weeks.
- "הצג מדיניות" tells members that people served is "people in the ride ÷ 5". The rule counts people **beyond the requester** ÷ 5 (a solo trip scores 0).
- The ride-type weights keep four dead keys (`work`, `healthcare`, `childcare`, `errands`); Nevo's ride types are `job`, `garden`, `other`.
