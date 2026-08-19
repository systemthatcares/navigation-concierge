/*
 * Validation for v0.1 (2026-08-03): recommendation personas + clinch assertions.
 * Personas 1-7 carried from the 2026-07-14 build plan and v0 edge cases,
 * ported to careTier. 8-9 added for care stratification (spec note 2026-08-03).
 * Clinch section asserts early exits fire iff arithmetically clinched.
 */
const S = require("./scoring.js");

const base = {
  daysSinceLoss: 0, state: "CA", hasSpouse: false, spouseBenefits: false,
  spousePlan60Day: false, careTier: "none", specialtyRx: false,
  newCoverageSoon: "no", totalPremium: null,
  householdSize: 1, annualIncome: null, hasKids: false, pregnancyInHousehold: false,
};

// v0.2: income is no longer one of the enumerable stage-3 fields. It is a
// continuous quantity gating four cut lines, so clinchCheck gates on it
// directly rather than walking it. See scoring.js clinchCheck.
const STAGE3 = ["specialtyRx", "newCoverageSoon"];

// Single-filer incomes that land on each side of the lines that matter.
// SUBSIDY: above the 138% Medi-Cal line, below the 400% cliff.
// RICH:    above the cliff, so neither Medi-Cal nor a subsidy applies.
// POOR:    below the 138% line, so Medi-Cal is live.
const SUBSIDY = 40000;
const RICH = 200000;
const POOR = 18000;

const personas = [
  {
    name: "1. Spouse-plan default winner",
    profile: { ...base, daysSinceLoss: 10, hasSpouse: true, spouseBenefits: true },
    expect: { recommended: "spouse" },
  },
  {
    name: "2. COBRA for continuity (mid-chemo)",
    profile: { ...base, daysSinceLoss: 20, careTier: "episode", specialtyRx: true },
    expect: { recommended: "cobra" },
  },
  {
    name: "3. ACA subsidy winner",
    profile: { ...base, daysSinceLoss: 15, annualIncome: SUBSIDY },
    expect: { recommended: "aca" },
  },
  {
    name: "4. Spouse SEP open + mid-treatment — scorecard resolves to COBRA by arithmetic",
    profile: { ...base, daysSinceLoss: 12, hasSpouse: true, spouseBenefits: true, careTier: "episode" },
    expect: { recommended: "cobra" },
  },
  {
    name: "5. Day 75, everything closed — bare with open-enrollment guidance",
    profile: { ...base, daysSinceLoss: 75 },
    expect: { recommended: "bare" },
  },
  {
    name: "6. Bridge case: new job in 6 weeks, no care — COBRA month-to-month (CA, no short-term)",
    profile: { ...base, daysSinceLoss: 25, newCoverageSoon: "yes" },
    expect: { recommended: "cobra" },
  },
  {
    name: "7. Same bridge case outside CA — short-term wins",
    profile: { ...base, daysSinceLoss: 25, newCoverageSoon: "yes", state: "OTHER" },
    expect: { recommended: "shortterm" },
  },
  {
    name: "8. Chronic tier (occasional Rx, e.g. PDE5 refills) + subsidy income — ACA, NOT COBRA-for-continuity",
    profile: { ...base, daysSinceLoss: 15, careTier: "chronic", annualIncome: SUBSIDY },
    expect: { recommended: "aca" },
  },
  {
    name: "9. Surveillance tier (q3mo cystoscopy), subsidy-negative — COBRA by a moderate margin",
    profile: { ...base, daysSinceLoss: 20, careTier: "surveillance", annualIncome: RICH },
    expect: { recommended: "cobra" },
  },
];

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS" : "FAIL") + "  " + name);
  if (detail) console.log("      " + detail);
};

for (const t of personas) {
  const r = S.recommend(t.profile);
  const ok = r.recommended.path === t.expect.recommended;
  check(ok, t.name, "recommended: " + r.recommended.path + (ok ? "" : "  (expected " + t.expect.recommended + ")"));
  console.log("      ranking: " + r.ranked.map((x) => x.path + "(" + x.score + ")").join(" > "));
  console.log("");
}

/*
 * Clinch assertions. The property under test: an early exit is offered iff
 * NO combination of the remaining answers can change the winner.
 */
console.log("--- clinch checks ---\n");

// a) Mid-treatment clinches for COBRA once income is known, across every
//    remaining-answer combination.
//
//    CHANGED IN v0.2. This asserted the clinch fired at the stage-2 checkpoint,
//    before income. It no longer can, and should not: with income unknown,
//    Medi-Cal eligibility is unknown, and an episode-tier patient who qualifies
//    for Medi-Cal scores into Medi-Cal rather than COBRA. The winner genuinely
//    turns on the unasked question, which is exactly the condition the clinch
//    rule says must block an early exit. See (a2) for the other half.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 20, careTier: "episode", annualIncome: RICH }, STAGE3);
  check(c.clinched && c.path === "cobra",
    "a. episode tier clinches cobra once income is known",
    "clinched: " + c.clinched + ", path: " + c.path);
}

// a2) The honesty gate itself: the same patient with income unknown must NOT
//     clinch. This is the v0.1 false-confidence bug as a regression test.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 20, careTier: "episode" }, STAGE3);
  check(!c.clinched && c.blockedBy === "eligibility_unresolved",
    "a2. episode does NOT clinch while income (and so Medi-Cal) is unknown",
    "clinched: " + c.clinched + ", blockedBy: " + c.blockedBy);
}

