/*
 * Navigation Concierge — guided consult flow (v0)
 * Question order follows the Block 1 memo:
 *   Stage 1 gates -> Stage 2 short-circuits -> Stage 3 ranking -> Stage 4 output.
 * All scoring is delegated to scoring.js (deterministic). This file only talks.
 */

const chat = document.getElementById("chat-wrap");
const controls = document.getElementById("controls-inner");

const profile = {
  daysSinceLoss: 0, state: "CA", hasSpouse: false, spouseBenefits: false,
  spousePlan60Day: false, careTier: "none", specialtyRx: false,
  newCoverageSoon: "no", totalPremium: null,
  householdSize: 1, annualIncome: null, hasKids: false, pregnancyInHousehold: false,
};

// One early-exit offer per consult, and only when clinchCheck proves the
// remaining scoring questions cannot change the winner.
let clinchOfferMade = false;
let exitedEarly = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scrollDown() { window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }

async function agentSay(html, cls = "agent") {
  const t = document.createElement("div");
  t.className = "msg agent";
  t.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  chat.appendChild(t); scrollDown();
  await sleep(550 + Math.min(html.length * 3, 700));
  t.className = "msg " + cls;
  t.innerHTML = html;
  scrollDown();
}

function userSay(text) {
  const m = document.createElement("div");
  m.className = "msg user";
  m.textContent = text;
  chat.appendChild(m); scrollDown();
}

function ask(options) {
  return new Promise((resolve) => {
    controls.innerHTML = "";
    for (const opt of options) {
      const b = document.createElement("button");
      b.className = "chip" + (opt.primary ? " primary" : "");
      b.textContent = opt.label;
      b.onclick = () => {
        if (opt.href) { window.open(opt.href, "_blank", "noopener"); return; }
        controls.innerHTML = ""; userSay(opt.label); resolve(opt.value);
      };
      controls.appendChild(b);
    }
    scrollDown();
  });
}

function askNumber(placeholder, chips = []) {
  return new Promise((resolve) => {
    controls.innerHTML = "";
    for (const c of chips) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = c.label;
      b.onclick = () => { controls.innerHTML = ""; userSay(c.label); resolve(c.value); };
      controls.appendChild(b);
    }
    const input = document.createElement("input");
    input.className = "free"; input.type = "number"; input.min = "0"; input.placeholder = placeholder;
    const go = document.createElement("button");
    go.className = "chip primary"; go.textContent = "Send";
    const submit = () => {
      const v = parseFloat(input.value);
      if (isNaN(v) || v < 0) return;
      controls.innerHTML = ""; userSay(input.value); resolve(v);
    };
    go.onclick = submit;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    controls.appendChild(input); controls.appendChild(go);
    input.focus(); scrollDown();
  });
}

const YN = [ { label: "Yes", value: true }, { label: "No", value: false } ];

