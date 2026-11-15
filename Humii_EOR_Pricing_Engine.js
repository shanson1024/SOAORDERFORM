// Humii EOR pricing engine: the rate card and the quote math, with no UI.
// The UI lives in Humii_EOR_Pricing.jsx.

// ---------------------------------------------------------------------------
// RATE CARD
// Every Humii-specific number below is a PLACEHOLDER until the real rate card
// is entered. Set `placeholder: false` once it is, and the warning banner in
// the UI goes away. Federal tax figures are statutory (2026).
// ---------------------------------------------------------------------------
export const RATE_CARD = {
  placeholder: true,
  effectiveDate: "2026-01-01",

  adminFee: {
    // Tier is picked by total headcount: the last tier whose minEmployees
    // is <= headcount applies to every employee.
    pepmTiers: [
      { minEmployees: 1, rate: 150 },
      { minEmployees: 10, rate: 135 },
      { minEmployees: 25, rate: 120 },
      { minEmployees: 50, rate: 105 },
      { minEmployees: 100, rate: 95 },
    ],
    // Rate is a fraction of gross payroll (0.04 = 4%).
    percentTiers: [
      { minEmployees: 1, rate: 0.04 },
      { minEmployees: 10, rate: 0.035 },
      { minEmployees: 25, rate: 0.03 },
      { minEmployees: 50, rate: 0.0275 },
      { minEmployees: 100, rate: 0.025 },
    ],
    // Floor on the monthly admin fee, either model. 0 disables it.
    minimumMonthly: 500,
  },

  // One-time implementation fee.
  setup: { flat: 500, perEmployee: 50 },

  // Statutory employer-side federal taxes, 2026.
  federalTaxes: {
    socialSecurity: { rate: 0.062, wageBase: 184500 },
    medicare: { rate: 0.0145 },
    // 0.6% assumes the full 5.4% state credit (no credit-reduction state).
    futa: { rate: 0.006, wageBase: 7000 },
  },

  // State unemployment. States not listed in byState use the default.
  // Example entry: TX: { rate: 0.027, wageBase: 9000 }
  suta: {
    defaultRate: 0.027,
    defaultWageBase: 7000,
    byState: {},
  },

  // Workers' comp, dollars per $100 of payroll.
  workersComp: {
    classCodes: [
      { code: "8810", description: "Clerical office", ratePer100: 0.2 },
      { code: "8742", description: "Outside sales", ratePer100: 0.4 },
      { code: "8017", description: "Retail store", ratePer100: 1.5 },
      { code: "9082", description: "Restaurant", ratePer100: 1.8 },
      { code: "7380", description: "Drivers", ratePer100: 6.5 },
      { code: "5645", description: "Carpentry, residential", ratePer100: 9.0 },
    ],
  },

  // unit "pepm" = per employee per month, "monthly" = flat per month.
  addOns: [
    { id: "hr", label: "Dedicated HR business partner", unit: "pepm", rate: 15 },
    { id: "401k", label: "401(k) administration", unit: "pepm", rate: 8 },
    { id: "time", label: "Time and attendance", unit: "pepm", rate: 5 },
    { id: "lms", label: "Training and compliance library", unit: "monthly", rate: 150 },
  ],
};

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

const cents = n => Math.round((n + Number.EPSILON) * 100) / 100;
const num = v => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function pickTier(tiers, headcount) {
  let chosen = tiers[0];
  for (const t of tiers) if (headcount >= t.minEmployees) chosen = t;
  return chosen;
}

export function getSuta(state, rateCard = RATE_CARD) {
  const s = rateCard.suta.byState[state];
  return {
    rate: s?.rate ?? rateCard.suta.defaultRate,
    wageBase: s?.wageBase ?? rateCard.suta.defaultWageBase,
    isDefault: !s,
  };
}

/**
 * Price an EOR quote.
 *
 * input = {
 *   feeModel: "pepm" | "percent",
 *   state: "TX",
 *   groups: [{ label, headcount, avgAnnualWage, wcCode }],
 *   addOnIds: ["hr", ...],
 * }
 *
 * Wage-base caps (Social Security, FUTA, SUTA) are applied to each group's
 * average wage, so split a group when its wages straddle a cap.
 * Monthly figures are annual / 12; in practice capped taxes fall early in
 * the year rather than evenly.
 */
