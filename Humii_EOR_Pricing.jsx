import { useMemo, useState } from "react";
import { HUMII_LOGO } from "./Humii_Logo.js";
import { RATE_CARD, US_STATES, calculateQuote } from "./Humii_EOR_Pricing_Engine.js";

const C = {
  ink: "#14213D",
  primary: "#183780", // Humii navy: buttons, labels
  accent: "#306EFF", // Humii blue: rules, highlights
  tint: "#EEF3FF",
  bg: "#F5F7FB",
  white: "#FFFFFF",
  border: "#D5DCE8",
  muted: "#667085",
  warnBg: "#FFF6E5",
  warnText: "#8A5A00",
  error: "#B42318",
};
const FONT = "'DM Sans', system-ui, sans-serif";

const money = n => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const money0 = n => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const field = {
  width: "100%", padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 6,
  fontSize: 14, fontFamily: FONT, color: C.ink, background: C.white, boxSizing: "border-box",
};
const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 4 };
const card = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, marginBottom: 16 };
const h2 = { fontSize: 15, fontWeight: 700, color: C.ink, margin: "0 0 14px" };

let nextId = 1;
const newGroup = (label = "", wcCode = "") => ({ id: nextId++, label, headcount: "", avgAnnualWage: "", wcCode });

const SECTIONS = [
  { key: "fees", title: "Humii fees" },
  { key: "taxes", title: "Employer payroll taxes" },
  { key: "wc", title: "Workers' compensation" },
];

