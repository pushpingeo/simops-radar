// SIMOPS Radar: filters pre-built activity pairs by operator and rules, and plays them back over time.

const DAY = 86400000;
let START = Date.UTC(2019, 0, 1);
let END = Date.UTC(2026, 11, 31);
const NEW_DAYS = 14;  // "new" = first seen or changed within this many days of the latest update
const STYLE = "https://tiles.openfreemap.org/styles/positron";

const CLS = {
  seismic: { label: "Seismic survey (3D, 4D, ocean-bottom)", short: "Seismic", color: "#c2255c" },
  vessel:  { label: "Intervention or dive vessel", short: "Vessel", color: "#1c7ed6" },
  rig:     { label: "Rig", short: "Rig", color: "#5f3dc4" },
  subsea:  { label: "Pipeline or subsea works", short: "Pipeline works", color: "#0c8599" },
  site:    { label: "Site survey (2D high-res, profilers)", short: "Site survey", color: "#868e96" },
  notice:  { label: "Survey notice (type not given)", short: "Survey notice", color: "#adb5bd" },
  vsp:     { label: "Borehole seismic from a rig", short: "VSP", color: "#adb5bd" },
};

// How much each pair of activity types matters. Same numbers as the analysis notebook.
const W = {
  "seismic|vessel": 1.0, "rig|seismic": 0.9, "seismic|seismic": 1.0, "seismic|subsea": 0.9,
  "notice|seismic": 0.6, "seismic|site": 0.5, "seismic|vsp": 0.5,
  "rig|rig": 0.6, "rig|vessel": 0.5, "vessel|vessel": 0.5, "subsea|vessel": 0.4, "rig|subsea": 0.4, "subsea|subsea": 0.3,
  "notice|vessel": 0.4, "notice|rig": 0.3, "notice|notice": 0.3, "site|vessel": 0.3, "rig|site": 0.2, "site|site": 0.2,
  "notice|site": 0.2, "site|subsea": 0.2, "notice|subsea": 0.2,
};

function typeKey(a, b) {
  const [x, y] = [a, b].sort();
  if (x === "seismic" || y === "seismic") {
    const other = x === "seismic" ? y : x;
    return { seismic: "ss", vessel: "sv", rig: "sr", subsea: "sp", site: "sy", notice: "sy" }[other] || "sx";
  }
  if (["site", "notice", "vsp"].includes(x) || ["site", "notice", "vsp"].includes(y)) return "sx";
  if (x === "rig" && y === "rig") return "rr";
  return "rv";
}

// Activity types along both sides of the pairing grid
const C = ["seismic", "site", "notice", "vsp", "rig", "vessel", "subsea"];
const C_SHORT = { seismic: "Seismic", site: "Site svy", notice: "Notice", vsp: "VSP", rig: "Rig", vessel: "Vessel", subsea: "Pipeline" };
const CELLS = [];
C.forEach((x, i) => C.slice(i).forEach(y => CELLS.push([x, y].sort().join("|"))));
const defaultLevel = ck => Math.max(1, Math.round((W[ck] ?? 0.1) * 5));  // importance 1-5

const TYPES = [
  { key: "sv", label: "Seismic vs intervention or dive vessel" },
  { key: "sr", label: "Seismic vs rig" },
  { key: "ss", label: "Seismic vs seismic" },
  { key: "sp", label: "Seismic vs pipeline works" },
  { key: "sy", label: "Seismic vs site survey (incl. survey notices)" },
  { key: "rr", label: "Rig vs rig" },
  { key: "rv", label: "Rigs, vessels and pipeline works together" },
  { key: "sx", label: "Other pairs involving site surveys, notices or VSP" },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map(t => [t.key, t.label]));
const KIND = { sv: "Seismic vs vessel", sr: "Seismic vs rig", ss: "Seismic vs seismic", sp: "Seismic vs pipeline works", sy: "Seismic vs site survey", rr: "Rig vs rig", rv: "Rig, vessel or pipeline works", sx: "Survey overlap" };

// A preset switches pairing-grid cells on (at their default importance) by family, and sets the sliders.
const grid = families => Object.fromEntries(CELLS.map(ck => [ck, families.includes(typeKey(...ck.split("|"))) ? defaultLevel(ck) : 0]));
const BASE = { near: "adj", notice: 30, buffer: 0, minScore: 0, internal: true };
const PRESETS = {
  quiet:  { ...BASE, m: grid(["sv", "sr", "ss", "sp", "sy"]), assumed: false, minOv: 7, maxWin: 200 },
  medium: { ...BASE, m: grid(["sv", "sr", "ss", "sp", "sy", "rr", "rv"]), assumed: true, minOv: 7, maxWin: 365 },
  loud:   { ...BASE, m: grid(TYPES.map(t => t.key)), assumed: true, minOv: 1, maxWin: 99999 },
};
const MAXWIN_NONE = 99999;

const $ = s => document.querySelector(s);
const fmt = ms => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtShort = ms => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtRange = (a, b) => new Date(a).getUTCFullYear() === new Date(b).getUTCFullYear() ? `${fmtShort(a)} to ${fmt(b)}` : `${fmt(a)} to ${fmt(b)}`;
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const parse = s => Date.parse(s + "T00:00:00Z");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));


const state = {
  op: "all", watch: "any", preset: "quiet", rules: structuredClone(PRESETS.quiet),
  year: 2026, date: Date.UTC(2026, 10, 13), sel: null, showN: 40, playing: null, newOnly: false,
};

let A = [], P = [], meta = {}, map = null, mapReady = false, current = [], blocksGeo = null;