// a3) A Medi-Cal-eligible mid-treatment patient clinches for Medi-Cal, not
//     COBRA. v0.1 would have quoted this person 102% of a full group premium
//     against an income below 138% FPL.
//
//     specialtyRx is pinned here rather than left to the walk, because it is
//     the one remaining answer that flips this case: at episode + specialty Rx
//     + new coverage soon, COBRA outscores Medi-Cal 3 to 2 on an $18k income.
//     That combination is flagged for review, not asserted here. See the
//     "known tension" note at the bottom of this file.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 20, careTier: "episode", annualIncome: POOR, specialtyRx: false }, ["newCoverageSoon"]);
  check(c.clinched && c.path === "medical",
    "a3. episode + Medi-Cal-eligible income clinches medical, not cobra",
    "clinched: " + c.clinched + ", path: " + c.path);
}

// b) The spouse-SEP case must NOT clinch before income: subsidy-eligible
//    income flips spouse → ACA. This is the regression for the v0 bug.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 10, hasSpouse: true, spouseBenefits: true }, STAGE3);
  check(!c.clinched,
    "b. spouse SEP open does NOT clinch while income is unanswered (v0 spouse short-circuit bug)",
    "clinched: " + c.clinched);
}

// c) Certainty rises mid-consult: surveillance doesn't clinch at stage 2,
//    then clinches once income comes back subsidy-negative.
{
  const before = S.clinchCheck({ ...base, daysSinceLoss: 20, careTier: "surveillance" }, STAGE3);
  const after = S.clinchCheck({ ...base, daysSinceLoss: 20, careTier: "surveillance", annualIncome: RICH }, ["specialtyRx", "newCoverageSoon"]);
  check(!before.clinched && after.clinched && after.path === "cobra",
    "c. surveillance clinches only after subsidy-negative income",
    "before: " + before.clinched + ", after: " + after.clinched + " (" + after.path + ")");
}

// d) Chronic tier must not clinch at stage 2 (income decides COBRA vs ACA).
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 15, careTier: "chronic" }, STAGE3);
  check(!c.clinched,
    "d. chronic tier does not clinch while income is unanswered",
    "clinched: " + c.clinched);
}

// e) Episode + spouse open (the v0 collision case) still clinches for cobra:
//    the raised episode weight resolves it by arithmetic, no special-casing.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 12, hasSpouse: true, spouseBenefits: true, careTier: "episode", householdSize: 2, annualIncome: RICH }, STAGE3);
  check(c.clinched && c.path === "cobra",
    "e. episode + spouse SEP open clinches cobra (v0's collision special-case, now arithmetic)",
    "clinched: " + c.clinched + ", path: " + c.path);
}

// f) Day 75: every timed window has closed, so bare is the only path left and
//    the consult clinches. Requires income, because Medi-Cal has no window and
//    would still be open at day 75 if the household qualified.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 75, annualIncome: RICH }, STAGE3);
  check(c.clinched && c.path === "bare",
    "f. day 75 collapse clinches bare once income rules Medi-Cal out",
    "clinched: " + c.clinched + ", path: " + c.path);
}

// f2) The Friday bug, as a regression test. Same day-75 collapse, but the
//     household qualifies for Medi-Cal. v0.1 clinched "go uninsured" here with
//     arithmetic confidence. There is no version of that answer that is right.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 75, householdSize: 4, hasKids: true, annualIncome: 38000 }, STAGE3);
  check(c.clinched && c.path === "medical",
    "f2. day 75, Medi-Cal-eligible family clinches medical, never bare",
    "clinched: " + c.clinched + ", path: " + c.path);
}

// f3) Day 75 with income unknown must not clinch at all: Medi-Cal is unresolved,
//     not closed, and the difference is the entire point of this release.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 75 }, STAGE3);
  check(!c.clinched && c.blockedBy === "eligibility_unresolved",
    "f3. day 75 with income unknown does NOT clinch bare",
    "clinched: " + c.clinched + ", blockedBy: " + c.blockedBy);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

/*
 * KNOWN TENSION (v0.2, flagged 2026-08-17, unresolved):
 *
 * episode tier + specialtyRx + newCoverageSoon="yes" on a Medi-Cal-eligible
 * income ranks COBRA above Medi-Cal, 3 to 2. The arithmetic is doing what the
 * rows say: mid-treatment continuity (+3) and formulary preservation (+2) beat
 * the Medi-Cal baseline (+3) less its mid-course network penalty (-1), even
 * after the affordability row takes COBRA down 3.
 *
 * Whether that is the right answer is a clinical and financial judgment, not an
 * arithmetic one. For a single filer at 113% FPL, COBRA is roughly half of gross
 * income for the bridge period. The competing consideration is real: Medi-Cal
 * enrollment and a specialty formulary transition mid-treatment take time that a
 * short bridge may not have.
 *
 * Three of the four remaining-answer combinations already resolve to Medi-Cal.
 * Only this one flips. Options if it should not: raise the affordability
 * penalty, gate the specialtyRx COBRA bonus on affordability, or leave it and
 * let the verify flags carry the caveat. Matthew's ruling.
 */
