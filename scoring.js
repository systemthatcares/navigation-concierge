/*
 * Navigation Concierge — deterministic scoring core (v0.1, 2026-08-03)
 * Source of truth: 2026-05-14_navigation_concierge_block1_memo.md
 *   as amended by 2026-08-03_profiling_agent_v0.1_spec_note.md
 *   (care stratification + clinch check; hand-written short-circuits removed).
 *
 * Phase 1: timing tree — which paths are alive given days since coverage loss.
 * Phase 2: compressor scorecard — rank the alive paths for this client.
 *
 * This module is plain logic. No LLM, no network, no state.
 * Runs in both Node (for tests) and the browser (for the chat UI).
 */

const NavFplModule = typeof require !== "undefined" ? require("./fpl.js") : null;
const Fpl = NavFplModule || (typeof window !== "undefined" ? window.NavFpl : null);

const PATHS = {
  medical: "Medi-Cal",
  cobra: "COBRA",
  aca: "ACA Marketplace (Covered California)",
  spouse: "Spouse's employer plan",
  shortterm: "Short-term health insurance",
  bare: "Go uninsured",
};

/*
 * profile fields:
 *   daysSinceLoss   number (>= 0)
 *   state           "CA" | "OTHER"
 *   hasSpouse       bool
 *   spouseBenefits  bool  (spouse employed with employer benefits)
 *   spousePlan60Day bool  (spouse plan allows 60-day SEP; default 30-day assumed)
 *   careTier        "episode" | "surveillance" | "chronic" | "none"
 *                   (v0.1: stratified continuity stakes — mid-course treatment arc /
 *                    tight-interval specialist monitoring / stable Rx-and-checkups / none.
 *                    Replaces the v0 inProgressCare boolean, which collapsed a ~100x
 *                    stakes range into one bit. See 2026-08-03 spec note.)
 *   specialtyRx     bool
 *   newCoverageSoon "yes" | "no" | "unsure"  (new employer coverage < 90 days away)
 *   totalPremium    number | null  (employer's total monthly premium if known; display-only, never scored)
 *
 * v0.2 (2026-08-17) — the FPL spine. Income stopped being a band:
 *   householdSize       number (>= 1)
 *   annualIncome        number | null  (expected household income, next 12 months)
 *   hasKids             bool  (children under 19 in the household)
 *   pregnancyInHousehold bool
 *
 * `subsidyLikely` is no longer a profile field. It was a self-reported band
 * collapsed to a trilean; it is now derived from annualIncome and householdSize
 * in fpl.js, alongside every Medi-Cal cut line. See fpl.js for why.
 */

