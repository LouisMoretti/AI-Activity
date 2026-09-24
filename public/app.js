/* AI Activity dashboard — real measured data.
 * ?demo=1 renders the old deterministic fictional dataset, clearly labeled.
 * Fictional demo values are never presented as real measurements. */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.get("demo") === "1";

let provider = "all";
let view = "daily";
let activity = []; // [{day:'YYYY-MM-DD', tokens, sessions}]
let statsData = null;
let quotasData = [];
let sessionsData = [];
let billingData = null;
let loading = false;

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });
const num = (n) => new Intl.NumberFormat("en-US").format(n);
const toolParam = () => (provider === "all" ? "" : `&tool=${encodeURIComponent(provider)}`);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------------- demo dataset (fictional, deterministic) ---------------- */
const demoTools = {
  codex: { name: "Codex", icon: "⌘", plan: "Plus · demo", five: 38, week: 64, reset: "in 2 h 18 min", weekly: "Monday at 09:00" },
  claude: { name: "Claude Code", icon: "✳", plan: "Pro · demo", five: 72, week: 86, reset: "in 48 min", weekly: "Friday at 14:30" },
};
const demoSessions = [
  { tool: "codex", name: "Consumption dashboard", model: "Codex · fictional conversation", used: 74000, max: 258000 },
  { tool: "claude", name: "API and sync", model: "Claude Code · fictional conversation", used: 128000, max: 200000 },
];
const demoDays = Array.from({ length: 364 }, (_, i) => {
  const date = new Date(Date.UTC(2025, 9, 1 + i));
  const active = i > 200 ? ((i * 37) % 13) > 3 : ((i * 19) % 71) < 2;
  return {
    date,
    codex: active ? Math.round(((i * 7919) % 1600000) * (i > 290 ? 2 : 1)) : 0,
    claude: active && i % 3 !== 0 ? Math.round((i * 3571) % 1200000) : 0,
  };
});
const demoAmount = (d) => (provider === "all" ? d.codex + d.claude : (d[provider === "claude-code" ? "claude" : provider] || 0));

/* ---------------- data loading (live) ---------------- */
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) {
    const st = await checkAuth();
    if (st.locked && !st.authenticated) showLogin();
    throw new Error("unauthorized");
  }
  if (!r.ok) throw new Error(`request failed: ${r.status}`);
  return r.json();
}

async function checkAuth() {
  try {
    const r = await fetch("/api/auth/status");
    return await r.json();
  } catch {
    return { locked: false, authenticated: true };
  }
}

function showLogin() {
  $("login-bar").hidden = false;
}

async function login() {
  const password = $("login-password").value;
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (r.ok) {
    $("login-bar").hidden = true;
    await load();
  } else {
    $("login-error").textContent = "Wrong password.";
  }
}