async function stage1Gates() {
  await agentSay("Hi, I'm your coverage navigator. You answer a few questions, I map which paths are still open to you and which one fits your situation best. Takes about two minutes.");
  // Entrance disclaimer (ruled 2026-08-31, wording signed off 2026-09-01).
  await agentSay("One note before we start: this is educational information from a physician, not medical, legal, or insurance advice, and it does not sell or enroll you in anything. Your answers stay on your device. Nothing is stored or sent anywhere.", "note");
  await agentSay("<b>First: about how many days ago did your employer coverage end?</b> A rough number is fine.");
  profile.daysSinceLoss = await askNumber("days ago", [
    { label: "About a week", value: 7 },
    { label: "About a month", value: 30 },
    { label: "Two months or more", value: 65 },
  ]);

  await agentSay("<b>Which state do you live in?</b>");
  profile.state = await ask([
    { label: "California", value: "CA", primary: true },
    { label: "Another state", value: "OTHER" },
  ]);
  if (profile.state !== "CA") {
    await agentSay("This consult is built for California. The enrollment-window rules apply everywhere, but the Medicaid and subsidy math is California-only, so outside California I will point you to your state's programs rather than guess. One difference: short-term plans may be available in your state, so I'll keep that option on the table.", "note");
  }

  await agentSay("<b>Who needs coverage in your household?</b>");
  const hh = await ask([
    { label: "Just me", value: { spouse: false, kids: false } },
    { label: "Me and my spouse/partner", value: { spouse: true, kids: false } },
    { label: "Me, spouse, and kids", value: { spouse: true, kids: true } },
    { label: "Me and my kids", value: { spouse: false, kids: true } },
  ]);
  profile.hasSpouse = hh.spouse;
  profile.hasKids = hh.kids;
  // v0.2: count the children rather than assuming two. Household size sets the
  // dollar threshold for every program now, so a wrong count moves a real cut line.
  let nKids = 0;
  if (hh.kids) {
    await agentSay("<b>How many children need coverage?</b> This sets the income limit for every program, so the exact count matters.");
    nKids = Math.max(1, await askNumber("e.g. 2", [
      { label: "One", value: 1 },
      { label: "Two", value: 2 },
      { label: "Three", value: 3 },
    ]));
  }
  profile.householdSize = 1 + (hh.spouse ? 1 : 0) + nKids;
}

async function stage2Gates() {
  if (profile.hasSpouse) {
    await agentSay("<b>Does your spouse or partner have health benefits through their job?</b>");
    profile.spouseBenefits = await ask(YN);
    if (profile.spouseBenefits && profile.daysSinceLoss > 30 && profile.daysSinceLoss <= 60) {
      await agentSay("Losing your coverage opens a special enrollment window on their plan, but it's usually only 30 days, and you're past that. Some plans allow 60. <b>Has their HR confirmed a 60-day window?</b>");
      profile.spousePlan60Day = await ask([
        { label: "Yes, 60 days confirmed", value: true },
        { label: "No / not sure", value: false },
      ]);
    }
  }

  // v0.1: care is a tier, not a bit. Two lay-answerable questions.
  await agentSay("<b>Is anyone who needs coverage getting ongoing medical care right now?</b>");
  const gettingCare = await ask(YN);
  if (!gettingCare) {
    profile.careTier = "none";
  } else {
    await agentSay("<b>Which is closest?</b> The test: if you had to switch doctors mid-course, would it be unsafe, a real setback, or mostly paperwork?");
    profile.careTier = await ask([
      { label: "Mid-treatment: chemo, radiation, staged surgery, pregnancy, or a procedure already scheduled", value: "episode" },
      { label: "Regular monitoring with a specialist every few months", value: "surveillance" },
      { label: "Stable: ongoing prescriptions and routine checkups", value: "chronic" },
    ]);
  }
}

/*
 * Offer an early exit iff the remaining scoring questions cannot change the
 * winner (clinchCheck enumerates every combination of the unanswered fields).
 * At most one offer per consult; declining it means we ask everything.
 */
async function maybeOfferClinchExit(unansweredFields) {
  if (clinchOfferMade) return false;
  const c = NavScoring.clinchCheck(profile, unansweredFields);
  if (!c.clinched) return false;
  clinchOfferMade = true;
  await agentSay("Based on what you've told me, the remaining questions can't change the recommendation, only refine the fine print. I can show it now, or keep going.");
  const choice = await ask([
    { label: "Show my recommendation", value: "now", primary: true },
    { label: "Ask me everything", value: "full" },
  ]);
  return choice === "now";
}