// ---------------------------------------------------------------- data
async function load() {
  const [acts, pairs, m] = await Promise.all(["activities", "pairs", "meta"].map(n => fetch(`data/${n}.json`).then(r => r.json())));
  meta = m;
  // consents often run into next year, so the timeline goes one year past the latest file when needed
  const lastFile = meta.years.at(-1);
  meta.fileYears = [...meta.years];
  const maxEnd = Math.max(...acts.map(a => parse(a.end)));
  if (maxEnd > Date.UTC(lastFile, 11, 31)) meta.years = [...meta.years, lastFile + 1];
  START = Date.UTC(meta.years[0], 0, 1);
  END = Date.UTC(meta.years.at(-1), 11, 31);
  meta.updatedMs = parse(meta.updated);
  meta.newSince = meta.updatedMs - (NEW_DAYS - 1) * DAY;
  state.date = Math.min(Math.max(meta.updatedMs, START), END);
  state.year = new Date(state.date).getUTCFullYear();
  const recent = d => d && parse(d) >= meta.newSince && parse(d) > parse(meta.trackingSince);
  A = acts.map(a => ({ ...a, s: parse(a.start), e: parse(a.end), e0: parse(a.end), days: (parse(a.end) - parse(a.start)) / DAY + 1,
    isNew: recent(a.first) || recent(a.changed), newDate: recent(a.first) ? a.first : recent(a.changed) ? a.changed : null,
    newKind: recent(a.first) ? "new" : "changed" }));
  P = pairs.map(([ia, ib, same], i) => {
    const a = A[ia], b = A[ib];
    return { i, a, b, same: !!same, ck: [a.cls, b.cls].sort().join("|"), type: typeKey(a.cls, b.cls),
      nAssumed: (a.assumed ? 1 : 0) + (b.assumed ? 1 : 0), shared: a.owners.some(o => b.owners.includes(o)),
      key: [a.key, b.key].sort().join(" | "), isNew: a.isNew || b.isNew };
  });
}

// ---------------------------------------------------------------- scoring and filtering
// Survey notices have no end date; their length comes from the "notice" slider.
let noticeApplied = null;
function applyNotice(days) {
  if (noticeApplied === days) return;
  for (const a of A) if (a.assumed) { a.e = a.s + days * DAY; a.days = days + 1; }
  noticeApplied = days;
}

// Work out overlap (or the gap, for near misses) and the score for one pair under the current rules.
function scorePair(p, r) {
  const { a, b } = p;
  const os = Math.max(a.s, b.s), oe = Math.min(a.e, b.e);
  p.ov = Math.round((oe - os) / DAY) + 1;
  p.gap = p.ov > 0 ? 0 : 1 - p.ov;
  // for a near miss, the "window" shown is the gap between the two
  p.os = p.ov > 0 ? os : oe; p.oe = p.ov > 0 ? oe : os;
  p.longest = Math.max(a.days, b.days);
  p.level = r.m[p.ck] || 0;
  p.f = {
    w: p.level / 5,
    near: p.same ? 1 : 0.6,
    dates: Math.pow(0.6, p.nAssumed),
    overlap: p.ov > 0 ? Math.min(p.ov, 30) / 30 : r.buffer ? 0.3 * (r.buffer - p.gap + 1) / r.buffer : 0,
    window: 1 / (1 + p.longest / 120),
  };
  p.score = p.f.w * p.f.near * p.f.dates * p.f.overlap * p.f.window;
}

function passes(p, r = state.rules, op = state.op) {
  if (!p.level) return false;
  if (r.near === "same" && !p.same) return false;
  if (!r.assumed && p.nAssumed) return false;
  if (p.ov > 0 ? p.ov < r.minOv : p.gap > r.buffer) return false;
  if (p.longest > r.maxWin) return false;
  if (p.score < r.minScore) return false;
  if (op === "all") return r.internal || !p.shared;
  const ma = p.a.owners.includes(op), mb = p.b.owners.includes(op);
  if (!ma && !mb) return false;
  if (ma && mb && !r.internal) return false;
  const w = state.watch;
  if (w !== "any" && !((ma && p.a.cls === w) || (mb && p.b.cls === w))) return false;
  return true;
}

function orient(p) {
  // put the selected operator's activity first
  if (state.op !== "all" && !p.a.owners.includes(state.op) && p.b.owners.includes(state.op)) return [p.b, p.a];
  return [p.a, p.b];
}

const yStart = y => Date.UTC(y, 0, 1), yEnd = y => Date.UTC(y, 11, 31);
const inYear = (p, y) => p.os <= yEnd(y) && p.oe >= yStart(y);

function recompute() {
  applyNotice(state.rules.notice);
  for (const p of P) scorePair(p, state.rules);
  current = P.filter(p => passes(p)).sort((x, y) => y.score - x.score || x.os - y.os);
  if (state.sel != null && !current.some(p => p.i === state.sel)) state.sel = null;
}