function QuoteTable({ quote, rateCard }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 520 }}>
        <thead>
          <tr style={{ textAlign: "right", color: C.muted, fontSize: 12 }}>
            <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600 }}>Item</th>
            <th style={{ padding: "6px 0", fontWeight: 600 }}>Monthly</th>
            <th style={{ padding: "6px 0", fontWeight: 600 }}>Annual</th>
          </tr>
        </thead>
        <tbody>
          {SECTIONS.map(sec => {
            const rows = quote.lines.filter(l => l.section === sec.key);
            if (!rows.length) return null;
            const subtotal = quote[`${sec.key}Annual`];
            return [
              <tr key={sec.key}>
                <td colSpan={3} style={{ padding: "12px 0 4px", fontWeight: 700, fontSize: 12, letterSpacing: 0.6, textTransform: "uppercase", color: C.primary }}>
                  {sec.title}
                </td>
              </tr>,
              ...rows.map(l => (
                <tr key={l.key} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "8px 0" }}>
                    {l.label}
                    <div style={{ fontSize: 12, color: C.muted }}>{l.detail}</div>
                  </td>
                  <td style={{ textAlign: "right", verticalAlign: "top", padding: "8px 0" }}>{money(l.monthly)}</td>
                  <td style={{ textAlign: "right", verticalAlign: "top", padding: "8px 0" }}>{money(l.annual)}</td>
                </tr>
              )),
              <tr key={`${sec.key}-sub`} style={{ borderTop: `1px solid ${C.border}`, fontWeight: 600 }}>
                <td style={{ padding: "8px 0" }}>Subtotal</td>
                <td style={{ textAlign: "right", padding: "8px 0" }}>{money(subtotal / 12)}</td>
                <td style={{ textAlign: "right", padding: "8px 0" }}>{money(subtotal)}</td>
              </tr>,
            ];
          })}
          <tr style={{ borderTop: `2px solid ${C.ink}`, fontWeight: 700, fontSize: 16 }}>
            <td style={{ padding: "12px 0" }}>Total recurring cost</td>
            <td style={{ textAlign: "right", padding: "12px 0" }}>{money(quote.monthlyTotal)}</td>
            <td style={{ textAlign: "right", padding: "12px 0" }}>{money(quote.annualTotal)}</td>
          </tr>
          <tr style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={{ padding: "8px 0" }}>
              One-time setup fee
              <div style={{ fontSize: 12, color: C.muted }}>
                {money0(rateCard.setup.flat)} + {money0(rateCard.setup.perEmployee)} per employee
              </div>
            </td>
            <td />
            <td style={{ textAlign: "right", verticalAlign: "top", padding: "8px 0" }}>{money(quote.setupFee)}</td>
          </tr>
          <tr style={{ borderTop: `1px solid ${C.border}`, fontWeight: 700 }}>
            <td style={{ padding: "8px 0" }}>First-year total</td>
            <td />
            <td style={{ textAlign: "right", padding: "8px 0" }}>{money(quote.firstYearTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const longDate = d => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

// Prospect-facing pricing exhibit. Shows pricing only: no internal margin
// metrics, no editing controls. Prints as a clean document.
function Exhibit({ quote, rateCard, client, state, feeModel, groups, preparedBy, validDays, reference, onBack }) {
  const today = new Date();
  const expires = new Date(today.getTime() + validDays * 86400000);
  const wcDesc = code => {
    const c = rateCard.workersComp.classCodes.find(x => x.code === code);
    return c ? `${c.code} ${c.description}` : "Not rated";
  };
  const meta = [
    ["Prepared for", client || "Prospective client"],
    ["Exhibit reference", reference || "Not assigned"],
    ["Date", longDate(today)],
    ["Pricing valid through", longDate(expires)],
    ["Prepared by", preparedBy || "Humii"],
    ["Fee structure", feeModel === "percent" ? "Percentage of gross payroll" : "Per employee per month"],
  ];
  const cell = { padding: "7px 0", borderTop: `1px solid ${C.border}` };
  return (
    <div className="exhibit-root" style={{ background: C.bg, minHeight: "100vh", fontFamily: FONT, color: C.ink, padding: "24px 16px" }}>
      <style>{`@media print { .no-print { display: none !important; } .exhibit-page { border: none !important; padding: 0 !important; } .exhibit-root { background: #fff !important; padding: 0 !important; } } @page { margin: 0.6in; }`}</style>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div className="no-print" style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <button type="button" onClick={onBack} style={{ border: `1.5px solid ${C.border}`, background: C.white, color: C.ink, fontWeight: 600, fontFamily: FONT, fontSize: 14, padding: "10px 18px", borderRadius: 6, cursor: "pointer" }}>
            ← Back to quote
          </button>
          <button type="button" onClick={() => window.print()} style={{ border: "none", background: C.primary, color: C.white, fontWeight: 700, fontFamily: FONT, fontSize: 14, padding: "10px 22px", borderRadius: 6, cursor: "pointer" }}>
            Print / save as PDF
          </button>
        </div>

        <div className="exhibit-page" style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: "36px 40px" }}>
          {rateCard.placeholder && (
            <div style={{ background: C.warnBg, color: C.warnText, borderRadius: 6, padding: "8px 12px", fontSize: 13, fontWeight: 700, marginBottom: 18, textAlign: "center", letterSpacing: 1 }}>
              DRAFT · SAMPLE RATES · NOT FOR DISTRIBUTION
            </div>
          )}
          <div style={{ borderBottom: `3px solid ${C.accent}`, paddingBottom: 14, marginBottom: 18 }}>
            <img src={HUMII_LOGO} alt="Humii" style={{ height: 44, display: "block" }} />
            <h1 style={{ fontSize: 24, margin: "12px 0 0" }}>Exhibit A: Employer of Record (EOR) Service Pricing</h1>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "10px 24px", marginBottom: 22 }}>
            {meta.map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.6 }}>{k}</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{v}</div>
              </div>
            ))}
          </div>

          <h2 style={h2}>Covered workforce</h2>
          <div style={{ overflowX: "auto", marginBottom: 22 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 480 }}>
              <thead>
                <tr style={{ color: C.muted, fontSize: 12, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600 }}>Group</th>
                  <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 600 }}>Workers' comp class</th>
                  <th style={{ padding: "6px 0", fontWeight: 600 }}>Employees</th>
                  <th style={{ padding: "6px 0", fontWeight: 600 }}>Annual payroll</th>
                </tr>
              </thead>
              <tbody>
                {groups.filter(g => Number(g.headcount) > 0).map(g => (
                  <tr key={g.id}>
                    <td style={cell}>{g.label || "Employees"}</td>
                    <td style={cell}>{wcDesc(g.wcCode)}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{Math.floor(Number(g.headcount))}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{money0(Math.floor(Number(g.headcount)) * (Number(g.avgAnnualWage) || 0))}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td style={{ ...cell, borderTop: `2px solid ${C.ink}` }} colSpan={2}>Total</td>
                  <td style={{ ...cell, borderTop: `2px solid ${C.ink}`, textAlign: "right" }}>{quote.headcount}</td>
                  <td style={{ ...cell, borderTop: `2px solid ${C.ink}`, textAlign: "right" }}>{money0(quote.annualPayroll)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2 style={{ ...h2, marginBottom: 4 }}>Pricing</h2>
          <QuoteTable quote={quote} rateCard={rateCard} />

          <h2 style={{ ...h2, marginTop: 22 }}>Assumptions</h2>
          <ul style={{ fontSize: 12.5, color: C.muted, paddingLeft: 18, margin: 0, lineHeight: 1.6 }}>
            <li>Humii acts as the employer of record for the covered workforce and remits the payroll taxes and workers' compensation shown here.</li>
            <li>Pricing is an estimate based on the headcount, wages and job classifications shown above. Final charges follow actual payroll.</li>
            <li>Employer payroll taxes and workers' compensation are pass-through costs shown for budgeting. Tax rates and wage bases are set by federal and state agencies and may change.</li>
            <li>Monthly amounts are the annual estimate divided by 12. Taxes with annual wage caps are collected earlier in the year.</li>
            <li>Workers' compensation rates are subject to underwriting review and final classification.</li>
            <li>Employee benefit plan costs are not included in this exhibit.</li>
          </ul>

          <div className="signature-block" style={{ marginTop: 28, breakInside: "avoid", pageBreakInside: "avoid" }}>
            <h2 style={h2}>Acceptance</h2>
            <p style={{ fontSize: 13, lineHeight: 1.6, margin: "0 0 8px" }}>
              By signing below, {client || "Client"} and Humii agree to the pricing set out in this Exhibit A, which forms
              part of the Employer of Record services agreement between them. This pricing is valid if signed on or
              before {longDate(expires)}.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0 40px" }}>
              {[client || "Client", "Humii"].map(party => (
                <div key={party}>
                  <div style={{ fontSize: 14, fontWeight: 700, marginTop: 14 }}>{party}</div>
                  {["Signature", "Printed name", "Title", "Date"].map(f => (
                    <div key={f}>
                      <div style={{ borderBottom: `1px solid ${C.ink}`, height: f === "Signature" ? 34 : 22 }} />
                      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.6, paddingTop: 3 }}>{f}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HumiiEorPricing({ rateCard = RATE_CARD }) {
  const [client, setClient] = useState("");
  const [state, setState] = useState("");
  const [feeModel, setFeeModel] = useState("pepm");
  const [groups, setGroups] = useState([newGroup("Office staff", rateCard.workersComp.classCodes[0]?.code)]);
  const [addOnIds, setAddOnIds] = useState([]);
  const [preparedBy, setPreparedBy] = useState("");
  const [validDays, setValidDays] = useState(30);
  const [reference, setReference] = useState(() => `EOR-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`);
  const [view, setView] = useState("builder");

  const quote = useMemo(
    () => calculateQuote({ feeModel, state, groups, addOnIds }, rateCard),
    [feeModel, state, groups, addOnIds, rateCard]
  );

  const updateGroup = (id, key, value) => setGroups(gs => gs.map(g => (g.id === id ? { ...g, [key]: value } : g)));
  const toggleAddOn = id => setAddOnIds(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]));
  const ready = quote.headcount > 0 && quote.annualPayroll > 0;

  if (view === "exhibit" && ready) {
    return (
      <Exhibit
        quote={quote} rateCard={rateCard} client={client} state={state} feeModel={feeModel} groups={groups}
        preparedBy={preparedBy} reference={reference} validDays={Number(validDays) > 0 ? Number(validDays) : 30} onBack={() => setView("builder")}
      />
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: FONT, color: C.ink, padding: "24px 16px" }}>
      <style>{`@media print { .no-print { display: none !important; } }`}</style>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <header style={{ marginBottom: 20 }}>
          <img src={HUMII_LOGO} alt="Humii" style={{ height: 44, display: "block" }} />
          <h1 style={{ fontSize: 26, margin: "10px 0 2px" }}>EOR Pricing Quote</h1>
          <div style={{ fontSize: 13, color: C.muted }}>
            Rate card effective {rateCard.effectiveDate} · Internal use
          </div>
        </header>

        {rateCard.placeholder && (
          <div style={{ background: C.warnBg, color: C.warnText, borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 16 }}>
            <strong>Placeholder rates.</strong> Admin fees, setup, SUTA, workers' comp and add-on prices are sample
            values. Do not send this quote to a client until the Humii rate card is loaded.
          </div>
        )}

        <section style={card} className="no-print">
          <h2 style={h2}>Client</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            <div>
              <label style={labelStyle}>Client name</label>
              <input style={field} value={client} onChange={e => setClient(e.target.value)} placeholder="Acme Co." />
            </div>
            <div>
              <label style={labelStyle}>Primary state</label>
              <select style={field} value={state} onChange={e => setState(e.target.value)}>
                <option value="">Select...</option>
                {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Prepared by</label>
              <input style={field} value={preparedBy} onChange={e => setPreparedBy(e.target.value)} placeholder="Rep name" />
            </div>
            <div>
              <label style={labelStyle}>Exhibit reference</label>
              <input style={field} value={reference} onChange={e => setReference(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Quote valid for (days)</label>
              <input style={field} type="number" min="1" step="1" value={validDays} onChange={e => setValidDays(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Admin fee model</label>
              <div style={{ display: "flex", border: `1.5px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
                {[["pepm", "Per employee / month"], ["percent", "% of payroll"]].map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setFeeModel(value)}
                    aria-pressed={feeModel === value}
                    style={{
                      flex: 1, padding: "9px 8px", border: "none", cursor: "pointer", fontFamily: FONT, fontSize: 13,
                      fontWeight: 600, background: feeModel === value ? C.primary : C.white,
                      color: feeModel === value ? C.white : C.ink,
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section style={card} className="no-print">
          <h2 style={h2}>Workforce</h2>
          <div style={{ fontSize: 12, color: C.muted, margin: "-8px 0 12px" }}>
            One row per job class. Tax wage caps use each row's average wage, so split a row if its wages vary widely.
          </div>
          {groups.map(g => (
            <div key={g.id} style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10, alignItems: "flex-end" }}>
              <div style={{ flex: "1 1 150px" }}>
                <label style={labelStyle}>Group</label>
                <input style={field} value={g.label} onChange={e => updateGroup(g.id, "label", e.target.value)} placeholder="e.g. Field crew" />
              </div>
              <div style={{ flex: "1 1 150px" }}>
                <label style={labelStyle}>Employees</label>
                <input style={field} type="number" min="0" step="1" value={g.headcount} onChange={e => updateGroup(g.id, "headcount", e.target.value)} placeholder="0" />
              </div>
              <div style={{ flex: "1 1 150px" }}>
                <label style={labelStyle}>Avg annual wage ($)</label>
                <input style={field} type="number" min="0" step="1000" value={g.avgAnnualWage} onChange={e => updateGroup(g.id, "avgAnnualWage", e.target.value)} placeholder="0" />
              </div>
              <div style={{ flex: "1 1 150px" }}>
                <label style={labelStyle}>WC class code</label>
                <select style={field} value={g.wcCode} onChange={e => updateGroup(g.id, "wcCode", e.target.value)}>
                  <option value="">Select...</option>
                  {rateCard.workersComp.classCodes.map(c => (
                    <option key={c.code} value={c.code}>{c.code} {c.description}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => setGroups(gs => gs.filter(x => x.id !== g.id))}
                disabled={groups.length === 1}
                aria-label="Remove group"
                style={{ width: 38, height: 38, border: `1.5px solid ${C.border}`, borderRadius: 6, background: C.white, color: C.muted, cursor: groups.length === 1 ? "default" : "pointer", opacity: groups.length === 1 ? 0.4 : 1 }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setGroups(gs => [...gs, newGroup()])}
            style={{ border: "none", background: C.tint, color: C.primary, fontWeight: 600, fontFamily: FONT, fontSize: 13, padding: "8px 14px", borderRadius: 6, cursor: "pointer" }}
          >
            + Add group
          </button>
        </section>

        <section style={card} className="no-print">
          <h2 style={h2}>Add-on services</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8 }}>
            {rateCard.addOns.map(a => (
              <label key={a.id} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 14, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={addOnIds.includes(a.id)} onChange={() => toggleAddOn(a.id)} />
                <span style={{ flex: 1 }}>{a.label}</span>
                <span style={{ color: C.muted, fontSize: 13 }}>
                  {money0(a.rate)} {a.unit === "pepm" ? "PEPM" : "/ mo"}
                </span>
              </label>
            ))}
          </div>
        </section>

        <section style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h2 style={h2}>Quote{client ? ` for ${client}` : ""}</h2>
            <div style={{ fontSize: 13, color: C.muted }}>
              {quote.headcount} employees · {money0(quote.annualPayroll)} annual payroll{state ? ` · ${state}` : ""}
            </div>
          </div>

          {!ready ? (
            <div style={{ color: C.muted, fontSize: 14, padding: "12px 0" }}>
              Enter headcount and average wage for at least one group to price the quote.
            </div>
          ) : (
            <>
              {quote.unratedGroups.length > 0 && (
                <div style={{ color: C.error, fontSize: 13, marginBottom: 10 }}>
                  No workers' comp class code for: {quote.unratedGroups.join(", ")}. Workers' comp is excluded for
                  {quote.unratedGroups.length > 1 ? " these groups" : " this group"}.
                </div>
              )}
              <QuoteTable quote={quote} rateCard={rateCard} />

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 16 }}>
                {[
                  ["Humii fees per employee / month", money(quote.effectivePepm)],
                  ["Humii fees as % of payroll", `${(quote.effectivePercentOfPayroll * 100).toFixed(2)}%`],
                  ["Total cost per employee / month", money(quote.monthlyTotal / quote.headcount)],
                ].map(([k, v]) => (
                  <div key={k} style={{ background: C.tint, borderRadius: 8, padding: "12px 14px" }}>
                    <div style={{ fontSize: 12, color: C.muted }}>{k}</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{v}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 12, color: C.muted, marginTop: 14 }}>
                Estimate only. Monthly figures are the annual amount divided by 12; capped taxes (Social Security, FUTA,
                SUTA) are actually paid early in the year. Tax caps are applied to each group's average wage.
              </div>

              <button
                type="button"
                className="no-print"
                onClick={() => setView("exhibit")}
                style={{ marginTop: 16, border: "none", background: C.primary, color: C.white, fontWeight: 700, fontFamily: FONT, fontSize: 14, padding: "11px 22px", borderRadius: 6, cursor: "pointer" }}
              >
                Create client exhibit for signature
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