async function stage3Ranking() {
  // v0.2: a number, not a band. Every program threshold is set against this and
  // household size; the old bands could not tell a family of four at 115% FPL
  // from a single person at 238%, and both answered "under $40k".
  await agentSay("<b>Roughly what do you expect your whole household to earn over the next 12 months, before taxes?</b> An estimate is fine, and it is the single most important number here. Count everyone you named, and use what you expect going forward, not last year.");
  profile.annualIncome = await askNumber("e.g. 60000", [
    { label: "About $25k", value: 25000 },
    { label: "About $60k", value: 60000 },
    { label: "About $120k", value: 120000 },
  ]);

  // Asked only when it can change the answer: pregnancy-related Medi-Cal runs
  // to 213% FPL, so it matters only between the adult line and that one.
  const eligNow = window.NavFpl.eligibility(profile);
  const pregCouldMatter =
    eligNow.adults === false &&
    window.NavFpl.meetsMedical("medicalPregnancy", profile.annualIncome, profile.householdSize).met === true;
  if (pregCouldMatter) {
    await agentSay("<b>Is anyone in your household pregnant?</b> Pregnancy-related Medi-Cal has a much higher income limit than regular Medi-Cal and no enrollment deadline, so at this income it can change the answer.");
    profile.pregnancyInHousehold = await ask(YN);
  }

  if (await maybeOfferClinchExit(["specialtyRx", "newCoverageSoon"])) { exitedEarly = true; return; }

  await agentSay("<b>Does anyone take specialty prescriptions?</b> The expensive kind that needed prior authorization or a specialty pharmacy.");
  profile.specialtyRx = await ask(YN);

  if (await maybeOfferClinchExit(["newCoverageSoon"])) { exitedEarly = true; return; }

  await agentSay("<b>Do you expect new coverage from a job within the next 90 days?</b> Yours or your spouse's.");
  profile.newCoverageSoon = await ask([
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
    { label: "Not sure", value: "unsure" },
  ]);

  await agentSay("Last one. <b>Do you know the full monthly premium your employer was paying for your plan?</b> Both your share and theirs combined. Most people only ever saw their paycheck deduction.");
  const knows = await ask([
    { label: "I know the number", value: true },
    { label: "No idea", value: false },
  ]);
  if (knows) {
    await agentSay("What's the full monthly premium, in dollars?");
    profile.totalPremium = await askNumber("e.g. 1800");
  } else {
    await agentSay("That's normal, and it's the trap: COBRA charges 102% of the full premium. If you only know your paycheck share, the real number is usually 3 to 5 times that.", "note");
  }
}

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