// ---------------------------------------------------------------- UI: controls
function buildControls() {
  const op = $("#op");
  op.innerHTML = `<option value="all">All operators</option>` +
    meta.operators.filter(([, n]) => n >= 3).map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join("") +
    `<optgroup label="Smaller operators">` +
    meta.operators.filter(([, n]) => n < 3).sort().map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join("") + `</optgroup>`;
  op.onchange = () => { state.op = op.value; state.sel = null; state.showN = 40; update(); };

  // pairing grid: activity types on both axes, importance 0-5 in each cell of the upper triangle
  const opt = v => `<option value="${v}">${v ? v : "–"}</option>`;
  $("#grid").innerHTML = `<table class="grid"><tr><th></th>${C.map(c => `<th title="${esc(CLS[c].label)}"><span class="dot" style="--c:${CLS[c].color}"></span>${C_SHORT[c]}</th>`).join("")}</tr>` +
    C.map((x, i) => `<tr><th title="${esc(CLS[x].label)}"><span class="dot" style="--c:${CLS[x].color}"></span>${C_SHORT[x]}</th>` + C.map((y, j) => {
      if (j < i) return `<td></td>`;
      const ck = [x, y].sort().join("|");
      return `<td><select data-ck="${ck}" aria-label="${esc(C_SHORT[x] + " vs " + C_SHORT[y])}">${[0, 1, 2, 3, 4, 5].map(opt).join("")}</select></td>`;
    }).join("") + `</tr>`).join("") + `</table>`;
  $("#grid").onchange = e => { const ck = e.target.dataset.ck; if (!ck) return; state.rules.m = { ...state.rules.m, [ck]: +e.target.value }; custom(); };
  document.querySelector(".quick").onclick = e => {
    const g = e.target.dataset.g; if (!g) return;
    state.rules.m = Object.fromEntries(CELLS.map(ck => [ck,
      g === "none" ? 0 : g === "all" ? (state.rules.m[ck] || defaultLevel(ck)) : ck.split("|").includes("seismic") ? (state.rules.m[ck] || defaultLevel(ck)) : 0]));
    custom();
  };
  document.querySelectorAll('input[name="near"]').forEach(el => el.onchange = () => { state.rules.near = el.value; custom(); });
  $("#r-assumed").onchange = e => { state.rules.assumed = e.target.checked; custom(); };
  $("#r-internal").onchange = e => { state.rules.internal = e.target.checked; custom(); };
  $("#watch").onchange = e => { state.watch = e.target.value; state.sel = null; state.showN = 40; update(); };
  // sliders update as you drag, at most once per frame
  const slider = (id, key, toRule = Number) => {
    let pending = false;
    $(id).oninput = e => {
      state.rules[key] = toRule(e.target.value);
      sliderLabels();
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; custom(); });
    };
  };
  slider("#r-notice", "notice");
  slider("#r-minov", "minOv");
  slider("#r-buffer", "buffer");
  slider("#r-maxwin", "maxWin", v => +v >= 760 ? MAXWIN_NONE : +v);
  slider("#r-minscore", "minScore");

  $("#preset").onclick = e => {
    const p = e.target.closest("button")?.dataset.p;
    if (!p || p === "custom") return;
    state.preset = p; state.rules = structuredClone(PRESETS[p]); state.showN = 40; update();
  };
  document.addEventListener("click", e => { const d = $("#rules"); if (d.open && !d.contains(e.target)) d.open = false; });

  const range = $("#date");
  range.min = 0; range.max = Math.round((END - START) / DAY);
  range.oninput = () => setDate(START + range.value * DAY, true);
  $("#play").onclick = togglePlay;
  $("#about-btn").onclick = () => { $("#about").showModal(); $("#about").scrollTop = 0; };
  $("#fb-btn").onclick = openFeedback;
  $("#fb-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#fb-text").value); $("#fb-copy").textContent = "Copied"; }
    catch { $("#fb-text").select(); document.execCommand("copy"); $("#fb-copy").textContent = "Copied"; }
    setTimeout(() => $("#fb-copy").textContent = "Copy", 1500);
  };
  $("#fb-send").onclick = sendFeedback;
  $("#su-send").onclick = () => submitSignup(false);
  $("#su-remove").onclick = () => submitSignup(true);
  $("#fb-email").onclick = () => { location.href = `mailto:?subject=${encodeURIComponent("SIMOPS Radar feedback")}&body=${encodeURIComponent($("#fb-text").value)}`; };
  $("#fb-clear").onclick = () => { if (confirm("Clear all your marks on this device?")) { FB = {}; saveFeedback(); renderList(); openFeedback(); } };
  saveFeedback();
  $("#built").textContent = fmt(meta.updatedMs);

  $("#legend-items").innerHTML = ["seismic", "vessel", "rig", "subsea", "site"].map(k =>
    `<div class="row"><span class="sw" style="--c:${CLS[k].color}"></span>${CLS[k].label}</div>`).join("") +
    `<div class="row" id="lg-mine"><span class="sw mine" style="--c:#fff"></span>Selected operator's activity</div>` +
    `<div class="row"><span class="sw line"></span>Flagged clash, active on this date</div>`;
}

function sliderLabels() {
  const r = state.rules, d = n => `${n} ${n === 1 ? "day" : "days"}`;
  $("#o-notice").textContent = d(r.notice);
  $("#o-minov").textContent = d(r.minOv);
  $("#o-buffer").textContent = r.buffer ? d(r.buffer) + " apart" : "off";
  $("#o-maxwin").textContent = r.maxWin >= MAXWIN_NONE ? "no limit" : d(r.maxWin);
  $("#o-minscore").textContent = (+r.minScore).toFixed(2);
}

function custom() { state.preset = "custom"; state.showN = 40; update(); }

function syncControls() {
  $("#op").value = state.op;
  document.querySelectorAll("#preset button").forEach(b => {
    b.setAttribute("aria-checked", b.dataset.p === state.preset);
    if (b.dataset.p === "custom") b.disabled = state.preset !== "custom";
  });
  const r = state.rules;
  document.querySelectorAll("#grid select").forEach(el => { el.value = r.m[el.dataset.ck] || 0; el.classList.toggle("off", !+el.value); });
  document.querySelectorAll('input[name="near"]').forEach(el => el.checked = el.value === r.near);
  $("#r-assumed").checked = r.assumed;
  $("#r-notice").value = r.notice;
  $("#r-notice").disabled = !r.assumed;
  $("#r-minov").value = r.minOv;
  $("#r-buffer").value = r.buffer;
  $("#r-maxwin").value = r.maxWin >= MAXWIN_NONE ? 760 : r.maxWin;
  $("#r-minscore").value = r.minScore;
  $("#r-internal").checked = r.internal;
  const WATCH = { any: "everything", seismic: "seismic surveys", site: "site surveys", notice: "survey notices", vsp: "VSP", rig: "rigs", vessel: "vessels", subsea: "pipeline works" };
  $("#watch-field").hidden = state.op === "all";
  $("#watch").innerHTML = Object.entries(WATCH).map(([k, t]) => `<option value="${k}">${k === "any" ? "All their activity" : "Their " + t}</option>`).join("");
  $("#watch").value = state.watch;
  sliderLabels();
  $("#lg-mine").hidden = state.op === "all";
}

