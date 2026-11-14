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
const C_SHORT = { seismic: "Seismic", site: "Site", notice: "Notice", vsp: "VSP", rig: "Rig", vessel: "Vessel", subsea: "Pipeline" };
const C_HELP = { seismic: "Seismic survey (3D, 4D, ocean-bottom)", site: "Site survey (2D high-res, sub-bottom profilers, shallow drilling)", notice: "Survey notice: light survey (echo sounder, sonar, visual) with no end date", vsp: "VSP: borehole seismic shot from a rig", rig: "Drilling or intervention rig", vessel: "Intervention or dive vessel", subsea: "Pipeline or subsea works" };
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
  op: "all", watch: "any", preset: "quiet", rules: structuredClone(PRESETS.quiet), mode: "ahead",
  year: 2026, date: Date.UTC(2026, 10, 13), sel: null, showN: 40, playing: null, newOnly: false,
};

let A = [], P = [], meta = {}, map = null, mapReady = false, current = [], blocksGeo = null;
let TODAY = Date.UTC(2026, 10, 14);  // the data date; set in load()
const isAhead = p => p.oe >= TODAY, isPast = p => p.oe < TODAY;
const pastYears = () => meta.years.filter(y => yStart(y) <= TODAY);
const rel = days => days <= 1 ? (days === 1 ? "tomorrow" : "today") : days < 15 ? `in ${days} days` : days < 70 ? `in ${Math.round(days / 7)} weeks` : `in ${Math.round(days / 30.4)} months`;
const sevLabel = s => s >= 0.35 ? "High" : s >= 0.2 ? "Medium" : "Low";
const PRESET_TEXT = { quiet: "Quiet: only the most serious kinds", medium: "Medium: more kinds of clash", loud: "Loud: everything", custom: "Custom rules" };

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
  TODAY = meta.updatedMs;
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
  op.innerHTML = `<option value="all">All companies</option>` +
    meta.operators.filter(([, n]) => n >= 3).map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join("") +
    `<optgroup label="Fewer than 3 applications">` +
    meta.operators.filter(([, n]) => n < 3).sort().map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join("") + `</optgroup>`;
  op.onchange = () => { state.op = op.value; state.sel = null; state.showN = 40; update(); };

  // pairing grid: activity types on both axes, importance 0-5 in each cell of the upper triangle
  const opt = v => `<option value="${v}">${v ? v : "–"}</option>`;
  $("#grid").innerHTML = `<table class="grid"><tr><th></th>${C.map(c => `<th title="${esc(C_HELP[c])}"><span class="dot" style="--c:${CLS[c].color}"></span>${C_SHORT[c]}</th>`).join("")}</tr>` +
    C.map((x, i) => `<tr><th title="${esc(C_HELP[x])}"><span class="dot" style="--c:${CLS[x].color}"></span>${C_SHORT[x]}</th>` + C.map((y, j) => {
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
  $("#about-btn").onclick = () => { $("#about").showModal(); setTimeout(() => { $("#about").scrollTop = 0; }, 30); };
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
    `<div class="row" id="lg-mine"><span class="sw mine" style="--c:#fff"></span>Chosen company's work</div>` +
    `<div class="row"><span class="sw line"></span>Clash on the map date</div>` +
    `<div class="row"><span class="sw hotblk"></span>Block with a clash coming up</div>`;
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
  const who = state.op === "all" ? "across all companies" : `for ${esc(state.op)}${esc(WATCH_TEXT[state.watch] || "")}`;
  const ahead = current.filter(isAhead);
  const nNew = ahead.filter(p => p.isNew).length;
  const tracking = parse(meta.trackingSince) > meta.newSince;
  let html;
  if (state.mode === "ahead") {
    const n = state.newOnly ? nNew : ahead.length;
    const now = ahead.filter(p => p.os <= TODAY).length;
    const next = ahead.filter(p => p.os > TODAY).sort((a, b) => a.os - b.os)[0];
    const lines = [];
    if (now) lines.push(`${now} happening now`);
    if (next) lines.push(`next starts ${rel(Math.round((next.os - TODAY) / DAY))} (${fmtShort(next.os)})`);
    html = `<span class="big">${n}</span> ${state.newOnly ? `${n === 1 ? "clash involves" : "clashes involve"} new applications` : `${n === 1 ? "clash" : "clashes"} coming up`} ${who}` +
      (lines.length ? `<div class="sub">${lines.join(" · ")}</div>` : "") +
      `<div class="sub">${PRESET_TEXT[state.preset]}${!tracking && nNew ? ` · <button id="new-toggle" class="linkish${state.newOnly ? " on" : ""}">${state.newOnly ? "show all coming up" : `${nNew} involve${nNew === 1 ? "s" : ""} applications new since ${fmtShort(meta.newSince)}`}</button>` : ""}</div>`;
  } else {
    const n = current.filter(p => isPast(p) && inYear(p, state.year)).length;
    const fy = meta.fileYears.filter(y => yStart(y) <= TODAY);
    const pYear = Math.round(current.filter(p => isPast(p) && p.os >= yStart(fy[0])).length / Math.max(1, (TODAY - yStart(fy[0])) / (365.25 * DAY)));
    html = `<span class="big">${n}</span> ${n === 1 ? "clash" : "clashes"} in ${state.year} ${who}` +
      `<div class="sub">${PRESET_TEXT[state.preset]} · about ${pYear} a year since ${fy[0]}</div>` +
      `<div class="sub ask">Looking back is how the rules get checked. If you know what happened, mark each clash 👍 or 👎.</div>`;
  }
  if (INVITED && state.op !== "all") html += `<div class="sub"><button id="alert-btn" class="linkish">✉ Email me when alerts start for ${esc(state.op)}</button></div>`;
  $("#summary").innerHTML = html;
  const ab = $("#alert-btn");
  if (ab) ab.onclick = openSignup;
  const t = $("#new-toggle");
  if (t) t.onclick = () => { state.newOnly = !state.newOnly; state.showN = 40; renderSummary(); renderList(); renderTimeline(); };
}

function setMode(m) {
  if (state.playing) togglePlay();
  state.mode = m; state.sel = null; state.showN = 40; state.newOnly = false;
  let d = state.date;
  if (m === "ahead") d = TODAY;
  else if (d >= TODAY) d = TODAY - DAY;
  state.date = d; state.year = new Date(d).getUTCFullYear();
  $("#date").value = Math.round((d - START) / DAY);
  $("#date-label").textContent = fmt(d);
  update();
}

function renderYears() {
  const nAhead = current.filter(isAhead).length;
  document.querySelectorAll("#modes button").forEach(b => {
    b.setAttribute("aria-selected", b.dataset.m === state.mode);
    if (b.dataset.m === "ahead") b.querySelector("b").textContent = nAhead;
  });
  $("#modes").onclick = e => { const b = e.target.closest("button"); if (b && b.dataset.m !== state.mode) setMode(b.dataset.m); };
  $("#years").hidden = state.mode !== "back";
  if (state.mode !== "back") return;
  $("#years").innerHTML = pastYears().map(y => {
    const n = current.filter(p => isPast(p) && inYear(p, y)).length;
    return `<button data-y="${y}" aria-pressed="${y === state.year}"><b class="${n ? "" : "zero"}">${n}</b><small>${y}</small></button>`;
  }).join("");
  $("#years").onclick = e => {
    const y = +e.target.closest("button")?.dataset.y;
    if (!y) return;
    state.sel = null; state.showN = 40;
    const d = new Date(state.date);
    setDate(Math.min(Date.UTC(y, d.getUTCMonth(), Math.min(d.getUTCDate(), 28)), TODAY - DAY), false);
  };
}

function listItems() {
  if (state.mode === "ahead") {
    const it = current.filter(isAhead).filter(p => !state.newOnly || p.isNew);
    // happening now first (most serious first), then the rest by start date
    return it.sort((a, b) => (a.os > TODAY) - (b.os > TODAY) || (a.os <= TODAY ? b.score - a.score : a.os - b.os));
  }
  return current.filter(p => isPast(p) && inYear(p, state.year));
}
function timeWindow() {
  if (state.mode === "back") return [yStart(state.year), yEnd(state.year) + DAY];
  const items = listItems();
  const last = items.length ? Math.max(...items.map(p => p.oe)) : 0;
  return [TODAY - 14 * DAY, Math.min(Math.max(TODAY + 183 * DAY, last + 7 * DAY), TODAY + 400 * DAY)];
}

const sevColor = s => s >= 0.35 ? "#e03131" : s >= 0.2 ? "#f08c00" : "#fab005";

function renderTimeline() {
  const svg = $("#timeline");
  const W_ = svg.clientWidth || 400, H = svg.clientHeight || 120, padL = 4, padR = 4, axisH = 14;
  const [y0, y1] = timeWindow();
  const x = t => padL + (Math.min(Math.max(t, y0), y1) - y0) / (y1 - y0) * (W_ - padL - padR);
  const items = listItems().filter(p => p.oe >= y0 && p.os < y1).sort((a, b) => a.os - b.os);
  const lanesEnd = [];
  const laneH = Math.max(4, Math.min(14, (H - axisH - 4) / Math.max(1, Math.min(items.length, 12))));
  const maxLanes = Math.floor((H - axisH - 4) / laneH);
  let bars = "";
  for (const p of items) {
    let lane = lanesEnd.findIndex(end => end < p.os);
    if (lane === -1) { lane = lanesEnd.length; lanesEnd.push(0); }
    lanesEnd[lane] = p.oe + 2 * DAY;
    if (lane >= maxLanes) continue;
    const y = 2 + lane * laneH;
    bars += `<rect class="bar${p.i === state.sel ? " sel" : ""}" data-i="${p.i}" x="${x(p.os)}" y="${y}" width="${Math.max(2, x(p.oe + DAY) - x(p.os))}" height="${laneH - 1.5}" rx="1.5" fill="${sevColor(p.score)}"><title>${esc(KIND[p.type])} (${sevLabel(p.score).toLowerCase()}): ${fmtRange(p.os, p.oe)}</title></rect>`;
  }
  let axis = "";
  const d0 = new Date(y0), span = (y1 - y0) / DAY;
  for (let t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1); t < y1; t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) {
    const dt = new Date(t), m = dt.getUTCMonth(), xx = x(t);
    const label = m === 0 && state.mode === "ahead" ? String(dt.getUTCFullYear()) : span < 260 && W_ > 420 ? dt.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) : "JFMAMJJASOND"[m];
    axis += `<line x1="${xx}" x2="${xx}" y1="${H - axisH}" y2="${H - axisH + 3}"/><text x="${xx + 2}" y="${H - 2}">${label}</text>`;
  }
  if (state.mode === "back") axis = `<line x1="${x(y0)}" x2="${x(y0)}" y1="${H - axisH}" y2="${H - axisH + 3}"/><text x="${x(y0) + 2}" y="${H - 2}">J</text>` + axis;
  const today = state.mode === "ahead" ? `<line class="today" x1="${x(TODAY)}" x2="${x(TODAY)}" y1="0" y2="${H - axisH}"/><text class="today-t" x="${x(TODAY) + 3}" y="${H - axisH - 3}">today</text>` : "";
  const now = state.date >= y0 && state.date < y1 && !(state.mode === "ahead" && state.date === TODAY) ? `<line class="now" x1="${x(state.date)}" x2="${x(state.date)}" y1="0" y2="${H - axisH}"/>` : "";
  svg.setAttribute("viewBox", `0 0 ${W_} ${H}`);
  svg.innerHTML = `<g class="axis"><line x1="${padL}" x2="${W_ - padR}" y1="${H - axisH}" y2="${H - axisH}"/>${axis}</g>${today}${bars}${now}` +
    (items.length ? "" : `<text x="${W_ / 2}" y="${(H - axisH) / 2 + 4}" text-anchor="middle" style="font:12px var(--sans);fill:#868e96">${state.mode === "ahead" ? "Nothing coming up with these settings" : `Nothing flagged in ${state.year} with these settings`}</text>`);
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
  const items = listItems();
  if (!items.length) {
    $("#list").innerHTML = state.mode === "ahead"
      ? `<div class="empty">Nothing coming up with these settings. Try <b>Medium</b> or <b>Loud</b>, or <b>Look back</b> to see past clashes.</div>`
      : `<div class="empty">Nothing flagged in ${state.year} with these settings. Try another year, or turn the sensitivity up.</div>`;
    return;
  }
  const shown = items.slice(0, state.showN);
  $("#list").innerHTML = shown.map(p => {
    const [mine, other] = orient(p);
    const short = n => n.length > 18 ? n.split(/\s|\//)[0] : n;
    const tags = state.op === "all" ? null : [short(state.op), p.shared ? short(state.op) : "Other"];
    const live = p.os <= state.date && p.oe >= state.date;
    const months = Math.round(p.longest / 30.4);
    const chips = [
      `<span class="chip ${p.same ? "hot" : ""}">${p.same ? `same block ${p.a.block}` : `next-door blocks ${mine.block} and ${other.block}`}</span>`,
      p.ov > 0 ? `<span class="chip">overlap ${p.ov} days</span>` : `<span class="chip soft">near miss, ${p.gap} days apart</span>`,
      p.nAssumed ? `<span class="chip soft" title="Survey notices have no end date, so one was assumed">end date guessed</span>` : `<span class="chip" title="Both consents give start and end dates">firm dates</span>`,
      p.longest > 150 ? `<span class="chip soft" title="Long consent windows say little about when the work actually happens">consent covers ${months} months, timing vague</span>` : "",
      p.shared ? `<span class="chip">same company</span>` : "",
      ...[mine, other].filter(a => a.isNew).map(a => `<span class="chip new">${a.newKind} ${fmtShort(parse(a.newDate))}: ${esc(a.refs[0].split("/").slice(0, 2).join("/"))}</span>`),
    ].join("");
    return `<div class="alert${p.i === state.sel ? " sel" : ""}${live ? " live" : ""}" data-i="${p.i}" style="--sev:${sevColor(p.score)}">
      <div class="top"><span class="kind">${KIND[p.type]}</span><span class="sev sev-${sevLabel(p.score).toLowerCase()}" title="Score ${p.score.toFixed(2)}. Open 'Why this rating' for how it's worked out.">${sevLabel(p.score)}</span></div>
      <div class="when">${whenText(p, live)}</div>
      <div class="who${tags ? "" : " notags"}">${tags ? `<span class="tag">${esc(tags[0])}</span>` : ""}<span class="act">${actLine(mine)}</span>${tags ? `<span class="tag">${esc(tags[1])}</span>` : ""}<span class="act">${actLine(other)}</span></div>
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

function whenText(p, live) {
  const range = p.ov > 0 ? fmtRange(p.os, p.oe) : `gap ${fmtRange(p.os, p.oe)}`;
  if (state.mode === "ahead") {
    if (p.os <= TODAY) return `<b class="now-tag">Happening now</b> · until ${fmt(p.oe)}`;
    return `<b>Starts ${rel(Math.round((p.os - TODAY) / DAY))}</b> · ${range}`;
  }
  return range + (live ? " · on the map date" : "");
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
  return `<details class="calc"><summary>Why ${sevLabel(p.score).toLowerCase()}?</summary><table>${rows.map(([t, n, v]) =>
    `<tr><td>${t}${n ? ` <small>${n}</small>` : ""}</td><td>× ${x(v)}</td></tr>`).join("")}
    <tr class="tot"><td>Score (High from 0.35, Medium from 0.20)</td><td>= ${p.score.toFixed(3)}</td></tr></table></details>`;
}

// ---------------------------------------------------------------- server: voluntary sign-ups and feedback
const API = location.hostname === "localhost" ? "http://localhost:8787" : "https://simops-radar-api.robdunfey.workers.dev";
let INVITED = false;
try {
  if (/[?&#]invite\b/.test(location.search + location.hash)) localStorage.setItem("simops-radar-invite", "1");
  INVITED = localStorage.getItem("simops-radar-invite") === "1";
} catch { INVITED = /[?&#]invite\b/.test(location.search + location.hash); }

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
  $("#fb-btn").textContent = n ? `Send feedback (${n})` : "Send feedback";
}
const V_LABEL = {
  ahead: { real: ["👍", "Useful"], not: ["👎", "Not useful"] },
  back: { real: ["👍", "Real clash"], not: ["👎", "Not a clash"], unsure: ["🤷", "Not sure"] },
};
const vText = f => (V_LABEL[f.mode || "back"][f.v] || ["", f.v])[1];
function feedbackBar(p) {
  const f = FB[p.key], mode = state.mode;
  return `<div class="fb"><span>${mode === "ahead" ? "Useful heads-up?" : "Did this really clash?"}</span>${Object.entries(V_LABEL[mode]).map(([v, [icon, t]]) =>
    `<button type="button" data-v="${v}" class="${f?.v === v && (f.mode || "back") === mode ? "on " + v : ""}" title="${t}" aria-label="${t}">${icon} <span>${t}</span></button>`).join("")}
    ${f ? `<input class="fb-note" type="text" placeholder="${mode === "ahead" ? "Anything to add? (optional)" : "What happened? (optional)"}" value="${esc(f.note || "")}" aria-label="Note">` : ""}</div>`;
}
function describe(p) {
  const [m, o] = orient(p);
  const one = a => `${a.op}, ${CLS[a.cls].short.toLowerCase()}${a.field ? " at " + a.field : ""}${a.unit ? " (" + a.unit + ")" : ""}, block ${a.block}, ${iso(a.s)} to ${iso(a.e)}${a.assumed ? " (end assumed)" : ""}, ${a.key}`;
  return `${KIND[p.type]}, ${p.ov > 0 ? `overlap ${p.ov} days from ${iso(p.os)}` : `${p.gap} days apart`}, score ${p.score.toFixed(2)}\n   ${one(m)}\n   ${one(o)}`;
}
function setVerdict(p, v) {
  const mode = state.mode;
  if (FB[p.key]?.v === v && (FB[p.key].mode || "back") === mode) delete FB[p.key];
  else FB[p.key] = { v, mode, note: FB[p.key]?.note || "", at: iso(Date.now()), what: describe(p) };
  saveFeedback(); renderList();
}
function feedbackText() {
  const items = Object.entries(FB).sort((a, b) => a[1].v.localeCompare(b[1].v));
  return `SIMOPS Radar feedback, ${fmt(Date.now())}\nSettings when sent: ${location.href}\n\n` +
    (items.length ? items.map(([k, f]) => `[${vText(f).toUpperCase()}${f.mode === "ahead" ? ", coming up" : ""}] ${f.what}${f.note ? `\n   Note: ${f.note}` : ""}`).join("\n\n") : "(nothing marked yet)") + "\n";
}
function openFeedback() {
  const n = Object.keys(FB).length;
  const tally = {};
  for (const f of Object.values(FB)) { const t = vText(f).toLowerCase(); tally[t] = (tally[t] || 0) + 1; }
  const counts = Object.entries(tally).map(([t, c]) => `${c} ${t}`).join(", ");
  $("#fb-summary").textContent = n ? `${n} clash${n > 1 ? "es" : ""} marked: ${counts}.` : "Nothing marked yet. Use the 👍 and 👎 buttons on each clash.";
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
  if (state.mode === "ahead") for (const p of listItems()) for (const k of [p.a.block, p.b.block]) blocksHot.set(k, false);
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
  if (state.mode === "back" && ms >= TODAY) { state.date = TODAY; setMode("ahead"); return; }
  if (state.mode === "ahead" && ms < TODAY - 14 * DAY) { setMode("back"); return; }
  if (yearChanged && state.mode === "back") { state.showN = 40; renderSummary(); renderYears(); renderList(); }
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
  const h = new URLSearchParams({ op: state.op, p: state.preset });
  if (state.mode === "back") { h.set("m", "back"); h.set("d", iso(state.date)); }
  else if (state.date !== TODAY) h.set("d", iso(state.date));
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
  // old links (e.g. the Gannet example) carry a past date and no mode: open them in Look back
  state.mode = h.get("m") === "back" || (!h.get("m") && !isNaN(d) && d < TODAY - 14 * DAY) ? "back" : "ahead";
  if (state.mode === "back" && state.date >= TODAY) { state.date = TODAY - DAY; state.year = new Date(state.date).getUTCFullYear(); }
}

// ---------------------------------------------------------------- go
function update() {
  recompute(); syncControls();
  renderSummary(); renderYears(); renderTimeline(); renderList(); renderMap(); saveHash();
}

(async function main() {
  await load();
  try { if (!localStorage.getItem("simops-radar-hint")) $("#hint").hidden = false; } catch { $("#hint").hidden = false; }
  $("#hint button").onclick = () => { $("#hint").hidden = true; try { localStorage.setItem("simops-radar-hint", "1"); } catch { /* fine */ } };
  buildControls();
  $("#live-pill span").textContent = `Updated ${fmtShort(meta.updatedMs)} · ${meta.years[0]} onwards`;
  $("#live-pill").title = `Built from OPRED's public consent data, checked every morning. Last changed ${fmt(meta.updatedMs)}.`;
  $("#ai-pill").onclick = () => { $("#about").showModal(); setTimeout(() => { const d = $("#about"); d.scrollTop = $("#about-ai").offsetTop - 16; }, 30); };
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