async function stage4Output() {
  const r = NavScoring.recommend(profile);
  await agentSay("Here's your consult. Three parts: which windows are still open, how your options rank, and what to do this week.");

  // 1. Window status
  const openPills = r.windowStatus.alive.map((l) => '<span class="pill open">' + esc(l) + "</span>").join("");
  const closedRows = r.windowStatus.closed.map((c) =>
    '<span class="pill closed">' + esc(c.label) + '</span><div class="why">' + esc(c.reason) + "</div>").join("");
  const card1 = document.createElement("div");
  card1.className = "card";
  // Unresolved paths render distinctly from closed ones. A door we could not
  // check is not a door we ruled out, and showing them the same way is what let
  // v0.1 present "go uninsured" as an exhaustive map.
  const unresolvedRows = r.windowStatus.unresolved.map((u) =>
    '<span class="pill unresolved">' + esc(u.label) + '</span><div class="why">' + esc(u.reason) + "</div>").join("");
  card1.innerHTML = "<h2>1 &middot; Window status, day " + r.windowStatus.day + "</h2>"
    + "<div>" + openPills + "</div>"
    + (unresolvedRows ? '<div style="margin-top:10px">' + unresolvedRows + "</div>" : "")
    + (closedRows ? '<div style="margin-top:10px">' + closedRows + "</div>" : "");
  chat.appendChild(card1); scrollDown();
  await sleep(700);

  // 2. Scorecard
  const max = Math.max(...r.ranked.map((x) => Math.abs(x.score)), 1);
  const rows = r.ranked.map((x) => {
    const pct = Math.max(8, Math.round((Math.abs(x.score) / max) * 100));
    const reasons = x.reasons.map((t) => '<div class="reason">' + esc(t) + "</div>").join("");
    const verifies = x.verify.map((t) => '<div class="verify">Verify: ' + esc(t) + "</div>").join("");
    return '<div class="rank-row"><div class="rank-head"><span>' + esc(x.label) + "</span><span>" + (x.score > 0 ? "+" : "") + x.score + "</span></div>"
      + '<div class="bar-track"><div class="bar' + (x.score < 0 ? " neg" : "") + '" style="width:' + pct + '%"></div></div>'
      + reasons + verifies + "</div>";
  }).join("");
  const card2 = document.createElement("div");
  card2.className = "card";
  card2.innerHTML = "<h2>2 &middot; How your situation ranks the open paths</h2>" + rows;
  chat.appendChild(card2); scrollDown();
  await sleep(700);

  // 3. Recommendation + actions
  const actions = r.actions.map((a, i) =>
    '<div class="action"><div class="n">' + (i + 1) + "</div><div>" + esc(a) + "</div></div>").join("");
  const cobraLine = r.cobraEstimate
    ? '<p class="why" style="margin-top:8px">Your estimated COBRA premium: $' + r.cobraEstimate.toLocaleString() + "/month (102% of the full premium you gave me).</p>"
    : "";
  // Per-member determinations sit outside the single-path ranking: children
  // qualify for Medi-Cal at a far higher income limit than adults, so a
  // household is not always one plan.
  const notes = r.householdNotes.length
    ? '<div class="hh-notes"><h3>Also worth knowing</h3>'
      + r.householdNotes.map((n) => '<div class="hh-note">' + esc(n) + "</div>").join("")
      + "</div>"
    : "";

  const card3 = document.createElement("div");
  card3.className = "card rec";
  card3.innerHTML = notes + "<h2>3 &middot; Recommended path</h2><h3>" + esc(r.recommended.label) + "</h3>"
    + '<p style="font-size:14.5px;line-height:1.55">' + esc(r.rationale) + "</p>" + cobraLine
    + '<h2 style="margin-top:16px">This week</h2>' + actions;
  chat.appendChild(card3); scrollDown();
  await sleep(400);

  const disc = document.createElement("footer");
  disc.className = "disclaimer";
  disc.textContent = "Educational information from a physician, not insurance, legal, or medical advice. Nothing you entered was stored or sent anywhere. Verify windows and premiums against your plan documents and your COBRA notice.";
  chat.appendChild(disc);

  await agentSay(exitedEarly
    ? "I stopped early because the remaining questions couldn't change this answer, only the fine print. The math clinched it."
    : "That ranking used everything you told me. If any answer changes, run it again; the recommendation can flip.");
  // Guide offer after the recommendation, never before it (D1, ruled 2026-08-23).
  await agentSay("Want the full written version? The free guide covers every path here in detail, including the retroactive-COBRA strategy and the notice-date rule. It's one email, no follow-ups.");
  await ask([
    { label: "Get the free guide", value: "guide", primary: true, href: "https://systemthatcares.com" },
    { label: "Start over", value: "restart" },
  ]);
  chat.innerHTML = "";
  Object.assign(profile, { daysSinceLoss: 0, state: "CA", hasSpouse: false, spouseBenefits: false, spousePlan60Day: false, careTier: "none", specialtyRx: false, newCoverageSoon: "no", totalPremium: null, householdSize: 1, annualIncome: null, hasKids: false, pregnancyInHousehold: false });
  clinchOfferMade = false;
  exitedEarly = false;
  run();
}

async function run() {
  await stage1Gates();
  await stage2Gates();
  if (await maybeOfferClinchExit(["specialtyRx", "newCoverageSoon"])) {
    exitedEarly = true;
  } else {
    await stage3Ranking();
  }
  await stage4Output();
}

run();