// ---------------------------------------------------------------- UI: summary, years, timeline, list
function renderSummary() {
  const n = current.filter(p => inYear(p, state.year)).length;
  const who = state.op === "all" ? "across all operators" : `involving ${esc(state.op)}${state.watch !== "any" ? ` ${{ seismic: "seismic surveys", site: "site surveys", notice: "survey notices", vsp: "VSP", rig: "rigs", vessel: "vessels", subsea: "pipeline works" }[state.watch]}` : ""}`;
  const fy = meta.fileYears;
  const pYear = (current.filter(p => p.os >= Date.UTC(fy[0], 0, 1) && p.os <= Date.UTC(fy.at(-1), 11, 31)).length / fy.length).toFixed(1);
  const nNew = current.filter(p => p.isNew).length;
  const tracking = parse(meta.trackingSince) > meta.newSince;
  const newLine = tracking
    ? `Data updated ${fmt(meta.updatedMs)}. Checked every morning; tracking new applications since ${fmt(parse(meta.trackingSince))}.`
    : `Data updated ${fmt(meta.updatedMs)}. <button id="new-toggle" class="linkish${state.newOnly ? " on" : ""}" ${nNew ? "" : "disabled"}>${state.newOnly ? "Show all years" : `${nNew} ${nNew === 1 ? "alert involves" : "alerts involve"} applications new or changed since ${fmtShort(meta.newSince)}`}</button>`;
  $("#summary").innerHTML = (state.newOnly
    ? `<span class="big">${nNew}</span> flagged ${nNew === 1 ? "clash involves" : "clashes involve"} recent applications ${who}`
    : `<span class="big">${n}</span> flagged ${n === 1 ? "clash" : "clashes"} in ${state.year} ${who}`) +
    `<div class="sub">${state.preset === "custom" ? "Custom rules" : state.preset[0].toUpperCase() + state.preset.slice(1) + " setting"} ·
    about ${pYear} a year over ${fy[0]}–${fy.at(-1)}</div><div class="sub fresh">${newLine}</div>` +
    (INVITED && state.op !== "all" ? `<div class="sub"><button id="alert-btn" class="linkish">Email me when alerts start for ${esc(state.op)}</button></div>` : "");
  const ab = $("#alert-btn");
  if (ab) ab.onclick = openSignup;
  const t = $("#new-toggle");
  if (t) t.onclick = () => { state.newOnly = !state.newOnly; state.showN = 40; renderSummary(); renderYears(); renderList(); };
}

function renderYears() {
  $("#years").innerHTML = meta.years.map(y => {
    const n = current.filter(p => inYear(p, y)).length;
    return `<button data-y="${y}" aria-pressed="${y === state.year && !state.newOnly}"><b class="${n ? "" : "zero"}">${n}</b><small>${y}</small></button>`;
  }).join("");
  $("#years").onclick = e => {
    const y = +e.target.closest("button")?.dataset.y;
    if (!y) return;
    state.sel = null; state.showN = 40; state.newOnly = false;
    const d = new Date(state.date);
    setDate(Date.UTC(y, d.getUTCMonth(), Math.min(d.getUTCDate(), 28)), false);
  };
}

const sevColor = s => s >= 0.35 ? "#e03131" : s >= 0.2 ? "#f08c00" : "#fab005";

function renderTimeline() {
  const svg = $("#timeline");
  const W_ = svg.clientWidth || 400, H = 86, padL = 4, padR = 4, axisH = 14;
  const y0 = yStart(state.year), y1 = yEnd(state.year) + DAY;
  const x = t => padL + (Math.min(Math.max(t, y0), y1) - y0) / (y1 - y0) * (W_ - padL - padR);
  const items = current.filter(p => inYear(p, state.year)).sort((a, b) => a.os - b.os);
  const lanesEnd = [];
  const laneH = Math.max(3, Math.min(9, (H - axisH - 4) / Math.max(1, Math.min(items.length, 12))));
  const maxLanes = Math.floor((H - axisH - 4) / laneH);
  let bars = "";
  for (const p of items) {
    let lane = lanesEnd.findIndex(end => end < p.os);
    if (lane === -1) { lane = lanesEnd.length; lanesEnd.push(0); }
    lanesEnd[lane] = p.oe + 2 * DAY;
    if (lane >= maxLanes) continue;
    const y = 2 + lane * laneH;
    bars += `<rect class="bar${p.i === state.sel ? " sel" : ""}" data-i="${p.i}" x="${x(p.os)}" y="${y}" width="${Math.max(2, x(p.oe + DAY) - x(p.os))}" height="${laneH - 1.5}" rx="1.5" fill="${sevColor(p.score)}"><title>${esc(KIND[p.type])}: ${fmtRange(p.os, p.oe)}</title></rect>`;
  }
  let axis = "";
  for (let m = 0; m < 12; m++) {
    const t = Date.UTC(state.year, m, 1), xx = x(t);
    axis += `<line x1="${xx}" x2="${xx}" y1="${H - axisH}" y2="${H - axisH + 3}"/><text x="${xx + 2}" y="${H - 2}">${"JFMAMJJASOND"[m]}</text>`;
  }
  const now = state.date >= y0 && state.date < y1 ? `<line class="now" x1="${x(state.date)}" x2="${x(state.date)}" y1="0" y2="${H - axisH}"/>` : "";
  svg.setAttribute("viewBox", `0 0 ${W_} ${H}`);
  svg.innerHTML = `<g class="axis"><line x1="${padL}" x2="${W_ - padR}" y1="${H - axisH}" y2="${H - axisH}"/>${axis}</g>${bars}${now}` +
    (items.length ? "" : `<text x="${W_ / 2}" y="${(H - axisH) / 2 + 4}" text-anchor="middle" style="font:12px var(--sans);fill:#868e96">Nothing flagged in ${state.year} with these rules</text>`);
  svg.onclick = e => { const i = e.target.dataset?.i; if (i != null) select(+i); };
}

