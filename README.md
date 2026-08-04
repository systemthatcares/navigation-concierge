# Navigation Concierge — Profiling Agent

Reference implementation of the coverage-loss consult, v0.1. Guided questions
in, recommended coverage path + next actions out. Built at the 2026-07-19
hackathon; v0.1 (care tiers + clinch check) shipped 2026-08-03.

Status: working prototype, 15/15 tests passing. Not yet integrated with
systemthatcares.com.

## Run it

```
python3 -m http.server 8471
# open http://localhost:8471
```

No build step, no dependencies, no API keys, no backend. Nothing a user
types ever leaves the browser.

## Validate the logic

```
node test_personas.js
```

15 assertions: 9 recommendation personas and 6 clinch checks (episode
clinches immediately; spouse-SEP and chronic must NOT clinch before income;
surveillance clinches only after subsidy-negative income).

## The contract

- `scoring.js` — deterministic core. Phase 1 timing tree (which paths are
  alive given days since coverage loss) + Phase 2 compressor scorecard (rank
  the survivors) + the clinch check. Plain functions, no LLM, no network, no
  state; runs in Node and the browser. **This file plus `test_personas.js`
  are the canonical consult logic.** If we integrate into the site by
  porting rather than lifting, the tests are the acceptance bar.
- `app.js` — the guided chat flow. Stage 1 gates, Stage 2 spouse gates and
  care-tier questions, Stage 3 ranking questions with clinch-gated early
  exits, Stage 4 output. Replaceable: any UI that collects the same profile
  fields and calls `NavScoring.recommend()` is equivalent.
- `index.html` — chat UI shell, placeholder styling. Script tags carry a
  `?v=` cache-buster; bump it on every script change (python http.server
  sends no cache headers).

## Specs

- `docs/2026-05-14_block1_memo.md` — the consult logic: timing tree,
  compressor scorecard, question ordering, profile fields (the Block 1 memo,
  reviewed together 2026-05-18).
- `docs/2026-08-03_v0.1_spec_note.md` — the v0.1 delta: `careTier` replaces
  the `inProgressCare` boolean (episode / surveillance / chronic / none),
  tier weights, and the clinch rule that replaced the hand-written
  short-circuits.

File paths mentioned inside those docs refer to their original home in
Matthew's project files; in this repo the reference implementation is the
repo root and both specs live in `docs/`.

## Shareable demo

Published as a private Claude artifact (self-contained single-file bundle of
the three source files): https://claude.ai/code/artifact/43fb2f23-f5a3-439c-a7cb-f46830f90aaf

## Changelog

**v0.1 (2026-08-03)**
- Care input stratified: `careTier` (episode / surveillance / chronic / none)
  replaces the `inProgressCare` boolean. Weights scale with what disruption
  would actually cost; an occasional-Rx patient no longer scores like a
  mid-chemo patient.
- Hand-written short-circuits removed. Early exit now requires a clinch:
  every combination of the remaining answers must produce the same winner
  (exhaustive enumeration, at most 18 cases). The exit message is provably
  true when shown.
- Episode weight raised (+3 COBRA / -2 ACA), absorbing the dominance the old
  care short-circuit asserted out-of-band.

**v0 (2026-07-19)** — hackathon build.

## Honest limitations (v0.1)

- Subsidy eligibility is a rough income-band heuristic, not real 2026 ACA
  math (FPL, benchmark premium by age and rating region, the restored 400%
  cliff).
- Medi-Cal / CHIP are absent from the option set, which matters most for the
  family personas at low income. Biggest known content gap; fix planned
  before anything public.
- Spouse SEP window defaults to 30 days; plan-specific reality varies.
- CA-tuned. Non-CA states only differ by short-term availability here.
- Care tier is self-reported; good-faith answers land in the right bucket,
  wrong ones are not defended against.
- The day-61+ COBRA closure ignores late election notices (the 60 days run
  from loss or notice, whichever is later).
- Educational information, not insurance, legal, or medical advice.

---

Matthew Ton-That (consult logic, reference implementation) · Shota (site
framework, integration). Private repo; not licensed for redistribution.
