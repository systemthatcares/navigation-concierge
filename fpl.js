/*
 * Navigation Concierge — federal poverty level spine (2026-08-17)
 *
 * Every coverage program in this consult keys off the same quantity: household
 * income as a percentage of the federal poverty level. This module computes it
 * once and exposes the cut lines each program reads it at.
 *
 * Why this exists: v0.1 asked for an income *band* ("under $40k") and derived a
 * single `subsidyLikely` trilean from it. That band cannot separate a family of
 * four at 130% FPL (Medi-Cal eligible) from a single person at 245% FPL (not
 * eligible, not close) — both answer "under $40k". Household size was collected
 * and then discarded. Every downstream error traced back to that loss.
 *
 * TWO VINTAGES ARE LIVE AT ONCE. This is the trap in this domain:
 *   - Medi-Cal (MAGI programs) moved to the 2026 guidelines on 2026-01-01.
 *   - Covered California keeps using the 2025 guidelines through 2026-10-31,
 *     because its FPLs turn over at open enrollment, not on the calendar year.
 * A single-table implementation is silently wrong for one program most of the
 * year. Callers pass the program, not the year.
 *
 * Sources:
 *   - HHS 2026 poverty guidelines (Federal Register, 2026-01-15): base $15,960,
 *     +$5,680 per additional person, 48 contiguous states + DC.
 *   - HHS 2025 poverty guidelines (Federal Register, 2025-01-17): base $15,650,
 *     +$5,500 per additional person.
 *   - California Insurance Affordability Programs Income Levels, Health Consumer
 *     Alliance, updated 2026-02-16 — the per-program CA cut lines below.
 *
 * VERIFY BEFORE SHIP (open items, deliberately visible rather than silent):
 *   - The HCA chart's own footnote says "add $5,500/year per additional person"
 *     while its columns step by $5,680. The $5,500 is the 2025 increment left in
 *     a 2026 document. Columns win; this is noted so a reviewer does not
 *     "correct" it back.
 *   - Households above 6 are extrapolated, not published. Flagged at runtime.
 *   - The two children's cut lines (160% and 266%) carry the same program label
 *     on the HCA chart. Treated here as free Medi-Cal up to 160% and the
 *     premium-charging Targeted Low Income tier from 160% to 266%. CONFIRM.
 *   - Non-MAGI pathways (aged, blind, disabled; asset test reinstated 2026-01-01)
 *     are out of scope. A user on those pathways is not modeled here.
 */

// 100% FPL, annual, 48 contiguous states + DC, by household size.
const FPL_BASE = {
  2026: { one: 15960, increment: 5680 },
  2025: { one: 15650, increment: 5500 },
};

// Which guideline vintage each program reads, as of 2026-08-17.
// Covered California flips to the 2026 table on 2026-11-01 (open enrollment).
const PROGRAM_VINTAGE = {
  medical: 2026,
  coveredca: 2025,
};

// Program cut lines, as a percentage of FPL.
const CUT_LINES = {
  medicalAdults: 138, // MAGI Medi-Cal expansion adults, 19-64
  medicalPregnancy: 213, // MAGI Medi-Cal pregnancy-related
  medicalKidsFree: 160, // MAGI Medi-Cal, children to 19
  medicalKidsTlicp: 266, // Targeted Low Income Children's Program, to 19
  subsidyCliff: 400, // Covered CA premium tax credits (restored cliff)
};

// Published CA annual thresholds, household sizes 1-6 (HCA chart, 2026-02-16).
// Held verbatim rather than computed: the published figures already carry the
// 5% income disregard and California's round-up rule, and reproducing those by
// arithmetic would drift from what a county eligibility worker actually applies.
const PUBLISHED_2026 = {
  medicalAdults: [22025, 29864, 37702, 45540, 53379, 61217],
  medicalPregnancy: [33995, 46094, 58192, 70290, 82389, 94487],
  medicalKidsFree: [25536, 34624, 43712, 52800, 61888, 70976],
  medicalKidsTlicp: [42454, 57563, 72672, 87780, 102889, 117998],
};

function fplAmount(householdSize, year) {
  const base = FPL_BASE[year];
  if (!base) throw new Error("no FPL table for year " + year);
  const n = Math.max(1, Math.floor(householdSize || 1));
  return base.one + (n - 1) * base.increment;
}

/*
 * Income as a percentage of FPL, for the vintage the given program reads.
 * Returns null when income is unknown — callers must treat null as "unresolved",
 * never as zero.
 */