function timingTree(profile) {
  const d = profile.daysSinceLoss;
  const alive = [];
  const closed = [];
  // Paths whose availability genuinely cannot be determined from what we know.
  // Distinct from `closed`: a closed door has been checked, an unresolved one
  // has not. Collapsing the two is what let v0.1 tell a Medi-Cal-eligible family
  // that every door was shut.
  const unresolved = [];

  // Medi-Cal: no enrollment window at all. That is the whole point of it — the
  // 60-day clocks below are irrelevant to this path, which is exactly why its
  // absence from v0.1 was worst at day 61+, where it was the only door left.
  // Outside California the program, the thresholds, and the portal are all
  // different (HI/AK even use different federal poverty guidelines), so the
  // consult does not assess it — unresolved, never silently closed, because
  // every state's Medicaid stays open year-round while the user checks.
  const elig = Fpl.eligibility(profile);
  if (profile.state !== "CA") {
    unresolved.push({
      path: "medical",
      reason:
        "Medicaid outside California is not assessed by this consult; the math here covers " +
        "Medi-Cal only. Your state's Medicaid program usually has no enrollment deadline, so " +
        "it stays open while you check. Start at HealthCare.gov or your state's Medicaid agency.",
    });
  } else if (elig.adults === true || elig.pregnancy === true) {
    alive.push("medical");
  } else if (elig.adults === null) {
    unresolved.push({
      path: "medical",
      reason:
        "Medi-Cal eligibility depends on your household income and size, which we do not have. " +
        "It has no enrollment deadline, so it stays open while you check.",
    });
  } else {
    const line = elig.thresholds.medicalAdults;
    closed.push({
      path: "medical",
      reason: line
        ? "household income is above the Medi-Cal limit for a household of " +
          profile.householdSize +
          " ($" +
          line.toLocaleString("en-US") +
          "/year)"
        : "household income is above the Medi-Cal limit for this household size",
    });
  }

  // COBRA: 60 days from loss (or notice, whichever later). Election retroactive.
  if (d <= 60) alive.push("cobra");
  else closed.push({ path: "cobra", reason: "60-day COBRA election window has likely passed (day " + d + " from coverage loss). The clock runs from the later of your coverage-loss date and the date your COBRA notice was sent, so check the date on the notice before you treat this door as shut" });

  // ACA SEP: 60 days from loss.
  if (d <= 60) alive.push("aca");
  else closed.push({ path: "aca", reason: "60-day ACA Special Enrollment Period has passed (day " + d + ")" });

  // Spouse SEP: typically 30 days, plan-specific (some 60).
  if (!profile.hasSpouse) {
    closed.push({ path: "spouse", reason: "no spouse in household" });
  } else if (!profile.spouseBenefits) {
    closed.push({ path: "spouse", reason: "spouse does not have employer benefits" });
  } else if (d <= 30) {
    alive.push("spouse");
  } else if (d <= 60 && profile.spousePlan60Day) {
    alive.push("spouse");
  } else {
    closed.push({ path: "spouse", reason: "spouse plan SEP window (typically 30 days) has likely closed; confirm with the plan" });
  }

  // Short-term: banned in CA (SB 910, 2018). Year-round elsewhere.
  if (profile.state === "CA") {
    closed.push({ path: "shortterm", reason: "not available in California (SB 910)" });
  } else {
    alive.push("shortterm");
  }

  // Bare: always technically available. CA has a state mandate penalty.
  alive.push("bare");

  return { alive, closed, unresolved };
}

function spouseSepOpen(profile) {
  return (
    profile.hasSpouse &&
    profile.spouseBenefits &&
    (profile.daysSinceLoss <= 30 || (profile.daysSinceLoss <= 60 && profile.spousePlan60Day))
  );
}

/*
 * Compressor scorecard, hardcoded from the memo table.
 * ++ = +2, + = +1, – = -1, – – = -2, — = 0, "verify" = 0 with a flag.
 */
