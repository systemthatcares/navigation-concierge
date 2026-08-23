# Navigation Concierge — Tier-1 Multi-State Spec Delta

*Status 2026-08-23: ACTIVE, first post-launch milestone per Matthew's FAST
ruling. The section-6 fact verification is COMPLETE (all ~60 state facts
verified and sourced, retrieved 2026-08-23); see the addendum at the bottom
for two findings that override assumptions in this spec.*

*Friday, 2026-08-19, on Matthew's ruling ("do today half now and draft the
tier-1 spec delta"). Context: Matthew's hands-on test surfaced that the v0.2
Medi-Cal path ran for every state (Hawaii got CA program, portal, and
thresholds). The today-half — gating Medicaid to unresolved-with-pointer
outside CA and stripping all CA-isms from OTHER-state output — is SHIPPED
(api + navigation-concierge repos, 2026-08-19). This delta specifies the next
tier: making non-CA consults substantively right without claiming CA-grade
precision. Implementation is Shota's; fact verification is Donatello's;
content sign-off is Matthew's (A5).*

## Scope ruling this implements

**Tier 1 = generic-but-true national layer.** Per-state facts only where they
are binary, stable, and cheaply verifiable. No per-state dollar thresholds
beyond the federal FPL arithmetic. Tier 2 (per-state published thresholds,
portals, mini-COBRA/state continuation) is explicitly out of scope until
demand proves it.

## 1. Flow change: collect the real state

Today the engine stores `state: CA | OTHER`. Tier 1 needs the actual state.

- `flow.py` / question `state`: store the two-letter code (the agent already
  parses "hawaii" in free text; option set becomes the 50 states + DC,
  normalisation handles names vs codes).
- Profile field `state` widens from the CA/OTHER literal to the code;
  `timing_tree` gates read facts from the state table instead of `== "CA"`.