function dayRange(n) {
  // UTC days to match the server buckets (date(occurred_at, 'unixepoch')).
  // Local-midnight math shifts the range a day back in UTC+ timezones.
  const t = new Date();
  const todayUTC = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(todayUTC - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

async function load() {
  if (loading) return; // skip overlapping refreshes
  loading = true;
  try {
    await loadInner();
  } finally {
    loading = false;
  }
}

async function loadInner() {
  if (DEMO) {
    document.title = "AI Activity — Demo";
    $("mode-badge").textContent = "Demonstration data";
    $("footer-text").textContent = "Demo mode: no account connection, no real quotas. Fictional values.";
    $("period-label").textContent = "Oct. 2025 — Sept. 2026 · fictional data";
    render();
    return;
  }
  $("mode-badge").textContent = "Live data";
  try {
    const [stats, act, quotas, sessions, billing] = await Promise.all([
      api(`/api/stats?days=30${toolParam()}`),
      api(`/api/activity?days=364${toolParam()}`),
      api("/api/quotas"),
      api("/api/sessions?limit=10"),
      api("/api/billing"),
    ]);
    statsData = stats;
    const byDay = new Map((act.days || []).map((d) => [d.day, d]));
    activity = dayRange(364).map((day) => ({
      day,
      tokens: Number(byDay.get(day)?.tokens || 0),
      sessions: Number(byDay.get(day)?.sessions || 0),
    }));
    quotasData = quotas.quotas || [];
    sessionsData = (sessions.sessions || []).filter(
      (s) => provider === "all" || s.tool === provider
    );
    billingData = billing;
    $("period-label").textContent = "Last 30 days · measured data";
    $("footer-text").textContent =
      "Measured data from your devices. No prompts or transcripts are ever transmitted.";
  } catch (e) {
    if (String(e?.message) !== "unauthorized") {
      $("chart-detail").textContent = "Could not load data. Is the server running?";
    }
    return;
  }
  render();
}

/* ---------------- rendering ---------------- */
const dateLabel = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

function values() {
  if (DEMO) return demoDays.map(demoAmount);
  return activity.map((d) => d.tokens);
}

function render() {
  renderStats();
  renderChart(values());
  renderQuotas();
  renderSessions();
  renderBilling();
}

function renderStats() {
  let cards;
  if (DEMO) {
    const vals = values();
    let longest = 0, run = 0;
    vals.forEach((n) => { run = n ? run + 1 : 0; longest = Math.max(run, longest); });
    let current = 0;
    for (let i = vals.length - 1; i >= 0 && vals[i] > 0; i--) current++;
    cards = [
      [fmt.format(vals.reduce((a, b) => a + b, 0)), "Total tokens"],
      [fmt.format(Math.max(...vals)), "Daily peak"],
      [provider === "claude-code" || provider === "claude" ? "1 h 52 min" : "2 h 44 min", "Longest chat"],
      [current + " days", "Current streak"],
      [longest + " days", "Longest streak"],
    ];
  } else if (!statsData || !statsData.has_data) {
    cards = [
      ["—", "Total tokens"], ["—", "Daily peak"],
      ["—", "Sessions"], ["—", "Events"], ["—", "Est. API equiv."],
    ];
  } else {
    const vals = values();
    let longest = 0, run = 0;
    vals.forEach((n) => { run = n ? run + 1 : 0; longest = Math.max(run, longest); });
    let current = 0;
    for (let i = vals.length - 1; i >= 0 && vals[i] > 0; i--) current++;
    cards = [
      [fmt.format(statsData.total_tokens), "Total tokens (30d)"],
      [fmt.format(Math.max(0, ...vals)), "Daily peak"],
      [num(statsData.sessions), "Sessions"],
      [current + " days", "Current streak"],
      [longest + " days", "Longest streak"],
    ];
  }
  $("stats").innerHTML = cards
    .map(([n, l]) => `<div class="stat"><strong>${esc(n)}</strong><span>${esc(l)}</span></div>`)
    .join("");
}

function bar(n, label) {
  const pct = Math.max(0, Math.min(100, Math.round(n)));
  return `<div class="track" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="fill ${pct >= 85 ? "high" : ""}" style="width:${pct}%"></div></div>`;
}

function quotaRow(label, n, reset) {
  return `<div class="quota-row"><div class="quota-value"><span>${esc(label)}</span><strong>${n === null ? "Unavailable" : esc(n + " %")}</strong></div>${n === null ? `<div class="track"><div class="fill" style="width:0%"></div></div>` : bar(n, label)}<div class="reset"><span>${esc(reset)}</span><span class="${n !== null && n >= 85 ? "warn" : ""}">${n === null ? "not exposed by the provider" : esc((100 - n) + " % remaining")}</span></div></div>`;
}

function resetLabel(ts) {
  if (!ts) return "Reset time not provided";
  const d = new Date(ts * 1000);
  if (d.getTime() < Date.now()) return `Window passed (${d.toLocaleString("en-US")})`;
  return `Resets ${d.toLocaleString("en-US")}`;
}

function renderQuotas() {
  const wrap = $("quotas");
  if (DEMO) {
    const keys = Object.keys(demoTools).filter(
      (k) => provider === "all" || provider === k || (provider === "claude-code" && k === "claude")
    );
    wrap.innerHTML = keys.map((key) => {
      const t = demoTools[key];
      return `<article class="quota-card ${key}"><div class="quota-title"><span class="tool-icon" aria-hidden="true">${t.icon}</span><h3>${t.name}</h3><span class="plan">${t.plan}</span></div>${quotaRow("5-hour window", t.five, "Resets " + t.reset)}${quotaRow("This week", t.week, t.weekly)}</article>`;
    }).join("");
    return;
  }
  const show = provider === "all" ? ["claude-code", "codex"] : [provider];
  wrap.innerHTML = show.map((tool) => {
    if (tool === "codex") {
      return `<article class="quota-card codex"><div class="quota-title"><span class="tool-icon" aria-hidden="true">⌘</span><h3>Codex</h3><span class="plan">Connector coming soon</span></div>${quotaRow("5-hour window", null, "Unavailable")}${quotaRow("This week", null, "Unavailable")}</article>`;
    }
    const five = quotasData.find((q) => q.tool === "claude-code" && q.limit_type === "five_hour");
    const seven = quotasData.find((q) => q.tool === "claude-code" && q.limit_type === "seven_day");
    const sub = five || seven
      ? `Last measured ${new Date(Math.max(five?.measured_at || 0, seven?.measured_at || 0) * 1000).toLocaleString("en-US")}`
      : "No snapshot received yet";
    return `<article class="quota-card claude"><div class="quota-title"><span class="tool-icon" aria-hidden="true">✳</span><h3>Claude Code</h3><span class="plan">${esc(sub)}</span></div>${quotaRow("5-hour window", five ? five.used_pct : null, five ? resetLabel(five.resets_at) : "Unavailable")}${quotaRow("This week", seven ? seven.used_pct : null, seven ? resetLabel(seven.resets_at) : "Unavailable")}</article>`;
  }).join("");
}

function renderSessions() {
  const wrap = $("sessions");
  if (DEMO) {
    const list = demoSessions.filter(
      (s) => provider === "all" || s.tool === provider || (provider === "claude-code" && s.tool === "claude")
    );
    $("sessions-sub").textContent = "Last simulated state — fictional";
    wrap.innerHTML = list.map((s) => {
      const pct = Math.round((s.used / s.max) * 100);
      return `<article class="session ${s.tool}"><div class="session-name"><span class="tool-icon" aria-hidden="true">${demoTools[s.tool].icon}</span><div><strong>${esc(s.name)}</strong><small>${esc(s.model)}</small></div></div><div class="session-meter"><div class="quota-value"><span>${fmt.format(s.used)} / ${fmt.format(s.max)} tokens</span><strong>${pct} %</strong></div>${bar(pct, "Context of " + s.name)}</div></article>`;
    }).join("");
    return;
  }
  $("sessions-sub").textContent = "Recent measured sessions";
  if (!sessionsData.length) {
    wrap.innerHTML = `<article class="session"><div class="session-name"><div><strong>No sessions recorded yet</strong><small>Real activity from a connected device will appear here.</small></div></div></article>`;
    return;
  }
  wrap.innerHTML = sessionsData.map((s) => {
    const short = String(s.session_id).slice(0, 8);
    return `<article class="session"><div class="session-name"><span class="tool-icon" aria-hidden="true">✳</span><div><strong>${esc(s.tool)} · ${esc(short)}…</strong><small>${esc(s.model || "model not reported")} · ${esc(s.events)} events · last seen ${esc(new Date(s.last_seen * 1000).toLocaleString("en-US"))}</small></div></div><div class="session-meter"><div class="quota-value"><span>${fmt.format(s.tokens)} tokens (summed increments)</span></div>${bar(Math.min(100, (s.tokens / 1000000) * 10), "Session " + short)}</div></article>`;
  }).join("");
}

function renderBilling() {
  const wrap = $("billing");
  if (DEMO) {
    wrap.innerHTML = `<article class="bill-card"><h3>Paid subscriptions</h3><p class="big">Demo</p><small>Manually entered — fictional.</small></article><article class="bill-card"><h3>Actual API charges</h3><p class="big">Demo</p><small>Provider invoices — fictional.</small></article><article class="bill-card"><h3>Estimated API equivalent</h3><p class="big">Demo</p><small>Derived from tokens — neither an invoice nor a saving.</small></article>`;
    return;
  }
  const subs = billingData?.subscriptions || [];
  const records = billingData?.billing_records || [];
  const est = billingData?.estimated_api_equivalent_usd || 0;
  const paidTotal = subs.reduce((a, s) => a + Number(s.amount || 0), 0);
  const actualTotal = records.filter((r) => r.kind === "api_actual").reduce((a, r) => a + Number(r.amount || 0), 0);
  const money = (n, c) => `${esc(c || "USD")} ${num(Math.round(n * 100) / 100)}`;
  wrap.innerHTML = `
    <article class="bill-card"><h3>Paid subscriptions</h3><p class="big">${subs.length ? money(paidTotal, subs[0].currency) : "None recorded"}</p><small>${subs.length ? subs.map((s) => `${esc(s.tool)} ${esc(s.plan_name)} — ${money(s.amount, s.currency)}${s.note ? ` (${esc(s.note)})` : ""}`).join("<br>") : "Enter what you actually paid (promotions and currency included) via POST /api/billing/subscription."}</small></article>
    <article class="bill-card"><h3>Actual API charges</h3><p class="big">${records.length ? money(actualTotal, records[0].currency) : "None recorded"}</p><small>${records.length ? esc(records.length + " provider invoice record(s). Source shown per record.") : "Verified provider billing only. Empty until an invoice source is connected."}</small></article>
    <article class="bill-card"><h3>Estimated API equivalent</h3><p class="big">$${num(Math.round(est * 100) / 100)}</p><small>Derived from measured tokens and list prices. Neither an invoice nor a saving.</small></article>`;
}

function renderChart(vals) {
  $("legend").hidden = view !== "daily";
  if (DEMO) {
    $("chart-detail").textContent = view === "daily" ? "Hover a day to see its activity (fictional)." : view === "weekly" ? "Tokens consumed each week · simulated data." : "Total tokens over time · simulated data.";
  } else if (!statsData || !statsData.has_data) {
    $("chart-detail").textContent = "No measured activity yet. Connect a device to see real tokens here.";
  } else {
    $("chart-detail").textContent = view === "daily" ? "Hover a day to see its measured activity." : view === "weekly" ? "Tokens consumed each week · measured data." : "Total tokens over time · measured data.";
  }
  const labels = DEMO ? demoDays.map((d) => d.date) : activity.map((d) => d.day);
  if (view === "daily") {
    const colors = ["#242424", "#233249", "#314c76", "#476dab", "#86a8ea"];
    const max = Math.max(1, ...vals);
    const dateOf = (i) => (DEMO ? labels[i] : new Date(labels[i] + "T00:00:00Z"));
    const monthName = (d) => d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const nCols = Math.ceil(vals.length / 7);
    let monthHtml = "";
    let prevM = "";
    for (let c = 0; c < nCols; c++) {
      const m = monthName(dateOf(Math.min(c * 7, vals.length - 1)));
      monthHtml += `<span>${m === prevM ? "" : esc(m)}</span>`;
      prevM = m;
    }
    const cells = vals.map((v, i) => {
      const level = v === 0 ? 0 : Math.max(1, Math.ceil((v / max) * 4));
      const dayName = DEMO
        ? labels[i].toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
        : dateLabel(labels[i]);
      const label = `${dayName}: ${num(v)} tokens${DEMO ? " (fictional)" : ""}`;
      return `<button class="cell" style="background:${colors[level]};--cell-color:${colors[level]}" aria-label="${esc(label)}" title="${esc(label)}" data-day="${i}"></button>`;
    }).join("");
    $("chart").innerHTML = `<div class="cal"><div class="cal-months" aria-hidden="true">${monthHtml}</div><div class="cal-body"><div class="cal-weekdays" aria-hidden="true"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div><div class="heatmap">${cells}</div></div></div>`;
    document.querySelectorAll("[data-day]").forEach((b) => {
      const show = () => { $("chart-detail").textContent = b.getAttribute("aria-label"); };
      b.onmouseenter = show; b.onfocus = show; b.onclick = show;
    });
    $("months").innerHTML = "";
    return;
  }
  const weekly = Array.from({ length: 52 }, (_, i) => vals.slice(i * 7, i * 7 + 7).reduce((a, b) => a + b, 0));
  let acc = 0;
  const data = view === "weekly" ? weekly : weekly.map((v) => (acc += v));
  const max = Math.max(1, ...data);
  const path = data.map((v, i) => `${i === 0 ? "M" : "L"}${(i / 51) * 990},${103 - (v / max) * 95}`).join(" ");
  const drawing = view === "weekly"
    ? data.map((v, i) => `<rect x="${(i / 52) * 1000}" y="${103 - (v / max) * 95}" width="12" height="${(v / max) * 95}" rx="2" fill="#5477b3"><title>Week ${i + 1}: ${num(v)} tokens${DEMO ? " (fictional)" : ""}</title></rect>`).join("")
    : `<path d="${path} L990,108 L0,108 Z" fill="#86a8ea" opacity=".09"/><path d="${path}" stroke="#86a8ea" stroke-width="2" fill="none"/>`;
  $("chart").innerHTML = `<svg class="svg-chart" viewBox="0 0 1000 110" preserveAspectRatio="none" role="img" aria-label="${view === "weekly" ? "Weekly consumption" : "Cumulative consumption"}, ${DEMO ? "demonstration data" : "measured data"}"><path d="M0 108H1000 M0 55H1000 M0 7H1000" stroke="#2b2b2b" stroke-dasharray="3 5"/>${drawing}</svg>`;
  $("months").innerHTML = `<span>52 weeks</span>`;
}

function monthLabels() {
  if (DEMO) {
    return ["Oct.", "Nov.", "Dec.", "Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept."].map((m) => `<span>${m}</span>`).join("");
  }
  const seen = new Set();
  return activity.filter((_, i) => i % 30 === 0).map((d) => {
    const m = new Date(d.day + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    if (seen.has(m)) return "<span></span>";
    seen.add(m);
    return `<span>${esc(m)}</span>`;
  }).join("");
}

function choose(container, attr, fn) {
  $(container).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $(container).querySelectorAll("button").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
    fn(b.dataset[attr]);
    load();
  });
}

$("login-btn").addEventListener("click", login);
$("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
choose("providers", "provider", (v) => (provider = v));
choose("views", "view", (v) => (view = v));
load();

// Auto-refresh live data every 15 s. Skipped while the tab is hidden,
// in demo mode, or when a previous refresh is still in flight.
setInterval(() => {
  if (DEMO || document.hidden) return;
  load().catch(() => {});
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !DEMO) load().catch(() => {});
});