function runScorecard(profile, alive) {
  // Baseline priors (tie-breaking sanity, not in the memo table):
  // bare is a last resort; it should never beat a live insured path on a tie.
  const scores = {};
  const reasons = {};
  const verifyFlags = {};
  const bareBaseline =
    profile.state === "CA"
      ? "last resort baseline (CA mandate penalty applies)"
      : "last resort baseline";
  for (const p of alive) {
    scores[p] = p === "bare" ? -3 : 0;
    reasons[p] = p === "bare" ? [bareBaseline] : [];
    verifyFlags[p] = [];
  }

  const add = (path, pts, why) => {
    if (!(path in scores)) return;
    scores[path] += pts;
    reasons[path].push((pts > 0 ? "+" + pts : pts) + " " + why);
  };
  const verify = (path, note) => {
    if (path in verifyFlags) verifyFlags[path].push(note);
  };

  const elig = Fpl.eligibility(profile);

  // Row 0 (v0.2): Medi-Cal baseline and the affordability floor it implies.
  //
  // The affordability weight is the counterpart to what v0.1 did for care tiers:
  // a judgment moved into the scorecard where the clinch check can see it, not
  // asserted out-of-band. The judgment is that COBRA at 102% of an unsubsidized
  // group premium is not payable on an income below 138% FPL — for a single
  // filer that is a ~$700-900/month bill against a ~$22,000/year income. Without
  // this row a mid-treatment Medi-Cal-eligible patient scores into COBRA on
  // continuity grounds and is quoted a premium exceeding a third of their gross.
  if (elig.adults === true || elig.pregnancy === true) {
    add("medical", 3, "no premium, no enrollment deadline, and comprehensive benefits including prescriptions");
    add("cobra", -3, "at this income, 102% of the full group premium is not payable");
    add("aca", -1, "at this income you qualify for Medi-Cal, so marketplace subsidies do not apply; a marketplace plan would be full price plus cost-sharing");
  }

  // Row 1: spouse benefits + SEP open → spouse is default winner
  if (spouseSepOpen(profile)) {
    add("spouse", 2, "spouse has benefits and the SEP window is open (default winner)");
  }

  // Row 2 (v0.1): care tier → continuity weight scaled to disruption stakes.
  // episode absorbs the dominance the old hand-written short-circuit asserted
  // out-of-band: mid-treatment continuity outranks subsidy arithmetic inside
  // the scorecard, so the clinch check can prove it instead of assume it.
  if (profile.careTier === "episode") {
    add("cobra", 3, "mid-treatment: same plan, same network, same authorizations, zero disruption to the arc");
    add("aca", -2, "mid-treatment: network and authorization change is a clinical risk, not just a hassle");
    add("spouse", -1, "mid-treatment: network change risk mid-course");
    add("shortterm", -2, "mid-treatment: short-term plans exclude pre-existing conditions");
    add("bare", -2, "mid-treatment: catastrophic clinical and financial exposure");
    // Medi-Cal carries the same mid-course network risk as any plan change, and
    // narrower networks make it more likely the treating team is out of it. It
    // is a penalty and a verify flag, not a disqualification: a free plan that
    // covers the arc still beats an unaffordable one that does not get elected.
    add("medical", -1, "mid-treatment: switching plans mid-course carries network and authorization risk");
    verify("medical", "confirm your treating team, facility, and any scheduled procedure accept Medi-Cal before you switch mid-course");
  } else if (profile.careTier === "surveillance") {
    add("cobra", 1, "surveillance schedule: established specialist and intervals continue unchanged");
    verify("aca", "confirm your specialist is in the new plan's network and your monitoring schedule transfers without delay");
    verify("spouse", "confirm your specialist is in the spouse plan's network and your monitoring schedule transfers without delay");
    verify("medical", "confirm your specialist accepts Medi-Cal and your monitoring intervals transfer without delay");
    add("shortterm", -1, "surveillance: pre-existing condition exclusions apply to exactly this care");
    add("bare", -1, "surveillance: a skipped monitoring interval is a real clinical risk");
  } else if (profile.careTier === "chronic") {
    verify("aca", "check your regular prescriptions and current doctors against the new plan before enrolling");
    verify("spouse", "check your regular prescriptions and current doctors against the spouse plan before enrolling");
    verify("medical", "check your regular prescriptions against the Medi-Cal formulary and confirm your doctors accept it");
    add("shortterm", -1, "chronic condition: short-term plans exclude pre-existing conditions");
  }

  // Row 3: specialty Rx on current formulary
  if (profile.specialtyRx) {
    add("cobra", 2, "specialty Rx: current formulary access preserved");
    verify("aca", "verify your specialty Rx is on the new plan's formulary before enrolling");
    verify("spouse", "verify your specialty Rx is on the spouse plan's formulary before enrolling");
    verify("medical", "verify your specialty Rx is on the Medi-Cal formulary; it is broad, but prior authorization is common");
    add("shortterm", -2, "specialty Rx: short-term plans have minimal Rx coverage");
    add("bare", -2, "specialty Rx: full cash price without coverage");
  }

  // Row 4: household income, ACA subsidy-eligible.
  // v0.2: derived from real FPL arithmetic rather than a self-reported band.
  // Below the Medi-Cal line this reads "no" — not because the household is too
  // rich for help, but because the help is Medi-Cal, priced by Row 0.
  const subsidy = Fpl.subsidyLikely(profile);
  if (subsidy === "yes") {
    add("cobra", -1, "subsidy-eligible income: COBRA charges the full unsubsidized premium");
    add("aca", 2, "subsidy-eligible income: ACA subsidies can undercut COBRA substantially");
    add("spouse", -1, "subsidy-eligible income: joining the spouse plan forfeits the subsidy");
  } else if (subsidy === "unsure") {
    verify("aca", "run your projected income through the Covered California calculator; a subsidy could change this ranking");
  } else if (elig.subsidy === "over_cliff") {
    verify("aca", "your income is above the 400% subsidy cliff, so a marketplace plan is full price; compare it against COBRA on total cost, not premium alone");
  }

  // Row 5: new coverage < 90 days away → bridge logic
  if (profile.newCoverageSoon === "yes") {
    add("cobra", 1, "new coverage soon: COBRA works month-to-month as a bridge, drop it when the new plan starts");
    add("aca", -1, "new coverage soon: a full marketplace enrollment is overkill for a short gap");
    add("spouse", -1, "new coverage soon: plan change churn for a short gap");
    add("shortterm", 2, "new coverage soon: bridging a known gap is exactly what short-term is for");
    add("bare", -1, "new coverage soon: even a short uninsured gap is real risk");
  }

  // Rank: score desc, then heuristic preference order on ties.
  // medical leads the tie order: on an equal score, a path with no premium and
  // no deadline is the safer thing to send someone toward.
  const tieOrder = ["medical", "spouse", "aca", "cobra", "shortterm", "bare"];
  const ranked = alive
    .map((p) => ({
      path: p,
      label: PATHS[p],
      score: scores[p],
      reasons: reasons[p],
      verify: verifyFlags[p],
    }))
    .sort((a, b) => b.score - a.score || tieOrder.indexOf(a.path) - tieOrder.indexOf(b.path));

  return ranked;
}

