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
  subsidyLikely: "no", newCoverageSoon: "no", totalPremium: null,
};

const STAGE3 = ["subsidyLikely", "specialtyRx", "newCoverageSoon"];

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
    profile: { ...base, daysSinceLoss: 15, subsidyLikely: "yes" },
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
    profile: { ...base, daysSinceLoss: 15, careTier: "chronic", subsidyLikely: "yes" },
    expect: { recommended: "aca" },
  },
  {
    name: "9. Surveillance tier (q3mo cystoscopy), subsidy-negative — COBRA by a moderate margin",
    profile: { ...base, daysSinceLoss: 20, careTier: "surveillance", subsidyLikely: "no" },
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

// a) Mid-treatment clinches for COBRA immediately after the care questions,
//    across all 18 remaining-answer combinations.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 20, careTier: "episode" }, STAGE3);
  check(c.clinched && c.path === "cobra",
    "a. episode tier clinches cobra with all of stage 3 unanswered",
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
  const after = S.clinchCheck({ ...base, daysSinceLoss: 20, careTier: "surveillance", subsidyLikely: "no" }, ["specialtyRx", "newCoverageSoon"]);
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
  const c = S.clinchCheck({ ...base, daysSinceLoss: 12, hasSpouse: true, spouseBenefits: true, careTier: "episode" }, STAGE3);
  check(c.clinched && c.path === "cobra",
    "e. episode + spouse SEP open clinches cobra (v0's collision special-case, now arithmetic)",
    "clinched: " + c.clinched + ", path: " + c.path);
}

// f) Day 75 (only bare alive) is trivially clinched.
{
  const c = S.clinchCheck({ ...base, daysSinceLoss: 75 }, STAGE3);
  check(c.clinched && c.path === "bare",
    "f. day 75 collapse clinches bare",
    "clinched: " + c.clinched + ", path: " + c.path);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