// What each PETS reference prefix means (from OPRED's PETS guidance and the Application Type column)
const REF = {
  GS: "Geological survey: a consent for seismic, profiler or shallow drilling work, or a notification for light surveys (echo sounder, side-scan, multibeam, visual)",
  CL: "Consent to locate: permission to put a rig, vessel, installation or pipeline in a given place",
  DR: "EIA direction to undertake drilling operations",
  DEP: "EIA direction to deposit materials on the seabed (rock, mattresses)",
  PL: "EIA direction for a new or changed pipeline",
  ML: "Marine licence for work or deposits on the seabed",
  DL: "Disturbance licence for European protected species (whales, dolphins, porpoises)",
  CP: "Chemical permit for chemicals used or discharged offshore",
  OTP: "Oil discharge permit", OLP: "Oil discharge permit",
  EWT: "EIA direction for an extended well test",
  DRA: "Drilling operation (the application that groups the other consents listed)",
  WIA: "Well intervention operation (the application that groups the other consents listed)",
  PLA: "Pipeline operation (the application that groups the other consents listed)",
  DCA: "Decommissioning operation (the application that groups the other consents listed)",
  SA: "Standalone application, usually a survey",
};
function refTag(r) {
  const t = REF[r.split("/")[0]];
  return t ? `<abbr title="${esc(r + ": " + t)}">${esc(r)}</abbr>` : esc(r);
}
const pending = a => /Submitted|Decision/.test(a.status || "") && !/Approved|Completed \(\)/.test(a.status || "");

function actLine(a) {
  const what = [a.label, a.field && `at ${esc(a.field)}`, a.unit && `· ${esc(a.unit)}`].filter(Boolean).join(" ");
  return `<span class="dot" style="--c:${CLS[a.cls].color}"></span><b>${esc(a.op)}</b> · ${esc(CLS[a.cls].short)}: ${what}
    <div class="ref">block ${a.block} · ${fmtRange(a.s, a.e)}${a.assumed ? " (end assumed)" : ""} · ${(a.cls === "rig" || a.cls === "vessel" || a.cls === "subsea" ? [a.key, ...a.refs.slice(0, 2)] : a.refs.slice(0, 2)).map(refTag).join(", ")}${a.refs.length > 2 ? "…" : ""}${pending(a) ? ` · <span class="pend" title="PETS status: ${esc(a.status)}">${a.e < Date.now() ? "no decision recorded" : "awaiting decision"}</span>` : ""}</div>`;
}

function renderList() {
  const items = state.newOnly ? current.filter(p => p.isNew) : current.filter(p => inYear(p, state.year));
  if (!items.length) {
    $("#list").innerHTML = state.newOnly
      ? `<div class="empty">No flagged clashes involve recent applications for this operator with these rules.</div>`
      : `<div class="empty">Nothing flagged in ${state.year} for this operator with these rules. Try another year, or turn the sensitivity up.</div>`;
    return;
  }
  const shown = items.slice(0, state.showN);
  $("#list").innerHTML = shown.map(p => {
    const [mine, other] = orient(p);
    const tags = state.op === "all" ? ["A", "B"] : p.shared ? ["Yours", "Also yours"] : ["Yours", "Other"];
    const live = p.os <= state.date && p.oe >= state.date;
    const chips = [
      `<span class="chip ${p.same ? "hot" : ""}">${p.same ? `same block ${p.a.block}` : `neighbouring blocks ${mine.block} and ${other.block}`}</span>`,
      p.ov > 0 ? `<span class="chip">overlap ${p.ov} days</span>` : `<span class="chip soft">near miss, ${p.gap} days apart</span>`,
      p.nAssumed ? `<span class="chip soft">end date assumed</span>` : `<span class="chip">both dated</span>`,
      p.longest > 150 ? `<span class="chip soft">long consent window (${p.longest} days)</span>` : "",
      p.shared ? `<span class="chip">same operator</span>` : "",
      ...[mine, other].filter(a => a.isNew).map(a => `<span class="chip new">${a.newKind} ${fmtShort(parse(a.newDate))}: ${esc(a.refs[0].split("/").slice(0, 2).join("/"))}</span>`),
    ].join("");
    return `<div class="alert${p.i === state.sel ? " sel" : ""}${live ? " live" : ""}" data-i="${p.i}" style="--sev:${sevColor(p.score)}">
      <div class="top"><span class="kind">${KIND[p.type]}</span><span class="score" title="Ranking score">${p.score.toFixed(2)}</span></div>
      <div class="when">${p.ov > 0 ? fmtRange(p.os, p.oe) : `Gap ${fmtRange(p.os, p.oe)}`}${live ? " · active on the date shown" : ""}</div>
      <div class="who"><span class="tag">${tags[0]}</span><span class="act">${actLine(mine)}</span><span class="tag">${tags[1]}</span><span class="act">${actLine(other)}</span></div>
      <div class="why">${chips}</div>
      ${scoreDetails(p)}
      ${feedbackBar(p)}</div>`;
  }).join("") + (items.length > shown.length ? `<div class="more">${items.length - shown.length} more · <button id="more">show more</button></div>` : "");
  $("#list").onclick = e => {
    if (e.target.id === "more") { state.showN += 60; renderList(); return; }
    const fb = e.target.closest("[data-v]");
    if (fb) { setVerdict(P[+fb.closest(".alert").dataset.i], fb.dataset.v); return; }
    if (e.target.closest(".calc, .fb")) return;
    const el = e.target.closest(".alert"); if (el) select(+el.dataset.i);
  };
  $("#list").onchange = e => {
    if (!e.target.classList.contains("fb-note")) return;
    const p = P[+e.target.closest(".alert").dataset.i];
    if (FB[p.key]) { FB[p.key].note = e.target.value.trim(); saveFeedback(); }
  };
}