/*
 * Clinch check (v0.1) — replaces the v0 hand-written short-circuits.
 *
 * A consult is "clinched" when every possible combination of the still-
 * unanswered scoring inputs produces the same winner. Then, and only then,
 * an early exit is offered, with a claim that is arithmetically true:
 * the remaining questions cannot change the recommendation.
 *
 * The scorecard is deterministic and only three fields can still move
 * scores mid-consult (totalPremium is display-only), so exhaustive
 * enumeration is exact and cheap: at most 3 x 2 x 3 = 18 evaluations.
 * Ties are resolved by the same tieOrder the real ranking uses, so
 * "same winner" includes tie-breaking behavior.
 */
const FIELD_DOMAINS = {
  specialtyRx: [true, false],
  newCoverageSoon: ["yes", "no", "unsure"],
};

function clinchCheck(profile, unansweredFields) {
  // v0.2 — the honesty gate.
  //
  // The clinch rule is "offer an early exit only when the remaining questions
  // mathematically cannot change the recommendation." v0.1 enumerated the three
  // fields it knew about and declared certainty. But eligibility for a whole
  // coverage path was neither enumerated nor known, so the certainty was scoped
  // to an incomplete option set: true inside the model, false in the world. A
  // family of four under $40k was told, with arithmetic confidence, that nothing
  // remaining could change an answer that was already wrong.
  //
  // Income cannot be enumerated the way a trilean can — it is a continuous
  // quantity gating four separate cut lines. So when eligibility is unresolved
  // the answer is not "clinched with a caveat", it is not clinched.
  const elig = Fpl.eligibility(profile);
  if (!elig.known) {
    return { clinched: false, path: null, label: null, blockedBy: "eligibility_unresolved" };
  }

  const fields = (unansweredFields || []).filter((f) => f in FIELD_DOMAINS);
  let winner = null;
  const walk = (i, p) => {
    if (i === fields.length) {
      const top = runScorecard(p, timingTree(p).alive)[0].path;
      if (winner === null) winner = top;
      return winner === top;
    }
    const f = fields[i];
    for (const v of FIELD_DOMAINS[f]) {
      if (!walk(i + 1, { ...p, [f]: v })) return false;
    }
    return true;
  };
  const clinched = walk(0, { ...profile });
  return clinched
    ? { clinched: true, path: winner, label: PATHS[winner], blockedBy: null }
    : { clinched: false, path: null, label: null, blockedBy: "scores_still_movable" };
}

/*
 * Determinations that apply to household members individually and therefore sit
 * outside the single-path ranking. A household is not always one plan: children
 * qualify for Medi-Cal at 266% FPL, far above the 138% adult line, so a family
 * well into the middle class can have covered kids and unsubsidized parents.
 * v0.1 scored the household as one unit and could not express this at all.
 */