function fplPercent(annualIncome, householdSize, program) {
  if (annualIncome === null || annualIncome === undefined) return null;
  const year = PROGRAM_VINTAGE[program];
  if (!year) throw new Error("unknown program " + program);
  return (annualIncome / fplAmount(householdSize, year)) * 100;
}

/*
 * The published threshold for a program at a household size, or null when the
 * household is larger than the published table. Callers extrapolate and flag.
 */
function publishedThreshold(cutLine, householdSize) {
  const table = PUBLISHED_2026[cutLine];
  const n = Math.max(1, Math.floor(householdSize || 1));
  if (!table || n > table.length) return null;
  return table[n - 1];
}

/*
 * Whether a Medi-Cal cut line is met. Compares against the published dollar
 * threshold where one exists (authoritative), and falls back to percentage
 * arithmetic above household size 6.
 */
function meetsMedical(cutLine, annualIncome, householdSize) {
  if (annualIncome === null || annualIncome === undefined) {
    return { met: null, extrapolated: false };
  }
  const published = publishedThreshold(cutLine, householdSize);
  if (published !== null) {
    return { met: annualIncome <= published, extrapolated: false };
  }
  const pct = fplPercent(annualIncome, householdSize, "medical");
  return { met: pct <= CUT_LINES[cutLine], extrapolated: true };
}

/*
 * Full eligibility read for a profile. Every field is three-valued: true, false,
 * or null for "we do not know". null is the whole point of this module — an
 * unknown must stay unknown all the way to the clinch check, which is what stops
 * the engine from claiming certainty it has not earned.
 *
 * `na` is used where a determination does not apply to this household at all
 * (no children present, nobody pregnant), which is different from unknown.
 */
function eligibility(profile) {
  const income = profile.annualIncome === undefined ? null : profile.annualIncome;
  const size = profile.householdSize || 1;
  const known = income !== null;

  const adults = meetsMedical("medicalAdults", income, size);
  const pregnancy = profile.pregnancyInHousehold
    ? meetsMedical("medicalPregnancy", income, size)
    : { met: "na", extrapolated: false };
  const kidsFree = profile.hasKids
    ? meetsMedical("medicalKidsFree", income, size)
    : { met: "na", extrapolated: false };
  const kidsTlicp = profile.hasKids
    ? meetsMedical("medicalKidsTlicp", income, size)
    : { met: "na", extrapolated: false };

  let kids = "na";
  if (profile.hasKids) {
    if (!known) kids = null;
    else if (kidsFree.met) kids = "free";
    else if (kidsTlicp.met) kids = "tlicp";
    else kids = "not";
  }

  // Covered California subsidy, read against the 2025 table until 2026-11-01.
  // Below the Medi-Cal adult line there is no marketplace subsidy: that
  // household is sent to Medi-Cal instead. Above 400% the restored cliff bites.
  let subsidy = null;
  if (known) {
    const pct = fplPercent(income, size, "coveredca");
    if (adults.met) subsidy = "medical_instead";
    else if (pct > CUT_LINES.subsidyCliff) subsidy = "over_cliff";
    else subsidy = "eligible";
  }

  return {
    known,
    fplPercentMedical: fplPercent(income, size, "medical"),
    fplPercentCoveredCa: fplPercent(income, size, "coveredca"),
    adults: adults.met,
    pregnancy: pregnancy.met,
    kids,
    subsidy,
    extrapolatedHousehold: size > 6,
    thresholds: {
      medicalAdults: publishedThreshold("medicalAdults", size),
      medicalPregnancy: publishedThreshold("medicalPregnancy", size),
      medicalKidsFree: publishedThreshold("medicalKidsFree", size),
      medicalKidsTlicp: publishedThreshold("medicalKidsTlicp", size),
    },
  };
}

/*
 * The v0.1 trilean, now derived from real arithmetic instead of a band guess.
 * Kept because the scorecard's subsidy row reads it, and because "unsure" is
 * still a legitimate state when income is unknown.
 */
function subsidyLikely(profile) {
  const e = eligibility(profile);
  if (!e.known) return "unsure";
  if (e.subsidy === "eligible") return "yes";
  return "no";
}

const NavFpl = {
  FPL_BASE,
  PROGRAM_VINTAGE,
  CUT_LINES,
  PUBLISHED_2026,
  fplAmount,
  fplPercent,
  publishedThreshold,
  meetsMedical,
  eligibility,
  subsidyLikely,
};

if (typeof module !== "undefined" && module.exports) module.exports = NavFpl;
if (typeof window !== "undefined") window.NavFpl = NavFpl;