function scoreDetails(p) {
  const f = p.f, x = v => v.toFixed(2);
  const rows = [
    [`Importance of ${KIND[p.type].toLowerCase()} (${C_SHORT[p.a.cls]} vs ${C_SHORT[p.b.cls]})`, `${p.level} of 5`, f.w],
    [p.same ? "Same block" : "Neighbouring block", "", f.near],
    [p.nAssumed ? `${p.nAssumed === 2 ? "Both end dates" : "One end date"} assumed (${state.rules.notice}-day notice)` : "Both dates from the consent", "", f.dates],
    [p.ov > 0 ? `Overlap ${p.ov} days (full credit from 30)` : `Near miss, ${p.gap} days apart (buffer ${state.rules.buffer})`, "", f.overlap],
    [`Longest consent window ${p.longest} days (vaguer when long)`, "", f.window],
  ];
  return `<details class="calc"><summary>How it's scored</summary><table>${rows.map(([t, n, v]) =>
    `<tr><td>${t}${n ? ` <small>${n}</small>` : ""}</td><td>× ${x(v)}</td></tr>`).join("")}
    <tr class="tot"><td>Score</td><td>= ${p.score.toFixed(3)}</td></tr></table></details>`;
}

// ---------------------------------------------------------------- server: voluntary sign-ups and feedback
const API = location.hostname === "localhost" ? "http://localhost:8787" : "https://api.simopsradar.com";
let INVITED = false;
try {
  if (new URLSearchParams(location.search).has("invite")) localStorage.setItem("simops-radar-invite", "1");
  INVITED = localStorage.getItem("simops-radar-invite") === "1";
} catch { INVITED = new URLSearchParams(location.search).has("invite"); }

async function post(path, body) {
  try {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok ? { ok: true } : { ok: false, error: j.error || `Something went wrong (${r.status}).` };
  } catch { return { ok: false, error: "Couldn't reach the server. Please try again later." }; }
}
const WATCH_TEXT = { any: "", seismic: " seismic surveys", site: " site surveys", notice: " survey notices", vsp: " VSP", rig: " rigs", vessel: " vessels", subsea: " pipeline works" };
function openSignup() {
  $("#su-what").textContent = `${state.op}${WATCH_TEXT[state.watch] || ""}`;
  $("#su-msg").textContent = ""; $("#su-msg").className = "msg";
  $("#su-form").hidden = false; $("#su-done").hidden = true;
  $("#signup").showModal();
}
async function submitSignup(remove) {
  const email = $("#su-email").value.trim(), msg = $("#su-msg");
  if (!email) { msg.textContent = "Please enter your email address."; msg.className = "msg err"; return; }
  if (!remove && !$("#su-consent").checked) { msg.textContent = "Please tick the box to agree."; msg.className = "msg err"; return; }
  msg.textContent = "Sending…"; msg.className = "msg";
  const res = remove
    ? await post("/remove", { email, website: $("#su-hp").value })
    : await post("/signup", { email, consent: true, operator: state.op, watching: state.watch, settings: location.href, website: $("#su-hp").value });
  if (!res.ok) { msg.textContent = res.error; msg.className = "msg err"; return; }
  $("#su-form").hidden = true; $("#su-done").hidden = false;
  $("#su-done-text").textContent = remove
    ? "Done. If that address was on the list, it has been removed."
    : `Thanks. You'll hear from me when alerts start for ${$("#su-what").textContent}. Nothing else.`;
}
async function sendFeedback() {
  const msg = $("#fb-msg"), email = $("#fb-email-addr").value.trim();
  if (!Object.keys(FB).length && !$("#fb-extra").value.trim()) { msg.textContent = "Mark an alert or write a note first."; msg.className = "msg err"; return; }
  msg.textContent = "Sending…"; msg.className = "msg";
  const extra = $("#fb-extra").value.trim();
  const res = await post("/feedback", { text: (extra ? `General note: ${extra}\n\n` : "") + feedbackText(), email, website: $("#fb-hp").value });
  msg.textContent = res.ok ? "Sent. Thank you." : res.error; msg.className = res.ok ? "msg ok" : "msg err";
}

// ---------------------------------------------------------------- feedback (kept in this browser only)
const FB_KEY = "simops-radar-feedback";
let FB = {};
try { FB = JSON.parse(localStorage.getItem(FB_KEY) || "{}") || {}; } catch { FB = {}; }
function saveFeedback() {
  try { localStorage.setItem(FB_KEY, JSON.stringify(FB)); } catch { /* storage unavailable: kept for this visit only */ }
  const n = Object.keys(FB).length;
  $("#fb-btn").textContent = n ? `Your feedback (${n})` : "Your feedback";
}
const V_LABEL = { real: "Real", not: "Not real", unsure: "Unsure" };
function feedbackBar(p) {
  const f = FB[p.key];
  return `<div class="fb"><span>Worth a call?</span>${Object.entries(V_LABEL).map(([v, t]) =>
    `<button type="button" data-v="${v}" class="${f?.v === v ? "on " + v : ""}">${t}</button>`).join("")}
    ${f ? `<input class="fb-note" type="text" placeholder="Why? (optional)" value="${esc(f.note || "")}" aria-label="Note">` : ""}</div>`;
}
function describe(p) {
  const [m, o] = orient(p);
  const one = a => `${a.op}, ${CLS[a.cls].short.toLowerCase()}${a.field ? " at " + a.field : ""}${a.unit ? " (" + a.unit + ")" : ""}, block ${a.block}, ${iso(a.s)} to ${iso(a.e)}${a.assumed ? " (end assumed)" : ""}, ${a.key}`;
  return `${KIND[p.type]}, ${p.ov > 0 ? `overlap ${p.ov} days from ${iso(p.os)}` : `${p.gap} days apart`}, score ${p.score.toFixed(2)}\n   ${one(m)}\n   ${one(o)}`;
}
function setVerdict(p, v) {
  if (FB[p.key]?.v === v) delete FB[p.key];
  else FB[p.key] = { v, note: FB[p.key]?.note || "", at: iso(Date.now()), what: describe(p) };
  saveFeedback(); renderList();
}
function feedbackText() {
  const items = Object.entries(FB).sort((a, b) => a[1].v.localeCompare(b[1].v));
  return `SIMOPS Radar feedback, ${fmt(Date.now())}\nSettings when sent: ${location.href}\n\n` +
    (items.length ? items.map(([k, f]) => `[${V_LABEL[f.v].toUpperCase()}] ${f.what}${f.note ? `\n   Note: ${f.note}` : ""}`).join("\n\n") : "(nothing marked yet)") + "\n";
}
function openFeedback() {
  const n = Object.keys(FB).length;
  const counts = Object.keys(V_LABEL).map(v => `${Object.values(FB).filter(f => f.v === v).length} ${V_LABEL[v].toLowerCase()}`).join(", ");
  $("#fb-summary").textContent = n ? `${n} alert${n > 1 ? "s" : ""} marked: ${counts}.` : "Nothing marked yet. Use the Real / Not real / Unsure buttons on each alert.";
  $("#fb-text").value = feedbackText();
  $("#fb-msg").textContent = "";
  $("#fb-dialog").showModal();
}

