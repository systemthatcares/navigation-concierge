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

const PATHS = {
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
 *   subsidyLikely   "yes" | "no" | "unsure"
 *   newCoverageSoon "yes" | "no" | "unsure"  (new employer coverage < 90 days away)
 *   totalPremium    number | null  (employer's total monthly premium if known; display-only, never scored)
 */

function timingTree(profile) {
  const d = profile.daysSinceLoss;
  const alive = [];
  const closed = [];

  // COBRA: 60 days from loss (or notice, whichever later). Election retroactive.
  if (d <= 60) alive.push("cobra");
  else closed.push({ path: "cobra", reason: "60-day COBRA election window has passed (day " + d + ")" });

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

  return { alive, closed };
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
  for (const p of alive) {
    scores[p] = p === "bare" ? -3 : 0;
    reasons[p] = p === "bare" ? ["last resort baseline (CA mandate penalty applies)"] : [];
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
  } else if (profile.careTier === "surveillance") {
    add("cobra", 1, "surveillance schedule: established specialist and intervals continue unchanged");
    verify("aca", "confirm your specialist is in the new plan's network and your monitoring schedule transfers without delay");
    verify("spouse", "confirm your specialist is in the spouse plan's network and your monitoring schedule transfers without delay");
    add("shortterm", -1, "surveillance: pre-existing condition exclusions apply to exactly this care");
    add("bare", -1, "surveillance: a skipped monitoring interval is a real clinical risk");
  } else if (profile.careTier === "chronic") {
    verify("aca", "check your regular prescriptions and current doctors against the new plan before enrolling");
    verify("spouse", "check your regular prescriptions and current doctors against the spouse plan before enrolling");
    add("shortterm", -1, "chronic condition: short-term plans exclude pre-existing conditions");
  }

  // Row 3: specialty Rx on current formulary
  if (profile.specialtyRx) {
    add("cobra", 2, "specialty Rx: current formulary access preserved");
    verify("aca", "verify your specialty Rx is on the new plan's formulary before enrolling");
    verify("spouse", "verify your specialty Rx is on the spouse plan's formulary before enrolling");
    add("shortterm", -2, "specialty Rx: short-term plans have minimal Rx coverage");
    add("bare", -2, "specialty Rx: full cash price without coverage");
  }

  // Row 4: household income, ACA subsidy-eligible
  if (profile.subsidyLikely === "yes") {
    add("cobra", -1, "subsidy-eligible income: COBRA charges the full unsubsidized premium");
    add("aca", 2, "subsidy-eligible income: ACA subsidies can undercut COBRA substantially");
    add("spouse", -1, "subsidy-eligible income: joining the spouse plan forfeits the subsidy");
  } else if (profile.subsidyLikely === "unsure") {
    verify("aca", "run your projected income through the Covered California calculator; a subsidy could change this ranking");
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
  const tieOrder = ["spouse", "aca", "cobra", "shortterm", "bare"];
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
  subsidyLikely: ["yes", "no", "unsure"],
  specialtyRx: [true, false],
  newCoverageSoon: ["yes", "no", "unsure"],
};

function clinchCheck(profile, unansweredFields) {
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
  return clinched ? { clinched: true, path: winner, label: PATHS[winner] } : { clinched: false, path: null, label: null };
}

function nextActions(profile, recommendedPath) {
  const d = profile.daysSinceLoss;
  const cobraDaysLeft = Math.max(0, 60 - d);
  const acaDaysLeft = Math.max(0, 60 - d);
  const spouseDaysLeft = Math.max(0, (profile.spousePlan60Day ? 60 : 30) - d);
  const a = [];

  switch (recommendedPath) {
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
      a.push("Create an account at CoveredCA.com and apply within your special enrollment window (" + acaDaysLeft + " days left).");
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
      a.push("Mark the next ACA Open Enrollment date (November 1) on your calendar now. That is your next guaranteed on-ramp.");
      a.push("California has a state individual mandate, so expect a penalty at tax time. Check the current year's amount on the FTB site.");
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
    : "Top-ranked for your situation with no strong compressor pushing another way.";

  return {
    windowStatus: {
      day: profile.daysSinceLoss,
      alive: tree.alive.map((p) => PATHS[p]),
      closed: tree.closed.map((c) => ({ label: PATHS[c.path], reason: c.reason })),
    },
    ranked,
    recommended: { path: recommended, label: PATHS[recommended] },
    rationale,
    actions: nextActions(profile, recommended),
    cobraEstimate: profile.totalPremium ? Math.round(profile.totalPremium * 1.02) : null,
  };
}

const NavScoring = { PATHS, timingTree, runScorecard, clinchCheck, recommend, spouseSepOpen };

if (typeof module !== "undefined" && module.exports) module.exports = NavScoring;
if (typeof window !== "undefined") window.NavScoring = NavScoring;