- Migration note: existing consult rows carry CA/OTHER; treat OTHER as
  "unknown state" (behaves like today's gate) so nothing breaks.

## 2. The state-facts table (the whole Tier-1 data model)

One static module (`state_facts.py` / `state_facts.js`, parity-tested like
fpl), one row per state + DC:

| field | type | drives |
|---|---|---|
| `medicaid_name` | str | program naming ("Med-QUEST", "TennCare", ...) |
| `expanded` | bool | whether the 138% adult MAGI path exists at all |
| `fpl_table` | enum: contiguous / AK / HI | which federal guideline row to use |
| `marketplace` | str + url | "Covered California"/CoveredCA.com, else HealthCare.gov or the state exchange |
| `short_term` | enum: available / banned / restricted | replaces the current CA-only SB 910 check |
| `mandate_penalty` | bool | CA, MA, NJ, RI, DC true; all else false |

Engine consumes the table; no other per-state logic anywhere.

## 3. New rule (non-negotiable): the coverage gap

In a non-expansion state, an adult under 100% FPL gets **neither** Medicaid
(no expansion) **nor** marketplace subsidies (APTC floor is 100% FPL). Without
this rule, Tier 1 would tell a poor Texan "ACA with subsidies" — the A1 bug
reborn. Behaviour:

- `expanded=false` and income < 100% FPL → adult Medicaid closed ("this state
  has not expanded Medicaid; adult eligibility is very limited"), subsidy
  trilean forced false, and a dedicated honest note: kids still very likely
  qualify (CHIP exists everywhere at higher limits), community health centers,
  and check the state's own parent/caretaker categories.
- `expanded=true` → adult screen at 138% of the correct FPL table, named by
  the state's program, portal = HealthCare.gov or the state exchange.
  Presented as a screen, not a determination ("apply — the state decides").

## 4. FPL: two added rows

`FPL_BASE` gains HI and AK entries for both vintages (2026 + 2025), from the
same HHS Federal Register notices as the existing contiguous rows. The
published-CA-threshold table stays CA-only; other states use FPL arithmetic
with an explicit "rough screen" framing (no disregard/round-up rules claimed).

## 5. Copy/agent implications

Minimal. The prompt already says the consult is CA-tuned; Tier 1 relaxes that
line to name what IS assessed per state. Tool payloads carry all state-varying
strings (per the 8/19 redesign convention: volatile content lives in payloads,
not the prompt). The rendering contract is unchanged.

## 6. Verification checklist (Donatello; ~60 facts, all sourced)

1. **Expansion status, 50 states + DC** — KFF Medicaid expansion tracker
   (primary), cross-check state Medicaid sites for the ~10 non-expansion
   states. Date-stamp each.
2. **HI + AK federal poverty guidelines, 2026 and 2025** — HHS Federal
   Register notices (same citations as fpl.py's existing sources).
3. **Medicaid program names, 50 + DC** — state Medicaid agency sites; KFF
   maintains a list. (Name only; no thresholds.)
4. **Short-term plan status per state** — banned/restricted list (NY, NJ, MA,
   CT, CO, WA, CA + others); NAIC/KFF summaries, verify the ambiguous ones
   against state DOI pages. Federal 4-month duration rule noted globally.
5. **Individual-mandate penalties** — confirm the five (CA, MA, NJ, RI, DC)
   and that no new ones exist for 2026.
6. **Marketplace identity per state** — state-based exchange list (~18) vs
   HealthCare.gov states; names + URLs only.

Deliverable: one table (CSV or md) with a source URL + retrieval date per
cell, routed via `agenthandoffs/from_donatello/`.

## 7. Acceptance criteria

- Parity: `state_facts` + gated logic byte-identical Python/JS across the
  grid (extend `test_scoring_parity.py`).
- Deterministic: per-class unit tests — expansion low-income (→ state-named
  Medicaid screen), non-expansion coverage-gap (→ no-subsidy honesty note),
  HI FPL boundary (contiguous table would flip the answer; HI table must
  win), short-term-banned state (NY closes it with reason), mandate line only
  in the five.
- Live: persona sweep gains one persona per class above; all CLEAN.
- Matthew reads every new user-visible string before merge (A5).

## 8. Explicitly out (Tier 2, demand-gated)

Per-state published Medicaid thresholds and disregard rules; state portal
deep-links; mini-COBRA / state continuation for small employers; non-MAGI
pathways. The consult's "honest edges" line discloses these.

---

## Addendum 2026-08-23 — verification complete; spec corrections

The section-6 sweep ran 2026-08-23 (all cells sourced + date-stamped;
canonical tables live Matthew-side, will be delivered with the build).
Highlights that change this spec:

1. **Section 2 / STLDI: drop the global federal 4-month note.** DOL/HHS/
   Treasury announced non-enforcement of the 4-month rule 2025-08-07;
   12–36-month plans are being sold again where state law allows. State law
   governs — the per-state `short_term` strings must carry the state rule,
   never the federal one.
2. **Marketplace counts moved:** 21 SBEs + 3 SBE-FP (Illinois full SBE for
   PY2026; Oklahoma SBE-FP since May 2026). SBE-FP consumers still enroll
   at HealthCare.gov.
3. **Template-breaker states for section 3:** Wisconsin is non-expansion
   with NO coverage gap (waiver covers childless adults to 100% FPL;
   100–138% band is marketplace-only) — needs its own branch or an
   override flag. Georgia Pathways (partial expansion, to 100% FPL)
   expires 2026-12-31.
4. **Known scheduled changes to design for:** OBBBA work requirements hit
   the expansion population nationally Jan 2027; Medi-Cal/Medicaid
   retroactivity shrinks for applications from 2027-01-01 (1 month MAGI
   adults / 2 months others). Engine wants date-conditional content or a
   scheduled update path.
5. **Engine bug lead (pre-Tier-1 check):** the CA household-of-4 adult
   Medi-Cal limit in the engine ($44,480) is wrong — correct 2026 value is
   $45,540 (138% × FPL, DHCS ACWDL 26-01). The bad number equals the
   Hawaii household-of-5 poverty line from the same HHS table, so check
   `fpl.py` for a row/column mispull before adding HI/AK rows.