// ---------------------------------------------------------------- map
function initMap() {
  map = new maplibregl.Map({ container: "map", style: STYLE, center: [1.2, 57.6], zoom: 4.6, minZoom: 3.5, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("load", async () => {
    const blocks = blocksGeo = await fetch("data/blocks.geojson").then(r => r.json());
    const empty = { type: "FeatureCollection", features: [] };
    map.addSource("blocks", { type: "geojson", data: blocks, promoteId: "key" });
    ["hot", "acts", "links"].forEach(s => map.addSource(s, { type: "geojson", data: empty }));
    map.addLayer({ id: "blocks-line", type: "line", source: "blocks", paint: { "line-color": "#8aa1b5", "line-width": 0.4, "line-opacity": 0.6 } });
    map.addLayer({ id: "hot-fill", type: "fill", source: "hot", paint: { "fill-color": "#e03131", "fill-opacity": ["case", ["get", "sel"], 0.28, 0.13] } });
    map.addLayer({ id: "hot-line", type: "line", source: "hot", paint: { "line-color": "#e03131", "line-width": ["case", ["get", "sel"], 2, 1] } });
    map.addLayer({ id: "block-labels", type: "symbol", source: "blocks", minzoom: 6.5,
      layout: { "text-field": ["get", "key"], "text-size": 10, "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#6b7f91" } });
    map.addLayer({ id: "links", type: "line", source: "links", layout: { "line-cap": "round" },
      paint: { "line-color": "#e03131", "line-width": ["case", ["get", "sel"], 5, 2.5], "line-opacity": 0.85 } });
    map.addLayer({ id: "acts", type: "circle", source: "acts", paint: {
      "circle-color": ["get", "color"], "circle-radius": ["case", ["get", "mine"], 7, 5],
      "circle-stroke-color": ["case", ["get", "mine"], "#12202f", "#fff"], "circle-stroke-width": ["case", ["get", "mine"], 2.5, 1],
      "circle-opacity": ["case", ["get", "dim"], 0.35, 1] } });
    map.on("click", "acts", e => popup(e));
    map.on("mouseenter", "acts", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "acts", () => map.getCanvas().style.cursor = "");
    mapReady = true;
    renderMap();
    if (state.sel != null) fitSel();
  });
}

const ORDER = ["seismic", "vessel", "rig", "subsea", "site", "notice", "vsp"];
function renderMap() {
  if (!mapReady) return;
  const d = state.date;
  const active = A.filter(a => a.s <= d && a.e >= d && a.xy);
  const live = current.filter(p => p.os <= d && p.oe >= d);
  const inAlert = new Set(live.flatMap(p => [p.a.id, p.b.id]));
  const sel = state.sel != null ? P[state.sel] : null;
  const selIds = sel ? new Set([sel.a.id, sel.b.id]) : new Set();
  // spread several activities in one block around its centre
  const perBlock = {};
  const feats = active.sort((a, b) => ORDER.indexOf(a.cls) - ORDER.indexOf(b.cls)).map(a => {
    const k = perBlock[a.block] = (perBlock[a.block] ?? -1) + 1;
    const ang = k * 2.4, r = k ? 0.035 + 0.012 * k : 0;
    const xy = [a.xy[0] + r * Math.cos(ang) * 1.8, a.xy[1] + r * Math.sin(ang)];
    a._xy = xy;
    const mine = state.op !== "all" && a.owners.includes(state.op);
    const minor = ["site", "notice", "vsp"].includes(a.cls);
    return { type: "Feature", geometry: { type: "Point", coordinates: xy },
      properties: { id: a.id, color: CLS[a.cls].color, mine, dim: minor && !inAlert.has(a.id) && !selIds.has(a.id) } };
  });
  // the selected alert's activities are drawn even if the date is outside their window
  if (sel) for (const a of [sel.a, sel.b]) if (!(a.s <= d && a.e >= d) && a.xy) {
    a._xy = a.xy;
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: a.xy }, properties: { id: a.id, color: CLS[a.cls].color, mine: state.op !== "all" && a.owners.includes(state.op), dim: true } });
  }
  map.getSource("acts").setData({ type: "FeatureCollection", features: feats });
  const linkPairs = sel && !live.includes(sel) ? [...live, sel] : live;
  map.getSource("links").setData({ type: "FeatureCollection", features: linkPairs.filter(p => p.a._xy && p.b._xy).map(p => ({
    type: "Feature", geometry: { type: "LineString", coordinates: [p.a._xy, p.b._xy] }, properties: { sel: p === sel } })) });
  const blocksHot = new Map();
  for (const p of linkPairs) for (const k of [p.a.block, p.b.block]) blocksHot.set(k, blocksHot.get(k) || p === sel);
  const feats2 = blocksGeo.features.filter(f => blocksHot.has(f.properties.key)).map(f => ({ ...f, properties: { ...f.properties, sel: blocksHot.get(f.properties.key) } }));
  map.getSource("hot").setData({ type: "FeatureCollection", features: feats2 });
}