function householdNotes(profile) {
  const e = Fpl.eligibility(profile);
  const notes = [];

  // Outside California no CA program name or tier applies, but two facts hold
  // in every state and are too load-bearing to drop: children's Medicaid/CHIP
  // limits run far above the adult ones, and pregnancy has its own higher
  // limit. Stated generically, with nothing CA-specific claimed.
  if (profile.state !== "CA") {
    if (profile.hasKids) {
      notes.push(
        "In every state, children's Medicaid and CHIP income limits run much higher than the " +
          "adult limits. Check coverage for your children regardless of what you do for " +
          "yourself; it has no enrollment deadline."
      );
    }
    if (profile.pregnancyInHousehold) {
      notes.push(
        "Pregnancy-related Medicaid has its own, higher income limit in every state and is " +
          "open year-round. Worth confirming before electing anything with a premium."
      );
    }
    return notes;
  }

  if (e.kids === "free") {
    notes.push(
      "Your children very likely qualify for Medi-Cal on their own, at no cost. The limit for children is much higher than for adults. This holds whichever path you choose for yourself, and it has no enrollment deadline."
    );
  } else if (e.kids === "tlicp") {
    notes.push(
      "Your children likely qualify for Medi-Cal for Kids at a low monthly premium. The children's income limit runs well above the adult one, so they may be covered even if you are not."
    );
  } else if (e.kids === null) {
    notes.push(
      "Children qualify for Medi-Cal at a much higher income limit than adults. Worth checking separately for them regardless of what you do for yourself."
    );
  }

  if (e.pregnancy === true) {
    notes.push(
      "Pregnancy-related Medi-Cal has its own, higher income limit, and it is open year-round. This is worth confirming before electing anything with a premium."
    );
  } else if (e.pregnancy === null && profile.pregnancyInHousehold) {
    notes.push(
      "Pregnancy-related Medi-Cal has a higher income limit than regular Medi-Cal and no enrollment deadline. Worth checking."
    );
  }

  if (e.extrapolatedHousehold) {
    notes.push(
      "Your household is larger than the published threshold table, so these figures are extrapolated. Confirm the exact limit with Covered California or your county office."
    );
  }

  return notes;
}

function nextActions(profile, recommendedPath) {
  const d = profile.daysSinceLoss;
  const cobraDaysLeft = Math.max(0, 60 - d);
  const acaDaysLeft = Math.max(0, 60 - d);
  const spouseDaysLeft = Math.max(0, (profile.spousePlan60Day ? 60 : 30) - d);
  const a = [];

  switch (recommendedPath) {
    case "medical":
      a.push("Apply for Medi-Cal at CoveredCA.com or through your county social services office. There is no enrollment deadline, so the 60-day clocks on the other options do not apply to this one.");
      a.push("Coverage is generally retroactive to the first of the month you apply, and can reach up to three months back if you had medical bills in that window. Keep any bills from the gap.");
      if (profile.careTier === "episode" || profile.careTier === "surveillance") {
        a.push("Before you drop any current option, call your treating team and confirm they accept Medi-Cal. If they do not, ask your county about continuity-of-care protections, which can keep you with your current provider through an active course of treatment.");
      }
      a.push("Report income changes when they happen. If your income rises above the limit later, you move to a Covered California plan through a special enrollment period, so there is no coverage gap.");
      break;
    case "spouse":
      a.push("Contact your spouse's HR or benefits team this week. Their special enrollment window is typically 30 days from your coverage loss, and you are on day " + d + " (about " + spouseDaysLeft + " days left, plan-specific).");
      a.push("Ask for the Summary Plan Description to confirm the exact SEP length and the coverage effective date.");
      a.push("Before declining COBRA, compare the cost of adding you to the spouse plan against your COBRA quote, and confirm your current doctors take the spouse plan's network.");
      break;
    case "cobra":
      a.push("Find your COBRA election notice. You have until day 60 (" + cobraDaysLeft + " days left), and election is retroactive to your loss date, so you are covered for this gap once you elect.");
      if (profile.careTier === "episode" || profile.careTier === "surveillance") {
        a.push("Tell your treating team you are electing COBRA. Your plan, network, and authorizations continue unchanged, so nothing about your care schedule needs to move.");
      }
      a.push("Budget for 102% of the full premium. If you only know your paycheck deduction, expect the real number to be roughly 3 to 5 times that.");
      if (profile.newCoverageSoon === "yes") {
        a.push("Treat COBRA as month-to-month: keep it only until your new employer coverage starts, then drop it. No penalty for doing so.");
      }
      break;
    case "aca":
      a.push(
        "Create an account at " +
          (profile.state === "CA" ? "CoveredCA.com" : "HealthCare.gov (or your state's marketplace)") +
          " and apply within your special enrollment window (" +
          acaDaysLeft +
          " days left)."
      );
      a.push("Have proof of coverage loss ready: your termination letter or the COBRA notice itself works.");
      a.push("Enter your projected 12-month income carefully, since subsidies key off it, and compare silver-tier plans first.");
      if (profile.specialtyRx) {
        a.push("Before finalizing a plan, search its formulary for your specialty prescriptions. This is the one place an ACA plan can quietly cost more than COBRA.");
      }
      break;
    case "shortterm":
      a.push("Get short-term quotes for a policy long enough to reach your new coverage start date, plus a buffer month.");
      a.push("Read the exclusions before buying: pre-existing conditions and most prescriptions are not covered.");
      a.push("Keep your COBRA election notice. If anything changes with the new job, you can still elect COBRA retroactively inside the 60-day window.");
      break;
    case "bare":
      // Every timed door is shut here, which makes this the case where a missing
      // always-open path did the most damage in v0.1. Medi-Cal leads the list.
      if (profile.state === "CA") {
        a.push("Check Medi-Cal first, before you accept being uninsured. It has no enrollment deadline, so unlike everything else here it is still open today. Apply at CoveredCA.com or your county social services office.");
      } else {
        a.push("Check your state's Medicaid program first, before you accept being uninsured. It has no enrollment deadline, so unlike everything else here it is still open today. Start at HealthCare.gov or your state's Medicaid agency.");
      }
      a.push("Mark the next ACA Open Enrollment date (November 1) on your calendar now. That is your next guaranteed on-ramp.");
      if (profile.state === "CA") {
        a.push("California has a state individual mandate, so expect a penalty at tax time. Check the current year's amount on the FTB site.");
      } else {
        a.push("There is no federal penalty for going uninsured, but one hospitalization can be financially catastrophic. Treat a coverage gap as a bridge, not a plan.");
      }
      a.push("For care in the gap: community health centers bill on a sliding scale, and GoodRx-style pricing covers many generic prescriptions.");
      break;
  }
  return a;
}