export function calculateQuote(input, rateCard = RATE_CARD) {
  const groups = (input.groups || [])
    .map(g => ({
      label: g.label || "",
      headcount: Math.floor(num(g.headcount)),
      wage: num(g.avgAnnualWage),
      wcCode: g.wcCode || "",
    }))
    .filter(g => g.headcount > 0);

  const headcount = groups.reduce((s, g) => s + g.headcount, 0);
  const annualPayroll = groups.reduce((s, g) => s + g.headcount * g.wage, 0);
  const fed = rateCard.federalTaxes;
  const suta = getSuta(input.state, rateCard);
  const pct = r => `${+(r * 100).toFixed(3)}%`;
  const usd = n => `$${n.toLocaleString("en-US")}`;

  const capped = base => groups.reduce((s, g) => s + g.headcount * Math.min(g.wage, base), 0);

  const lines = [];
  const add = (key, section, label, detail, annual) =>
    lines.push({ key, section, label, detail, annual: cents(annual), monthly: cents(annual / 12) });

  // --- Admin fee ---
  const isPercent = input.feeModel === "percent";
  let adminAnnual = 0;
  let adminDetail = "";
  let minimumApplied = false;
  if (headcount > 0) {
    if (isPercent) {
      const tier = pickTier(rateCard.adminFee.percentTiers, headcount);
      adminAnnual = annualPayroll * tier.rate;
      adminDetail = `${pct(tier.rate)} of gross payroll`;
    } else {
      const tier = pickTier(rateCard.adminFee.pepmTiers, headcount);
      adminAnnual = tier.rate * headcount * 12;
      adminDetail = `${usd(tier.rate)} PEPM x ${headcount} employees`;
    }
    const floor = rateCard.adminFee.minimumMonthly * 12;
    if (adminAnnual < floor) {
      adminAnnual = floor;
      minimumApplied = true;
      adminDetail = `${usd(rateCard.adminFee.minimumMonthly)} monthly minimum applied`;
    }
  }
  add("admin", "fees", "EOR admin fee", adminDetail, adminAnnual);

  // --- Add-ons ---
  const selected = new Set(input.addOnIds || []);
  for (const a of rateCard.addOns) {
    if (!selected.has(a.id) || headcount === 0) continue;
    const annual = a.unit === "pepm" ? a.rate * headcount * 12 : a.rate * 12;
    const detail = a.unit === "pepm" ? `${usd(a.rate)} PEPM x ${headcount} employees` : `${usd(a.rate)} per month`;
    add(`addon:${a.id}`, "fees", a.label, detail, annual);
  }

  // --- Employer payroll taxes ---
  add("ss", "taxes", "Social Security (employer)",
    `${pct(fed.socialSecurity.rate)} up to ${usd(fed.socialSecurity.wageBase)} per employee`,
    capped(fed.socialSecurity.wageBase) * fed.socialSecurity.rate);
  add("medicare", "taxes", "Medicare (employer)", `${pct(fed.medicare.rate)} of all wages`,
    annualPayroll * fed.medicare.rate);
  add("futa", "taxes", "FUTA", `${pct(fed.futa.rate)} on first ${usd(fed.futa.wageBase)} per employee`,
    capped(fed.futa.wageBase) * fed.futa.rate);
  add("suta", "taxes", `SUTA${input.state ? ` (${input.state})` : ""}`,
    `${pct(suta.rate)} on first ${usd(suta.wageBase)} per employee${suta.isDefault ? ", default rate" : ""}`,
    capped(suta.wageBase) * suta.rate);

  // --- Workers' comp ---
  const wcByCode = new Map();
  const unratedGroups = [];
  for (const g of groups) {
    const cls = rateCard.workersComp.classCodes.find(c => c.code === g.wcCode);
    if (!cls) { unratedGroups.push(g.label || "Unnamed group"); continue; }
    const cur = wcByCode.get(cls.code) || { cls, payroll: 0 };
    cur.payroll += g.headcount * g.wage;
    wcByCode.set(cls.code, cur);
  }
  for (const { cls, payroll } of wcByCode.values()) {
    add(`wc:${cls.code}`, "wc", `Workers' comp ${cls.code} ${cls.description}`,
      `$${cls.ratePer100.toFixed(2)} per $100 on ${usd(Math.round(payroll))} payroll`,
      (payroll / 100) * cls.ratePer100);
  }

  // --- Totals ---
  const sum = section => cents(lines.filter(l => l.section === section).reduce((s, l) => s + l.annual, 0));
  const feesAnnual = sum("fees");
  const taxesAnnual = sum("taxes");
  const wcAnnual = sum("wc");
  const annualTotal = cents(feesAnnual + taxesAnnual + wcAnnual);
  const setupFee = headcount > 0 ? cents(rateCard.setup.flat + rateCard.setup.perEmployee * headcount) : 0;

  return {
    headcount,
    annualPayroll: cents(annualPayroll),
    lines,
    feesAnnual,
    taxesAnnual,
    wcAnnual,
    annualTotal,
    monthlyTotal: cents(annualTotal / 12),
    setupFee,
    firstYearTotal: cents(annualTotal + setupFee),
    minimumApplied,
    unratedGroups,
    // EOR fees only (admin + add-ons), the number a client compares across EOR providers.
    effectivePepm: headcount ? cents(feesAnnual / 12 / headcount) : 0,
    effectivePercentOfPayroll: annualPayroll ? feesAnnual / annualPayroll : 0,
  };
}