function popup(e) {
  const ids = new Set(e.features.map(f => f.properties.id));
  const block = A[[...ids][0]].block;
  const here = A.filter(a => a.block === block && a.s <= state.date && a.e >= state.date);
  const html = `<div class="pop"><h4>Block ${block} on ${fmt(state.date)}</h4><ul>` + here.map(a =>
    `<li class="${state.op !== "all" && a.owners.includes(state.op) ? "mine" : ""}"><span class="dot" style="--c:${CLS[a.cls].color}"></span>${esc(a.op)}: ${esc(CLS[a.cls].short)}${a.field ? " at " + esc(a.field) : ""}${a.unit ? " · " + esc(a.unit) : ""}<br><small>${fmtRange(a.s, a.e)}${a.assumed ? " (end assumed)" : ""}</small></li>`).join("") + `</ul></div>`;
  new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}

function fitSel() {
  if (!mapReady || state.sel == null) return;
  const p = P[state.sel];
  const pts = [p.a.xy, p.b.xy].filter(Boolean);
  if (!pts.length) return;
  const lons = pts.map(q => q[0]), lats = pts.map(q => q[1]);
  map.fitBounds([[Math.min(...lons) - 0.6, Math.min(...lats) - 0.35], [Math.max(...lons) + 0.6, Math.max(...lats) + 0.35]], { maxZoom: 7.5, duration: 800, padding: 40 });
}

// ---------------------------------------------------------------- time
function setDate(ms, fromSlider) {
  ms = Math.min(Math.max(ms, START), END);
  const y = new Date(ms).getUTCFullYear();
  const yearChanged = y !== state.year;
  state.date = ms; state.year = y;
  if (!fromSlider) $("#date").value = Math.round((ms - START) / DAY);
  $("#date-label").textContent = fmt(ms);
  if (yearChanged) { state.showN = 40; renderSummary(); renderYears(); renderList(); }
  else document.querySelectorAll(".alert").forEach(el => { const p = P[+el.dataset.i]; el.classList.toggle("live", p.os <= ms && p.oe >= ms); });
  renderTimeline();
  renderMap();
  saveHash();
}

function togglePlay() {
  if (state.playing) { clearInterval(state.playing); state.playing = null; $("#play").textContent = "▶"; $("#play").setAttribute("aria-label", "Play"); return; }
  if (state.date >= END) setDate(START, false);
  $("#play").textContent = "❚❚"; $("#play").setAttribute("aria-label", "Pause");
  state.playing = setInterval(() => { if (state.date >= END) togglePlay(); else setDate(state.date + 3 * DAY, false); }, 90);
}

function select(i) {
  state.sel = state.sel === i ? null : i;
  if (state.sel != null) {
    const p = P[i];
    const target = state.date >= p.os && state.date <= p.oe ? state.date : p.ov > 0 ? p.os + Math.min(7, Math.floor(p.ov / 2)) * DAY : p.os;
    if (state.playing) togglePlay();
    setDate(target, false);
    fitSel();
  } else renderMap();
  renderList(); renderTimeline();
  document.querySelector(".alert.sel")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ---------------------------------------------------------------- state in the URL
function saveHash() {
  const h = new URLSearchParams({ op: state.op, p: state.preset, d: iso(state.date) });
  if (state.op !== "all" && state.watch !== "any") h.set("w", state.watch);
  if (state.preset === "custom") h.set("r", JSON.stringify({ ...state.rules, m: CELLS.map(ck => state.rules.m[ck] || 0).join("") }));
  history.replaceState(null, "", "#" + h.toString());
}
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("op") && (h.get("op") === "all" || meta.operators.some(([n]) => n === h.get("op")))) state.op = h.get("op");
  if (CLS[h.get("w")]) state.watch = h.get("w");
  const p = h.get("p");
  if (PRESETS[p]) { state.preset = p; state.rules = structuredClone(PRESETS[p]); }
  if (p === "custom") {
    try {
      const r = JSON.parse(h.get("r"));
      const m = typeof r.m === "string" ? Object.fromEntries(CELLS.map((ck, i) => [ck, Math.min(5, +r.m[i] || 0)])) : PRESETS.quiet.m;
      if (CLS[r.mySide] && !CLS[h.get("w")]) state.watch = r.mySide;
      delete r.mySide;
      state.rules = { ...structuredClone(PRESETS.quiet), ...r, m };
      state.preset = "custom";
    } catch { /* keep default */ }
  }
  const d = parse(h.get("d") || "");
  if (!isNaN(d)) { state.date = Math.min(Math.max(d, START), END); state.year = new Date(state.date).getUTCFullYear(); }
}

// ---------------------------------------------------------------- go
function update() {
  recompute(); syncControls();
  renderSummary(); renderYears(); renderTimeline(); renderList(); renderMap(); saveHash();
}

(async function main() {
  await load();
  buildControls();
  document.querySelector(".brand p").textContent = `Early warning of clashing offshore operations, from public consent data. UK continental shelf, ${meta.years[0]} onwards, updated daily.`;
  readHash();
  $("#date").value = Math.round((state.date - START) / DAY);
  $("#date-label").textContent = fmt(state.date);
  update();
  if (innerWidth < 860) document.querySelector(".legend").open = false;
  initMap();
  addEventListener("resize", renderTimeline);
})().catch(err => {
  console.error(err);
  $("#summary").innerHTML = `<span style="color:#c92a2a">Could not load the data: ${esc(err.message)}</span>`;
});