function recommend(profile) {
  const tree = timingTree(profile);
  const ranked = runScorecard(profile, tree.alive);

  // v0.1: the scorecard is the only recommender. Early exits are a UI
  // decision gated by clinchCheck; they never override the ranking.
  const recommended = ranked[0].path;
  const rationale = ranked[0].reasons.length
    ? "Top-ranked after scoring your situation: " + ranked[0].reasons.join("; ") + "."
    : "Top-ranked for your situation; nothing in your answers pushed strongly toward another path.";

  const elig = Fpl.eligibility(profile);

  return {
    windowStatus: {
      day: profile.daysSinceLoss,
      alive: tree.alive.map((p) => PATHS[p]),
      closed: tree.closed.map((c) => ({ label: PATHS[c.path], reason: c.reason })),
      // Never fold these into `closed`. A path we could not evaluate is not a
      // path we ruled out, and the difference is the whole bug this release fixes.
      // Outside CA the unassessed path is the user's own state's Medicaid, so it
      // must not carry California's program name.
      unresolved: tree.unresolved.map((u) => ({
        label:
          u.path === "medical" && profile.state !== "CA"
            ? "Medicaid (your state's program)"
            : PATHS[u.path],
        reason: u.reason,
      })),
    },
    ranked,
    recommended: { path: recommended, label: PATHS[recommended] },
    rationale,
    actions: nextActions(profile, recommended),
    householdNotes: householdNotes(profile),
    // Outside CA the Medi-Cal determinations are meaningless (different
    // programs, thresholds, and for HI/AK different FPL tables), so they are
    // nulled rather than reported. The subsidy trilean stays: the ACA subsidy
    // structure is federal and the band heuristic is already disclosed as rough.
    eligibility: {
      incomeKnown: elig.known,
      fplPercent:
        profile.state !== "CA" || elig.fplPercentMedical === null
          ? null
          : Math.round(elig.fplPercentMedical),
      medicalAdults: profile.state === "CA" ? elig.adults : null,
      medicalPregnancy: profile.state === "CA" ? elig.pregnancy : null,
      medicalKids: profile.state === "CA" ? elig.kids : null,
      subsidy: elig.subsidy,
    },
    cobraEstimate: profile.totalPremium ? Math.round(profile.totalPremium * 1.02) : null,
  };
}

const NavScoring = { PATHS, FIELD_DOMAINS, timingTree, runScorecard, clinchCheck, recommend, spouseSepOpen, householdNotes };

if (typeof module !== "undefined" && module.exports) module.exports = NavScoring;
if (typeof window !== "undefined") window.NavScoring = NavScoring;
