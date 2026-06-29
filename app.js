/* ===========================================================================
 * PDMap — a "global earth" interface for the Paleobiology Database (PBDB).
 * Pure static front-end. No backend: the PBDB data service is CORS-enabled,
 * so the browser talks to it directly.
 *   API docs: https://paleobiodb.org/data1.2/
 * =========================================================================== */

const PBDB = "https://paleobiodb.org/data1.2";

/* Geological periods (ICS) with age spans (Ma) and official colours.
 * Used for the period dropdown, the legend, and colouring points by age. */
const PERIODS = [
  { name: "Quaternary",    max: 2.58,   min: 0,      color: "#F9F97F" },
  { name: "Neogene",       max: 23.03,  min: 2.58,   color: "#FFE619" },
  { name: "Paleogene",     max: 66,     min: 23.03,  color: "#FD9A52" },
  { name: "Cretaceous",    max: 145,    min: 66,     color: "#7FC64E" },
  { name: "Jurassic",      max: 201.4,  min: 145,    color: "#34B2C9" },
  { name: "Triassic",      max: 251.9,  min: 201.4,  color: "#812B92" },
  { name: "Permian",       max: 298.9,  min: 251.9,  color: "#F04028" },
  { name: "Carboniferous", max: 358.9,  min: 298.9,  color: "#67A599" },
  { name: "Devonian",      max: 419.2,  min: 358.9,  color: "#CB8C37" },
  { name: "Silurian",      max: 443.8,  min: 419.2,  color: "#B3E1B6" },
  { name: "Ordovician",    max: 485.4,  min: 443.8,  color: "#009270" },
  { name: "Cambrian",      max: 538.8,  min: 485.4,  color: "#7FA056" },
  { name: "Ediacaran",     max: 635,    min: 538.8,  color: "#FED96A" },
];

/* Colour bands used to paint points and draw the legend. Starts as the built-in
 * Phanerozoic periods and is replaced with the full set (incl. all Precambrian
 * periods) once the live timescale loads. */
let BANDS = PERIODS;
const bandFor = (ma) => BANDS.find((p) => ma <= p.max && ma > p.min);

/* Colour-blind-safe option. When on, the ICS period colours (which aren't CVD
 * friendly) are swapped for a perceptually-uniform viridis ramp ordered young →
 * old, so age still reads as a smooth gradient for every kind of colour vision. */
let cbSafe = false;
let cbMap = new Map();
const CB_STOPS = ["#fde725", "#5ec962", "#21918c", "#3b528b", "#440154"]; // viridis
const hex2rgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
function lerpStops(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const seg = (stops.length - 1) * t, i = Math.floor(seg), f = seg - i;
  const a = hex2rgb(stops[i]), b = hex2rgb(stops[Math.min(i + 1, stops.length - 1)]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function buildCbMap() {
  cbMap = new Map();
  const bands = [...BANDS].sort((a, b) => a.min - b.min); // youngest → oldest
  const n = bands.length;
  bands.forEach((b, i) => cbMap.set(b.name, lerpStops(CB_STOPS, n > 1 ? i / (n - 1) : 0)));
}
const bandColor = (b) => cbSafe ? (cbMap.get(b.name) || b.color) : b.color;

const colorForAge = (ma) => {
  const p = bandFor(ma);
  return p ? bandColor(p) : (cbSafe ? "#777" : "#9a8aa0");
};

/* ----------------------------------------------------------------- Globe --- */
const ASSET = "vendor/img";
const MARBLE = `${ASSET}/earth-blue-marble.jpg`;
// ESRI World Imagery — free XYZ satellite tiles, CORS-enabled, no API key.
// globe.gl asks for (x, y, level); ESRI's REST path is /tile/{level}/{row}/{col}.
const ESRI_TILES = (x, y, l) =>
  `https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`;

const globe = Globe()(document.getElementById("globe"))
  .globeImageUrl(MARBLE)
  .bumpImageUrl(`${ASSET}/earth-topology.png`)
  .backgroundImageUrl(`${ASSET}/night-sky.png`)
  .pointLat("plat")
  .pointLng("plng")
  .pointColor((d) => d === hoveredPoint ? "#ffffff" : pointPaint(d))
  .pointAltitude(0.01)
  .pointRadius((d) => d._r || 0.22)
  .pointLabel(pointLabel)
  .onPointClick(openLocality)
  .onPointHover(onPointHover)
  .pointsTransitionDuration(0);

/* Highlight the marker under the cursor with a simple colour change (on top of
 * the existing tooltip), and show a pointer cursor. */
let hoveredPoint = null;
function onPointHover(pt) {
  if (pt === hoveredPoint) return;
  hoveredPoint = pt;
  document.body.style.cursor = pt ? "pointer" : "";
  globe.pointColor(globe.pointColor()); // redraw with the hovered point recoloured
}

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.35;

/* Smooth, even zooming. Damping takes the jerk out of the wheel so it no longer
 * feels slow then suddenly rapid; zoomToCursor keeps whatever you point at under
 * the cursor as you zoom in. The minimum-distance clamp stops you zooming closer
 * than the satellite imagery can resolve, which is what made it go blurry. */
const GLOBE_R = 100; // globe.gl's fixed globe radius (world units)
globe.controls().enableDamping = true;
globe.controls().dampingFactor = 0.25;
globe.controls().zoomSpeed = 1.0;
globe.controls().zoomToCursor = true;
globe.controls().minDistance = GLOBE_R * 1.015; // ≈ closest altitude 0.015

/* Crank texture filtering to the GPU's maximum so the globe stays crisp at
 * oblique angles instead of smearing. The base texture loads asynchronously,
 * so retry a few times until its material map exists. */
function boostAnisotropy() {
  const r = globe.renderer ? globe.renderer() : null;
  const max = r ? r.capabilities.getMaxAnisotropy() : 8;
  const mat = globe.globeMaterial();
  const map = mat && mat.map;
  if (mat) mat.bumpScale = 14; // exaggerate relief so mountains/trenches read as 3D
  if (map && map.anisotropy !== max) {
    map.anisotropy = max;
    map.needsUpdate = true;
  }
  return !!map;
}
let _aniTries = 0;
function tryAnisotropy() {
  if (boostAnisotropy() || _aniTries++ > 40) return;
  setTimeout(tryAnisotropy, 150);
}

/* Switch the globe surface between the offline Blue Marble texture and live
 * high-resolution satellite tiles (which keep getting sharper as you zoom). */
function setBaseLayer(mode) {
  if (mode === "satellite") {
    globe.globeImageUrl(null).bumpImageUrl(null)
      .globeTileEngineUrl(ESRI_TILES).globeTileEngineMaxLevel(18);
  } else {
    globe.globeTileEngineUrl(null).globeImageUrl(MARBLE).bumpImageUrl(`${ASSET}/earth-topology.png`);
    _aniTries = 0; tryAnisotropy();
  }
}

/* Scale point size with camera distance so markers shrink as you zoom in
 * (instead of ballooning). Radius is in angular degrees; tie it to altitude. */
const DEFAULT_ALT = 2.5;
function radiusForAltitude(alt) {
  return Math.max(0.025, Math.min(0.6, alt * 0.09));
}
let _lastRadius = null;
function applyPointSize(alt) {
  const r = Math.round(radiusForAltitude(alt) * 1000) / 1000;
  if (r === _lastRadius) return;
  _lastRadius = r;
  for (const d of globe.pointsData()) d._r = r;
  globe.pointRadius(globe.pointRadius()); // re-trigger the accessor
}
/* Pause auto-rotation once you zoom in past this altitude, so the globe holds
 * still while you inspect a region; it resumes when you zoom back out (unless
 * you've switched auto-rotate off manually). */
const SPIN_STOP_ALT = 1.6;
let spinWanted = true;
function updateSpin(alt) {
  globe.controls().autoRotate = spinWanted && alt >= SPIN_STOP_ALT;
}

function onCameraChange(alt) {
  applyPointSize(alt);
  updateSpin(alt);
  if (densityOn()) scheduleDensity(); // refine clusters / resize markers as you zoom
}
globe.onZoom((pov) => onCameraChange(pov.altitude));
// Belt-and-braces: the controls' own change event fires on every zoom/drag,
// including mouse-wheel, so sizing and spin always track the camera distance.
globe.controls().addEventListener("change", () =>
  onCameraChange(globe.pointOfView().altitude));

function resize() {
  globe.width(window.innerWidth).height(window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

function pointLabel(d) {
  return `<div style="background:#0c1018;border:1px solid #283244;border-radius:8px;
    padding:6px 9px;max-width:240px;font-size:12px;color:#e6ebf2;">
      <b>${esc(d.nam || "Unnamed locality")}</b><br/>
      <span style="color:#8a97aa">${esc(d.oei || "")}${d.oli && d.oli !== d.oei ? "–" + esc(d.oli) : ""}
      · ${fmtAge(d.eag, d.lag)}</span><br/>
      <span style="color:#8a97aa">${d.noc || "?"} occurrence${+d.noc === 1 ? "" : "s"}${d.cc2 ? " · " + esc(d.cc2) : ""}</span>
    </div>`;
}

/* --------------------------------------------------------------- Helpers --- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtAge = (e, l) => (e == null ? "" : `${(+e).toFixed(1)}–${(+l).toFixed(1)} Ma`);

/* A little ⏳ button placed next to any displayed age range, to point the time
 * machine straight at that span (set in the wiring section, below). */
const tmIcon = (max, min) =>
  `<button type="button" class="tm-set" data-max="${max}" data-min="${min}"
     title="Set the time machine to ${fmtMa(max)}–${fmtMa(min)} Ma">⏳</button>`;

function setStatus(msg, cls = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + cls;
}

/* Persist small sets (e.g. which tree branches are expanded) across reloads. */
const loadSet = (key) => { try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch (e) { return new Set(); } };
const saveSet = (key, set) => { try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) { /* private mode */ } };

/* -------------------------------------------------------- Build controls --- */
function buildLegend() {
  buildCbMap();
  const ul = $("legend-list");
  ul.innerHTML = "";
  // Youngest at the top, like a stratigraphic column read from the surface down.
  for (const p of [...BANDS].sort((a, b) => a.min - b.min)) {
    const li = document.createElement("li");
    li.dataset.period = p.name;
    li.title = "Click to isolate this period on the globe";
    if (p.name === legendSel) li.classList.add("on");
    li.innerHTML = `<span class="swatch" style="background:${bandColor(p)}"></span>
      ${esc(p.name)}<span class="age">${fmtMa(p.max)}–${fmtMa(p.min)}</span>${tmIcon(p.max, p.min)}`;
    ul.appendChild(li);
  }
}

/* Interactive legend: clicking a period isolates points of that age on the globe
 * (dimming the rest), without re-querying PBDB. Click again to clear. */
let legendSel = null;
function pointPaint(d) {
  if (legendSel) {
    const b = bandFor(+d.eag || 0);
    if (!b || b.name !== legendSel) return "rgba(150,160,180,0.12)";
  }
  return d.color;
}
function setLegendFilter(name) {
  legendSel = legendSel === name ? null : name;
  buildLegend();
  globe.pointColor(globe.pointColor()); // re-trigger the colour accessor
}

/* ----------------------------------------------- Geological timescale --- */
/* Full ICS timescale (eons → eras → periods → epochs → ages), fetched live
 * from PBDB so the interval names line up exactly with what the API accepts.
 * Falls back to the built-in PERIODS list if we're offline. */
const LEVELS = ["eon", "era", "period", "epoch", "age"];
let INTERVALS = PERIODS.map((p) => // sensible offline default
  ({ name: p.name, type: "period", max: p.max, min: p.min, color: p.color }));
let selectedInterval = "";
let selectedRegion = "";          // PBDB cc code (continent or country); "" = whole world
let intervalRoots = [];           // top of the timescale tree (the eons)
let intById = new Map();          // interval id -> node
const expandedInts = new Set();   // ids of expanded tree nodes

/* Wire each interval to its parent so the picker can show a drill-down tree
 * (eon ▸ era ▸ period ▸ epoch ▸ age). */
function buildIntervalTree() {
  intById = new Map(INTERVALS.filter((it) => it.id != null).map((it) => [it.id, it]));
  INTERVALS.forEach((it) => (it.children = []));
  intervalRoots = [];
  for (const it of INTERVALS) {
    const parent = it.parent != null ? intById.get(it.parent) : null;
    if (parent) parent.children.push(it);
    else intervalRoots.push(it);
  }
  // Youngest-first within each parent, matching the legend's top-down reading.
  const bySort = (a, b) => a.min - b.min || a.max - b.max;
  intervalRoots.sort(bySort);
  INTERVALS.forEach((it) => it.children.sort(bySort));
  // Restore the branches expanded last session, else open to period level so the
  // common picks are visible by default.
  expandedInts.clear();
  const saved = loadSet(INT_STORE);
  if (saved.size) saved.forEach((id) => expandedInts.add(id));
  else INTERVALS.forEach((it) => { if (it.type === "eon" || it.type === "era") expandedInts.add(it.id); });
}
const INT_STORE = "pdmap.int.exp";
buildIntervalTree();

const fmtMa = (v) => v == null ? "?" :
  +v === 0 ? "0" :
  v >= 10 ? String(Math.round(v)) :
  v >= 1 ? (+v).toFixed(1) :
  v >= 0.01 ? (+v).toFixed(3) : (+v).toFixed(4);

buildLegend(); // draw the offline fallback legend immediately

/* -------------------------------------------------- Geologic timescale --- */
/* A horizontal Phanerozoic timescale along the bottom (à la PBDB Navigator):
 * each period is a proportionally-sized, colour-matched segment; clicking one
 * filters the whole query to that interval. Reflects the active interval. */
const TS_ABBR = { Quaternary: "Q", Neogene: "Ng", Paleogene: "Pg", Cretaceous: "K",
  Jurassic: "J", Triassic: "Tr", Permian: "P", Carboniferous: "C", Devonian: "D",
  Silurian: "S", Ordovician: "O", Cambrian: "Є" };
const tsAbbr = (name) => TS_ABBR[name] || name.slice(0, 2);

function buildTimescale() {
  const track = $("ts-track");
  if (!track) return;
  // Phanerozoic only — the Precambrian is ~8× longer and would crush the scale.
  const periods = BANDS.filter((b) => b.max <= 545 && b.max - b.min > 0)
    .slice().sort((a, b) => b.max - a.max); // oldest on the left, present on the right
  if (!periods.length) return;
  track.innerHTML = periods.map((p) => {
    const dur = p.max - p.min;
    return `<button type="button" class="ts-seg" data-period="${esc(p.name)}"
      style="flex:${dur} ${dur} 0;background:${bandColor(p)}"
      title="${esc(p.name)} · ${fmtMa(p.max)}–${fmtMa(p.min)} Ma — click to filter">
      <span class="ts-seg-lbl">${esc(tsAbbr(p.name))}</span></button>`;
  }).join("");
  $("timescale").classList.remove("hidden");
  updateTimescaleActive();
}

function updateTimescaleActive() {
  const track = $("ts-track");
  if (!track) return;
  track.querySelectorAll(".ts-seg").forEach((s) =>
    s.classList.toggle("on", s.dataset.period === selectedInterval));
  $("ts-clear").classList.toggle("hidden", !selectedInterval);
}

/* Clicking a period sets it as the interval filter (clearing any custom range,
 * which would otherwise override it) and re-runs the search; clicking the active
 * period again clears the filter. Mirrors choosing an interval in the picker. */
function filterToTimescale(name) {
  if (selectedInterval === name) {
    selectedInterval = ""; $("f-interval").value = ""; $("f-interval").title = "";
  } else {
    selectedInterval = name; $("f-interval").value = name;
    $("f-interval").title = intervalPath(name);
  }
  $("f-maxma").value = ""; $("f-minma").value = "";
  intHint();
  search();
}

$("ts-track").addEventListener("click", (e) => {
  const seg = e.target.closest(".ts-seg");
  if (seg) filterToTimescale(seg.dataset.period);
});
$("ts-clear").addEventListener("click", () => { if (selectedInterval) filterToTimescale(selectedInterval); });
buildTimescale(); // draw from the built-in periods immediately; refined once the live scale loads

async function loadTimescale() {
  try {
    const res = await fetch(`${PBDB}/intervals/list.json?scale=1&vocab=pbdb`);
    const recs = (await res.json()).records || [];
    if (!recs.length) return;
    INTERVALS = recs
      .filter((r) => LEVELS.includes(r.type))
      .map((r) => ({ id: r.interval_no, parent: r.parent_no, name: r.interval_name,
        type: r.type, max: +r.b_age, min: +r.t_age, color: r.color || "#9a8aa0" }));
    buildIntervalTree();
    // Colour points and the legend from every period now available, so anything
    // back to the Hadean gets its proper ICS colour instead of falling to grey.
    const periods = INTERVALS.filter((it) => it.type === "period");
    if (periods.length) { BANDS = periods; buildLegend(); buildTimescale(); recolorPoints(); }
  } catch (e) { /* offline — keep the built-in periods */ }
}

function recolorPoints() {
  const recs = globe.pointsData();
  if (!recs.length) return;
  for (const r of recs) r.color = colorForAge(+r.eag || 0);
  globe.pointColor(globe.pointColor()); // re-trigger the colour accessor
}

/* ---- searchable interval picker (reuses the .suggest combobox styling) ---- */
const intInput = $("f-interval");
const intBox = $("interval-suggest");
let intItems = [];
let intActive = -1;

const intRow = (it) =>
  `<div class="opt" data-val="${esc(it.name)}">
     <span class="nm">${esc(it.name)}</span>
     <span class="ct">${fmtMa(it.max)}–${fmtMa(it.min)} Ma</span>
     <span class="lvl">${esc(it.type)}</span>
   </div>`;

function intGrouped(list) {
  // Group rows by level in geological order, with a heading per level.
  return LEVELS.map((lvl) => {
    const rows = list.filter((it) => it.type === lvl);
    if (!rows.length) return "";
    const label = lvl === "epoch" ? "Epochs (sub-periods)" :
      lvl === "age" ? "Ages / stages" : lvl[0].toUpperCase() + lvl.slice(1) + "s";
    return `<div class="grp">${label}</div>` + rows.map(intRow).join("");
  }).join("");
}

/* Recursive tree rows for browsing the timescale by drilling down branches. */
function intTreeHtml(nodes, depth) {
  return nodes.map((n) => {
    const has = n.children && n.children.length;
    const open = expandedInts.has(n.id);
    const tw = has ? `<span class="tw">${open ? "▾" : "▸"}</span>` : `<span class="tw none"></span>`;
    const sel = n.name === selectedInterval ? " sel" : "";
    let html = `<div class="opt tnode${sel}" data-val="${esc(n.name)}" data-int="${esc(n.id)}" data-exp="${has ? 1 : 0}" style="padding-left:${6 + depth * 16}px">
      ${tw}<span class="swatch" style="background:${n.color}"></span>
      <span class="nm">${esc(n.name)}</span>
      <span class="ct">${fmtMa(n.max)}–${fmtMa(n.min)}</span>
      <span class="lvl">${esc(n.type)}</span>${PICK_BTN(n.name)}</div>`;
    if (has && open) html += intTreeHtml(n.children, depth + 1);
    return html;
  }).join("");
}

/* Open every ancestor of the named interval so a prior choice is visible. */
function expandAncestors(name) {
  let it = INTERVALS.find((x) => x.name === name);
  while (it && it.parent != null) {
    expandedInts.add(it.parent);
    it = intById.get(it.parent);
  }
}

function intSync() {
  intItems = [...intBox.querySelectorAll(".opt")].map((el) => el.dataset.val);
  intActive = -1;
}
function intShow() { intBox.classList.remove("hidden"); }
function intHide() { intBox.classList.add("hidden"); intActive = -1; }

const INT_HINT = `<div class="tree-hint">Click <b>▸</b> to open a branch · click a name to choose it</div>`;
const ANY_ROW = `<div class="opt tnode" data-val=""><span class="tw none"></span>
   <span class="nm">Any time</span><span class="lvl">all ages</span></div>`;

/* The browsable tree. scrollToSel centres the current pick (used when re-opening
 * the field); leave it off when just toggling a branch so the view stays put. */
function intRenderTree(scrollToSel) {
  if (selectedInterval) expandAncestors(selectedInterval);
  intBox.innerHTML = INT_HINT + ANY_ROW + intTreeHtml(intervalRoots, 0);
  intSync();
  intShow();
  if (scrollToSel) {
    const sel = intBox.querySelector(".opt.sel");
    if (sel) sel.scrollIntoView({ block: "center" });
  }
}

/* Flat, filtered results while the user is typing. */
function intRenderSearch(q) {
  const ql = q.trim().toLowerCase();
  const list = INTERVALS.filter((it) => it.name.toLowerCase().includes(ql));
  intBox.innerHTML = list.length ? intGrouped(list)
    : `<div class="grp">No interval matches “${esc(q)}”</div>`;
  intSync();
  intShow();
}

function intHint() {
  const it = INTERVALS.find((x) => x.name === selectedInterval);
  const el = $("interval-hint");
  el.textContent = it
    ? `${it.name} — ${it.type}, ${fmtMa(it.max)}–${fmtMa(it.min)} million years ago.`
    : "Any eon, era, period, epoch or age. Start typing to search, or leave blank for all of time.";
}

function intervalPath(name) {
  let it = INTERVALS.find((x) => x.name === name);
  const names = [];
  while (it) { names.unshift(it.name); it = it.parent != null ? intById.get(it.parent) : null; }
  return names.join(" › ");
}
function pickInterval(name) {
  selectedInterval = name;
  intInput.value = name;
  intInput.title = name ? intervalPath(name) : ""; // full-path tooltip
  // The time machine (and the custom range) write into f-maxma/f-minma, which
  // override any interval in search(). Picking an interval is an explicit choice
  // to use it, so clear that range — otherwise the period stays stuck on whatever
  // the time machine last set. Also halt any running sweep.
  $("f-maxma").value = ""; $("f-minma").value = "";
  if (typeof tmStop === "function") tmStop();
  intHide();
  intHint();
  search();
}
function intSetActive(i) {
  const opts = intBox.querySelectorAll(".opt");
  if (!opts.length) return;
  intActive = (i + opts.length) % opts.length;
  opts.forEach((el, n) => el.classList.toggle("active", n === intActive));
  opts[intActive].scrollIntoView({ block: "nearest" });
}

intInput.addEventListener("input", () => {
  // Typing invalidates a prior pick until they choose a real interval again.
  selectedInterval = "";
  const q = intInput.value.trim();
  q ? intRenderSearch(q) : intRenderTree(false);
});
// Re-opening the field always shows the tree, scrolled to the current pick, and
// closes any other open picker. A click reopens it after a pick, too.
intInput.addEventListener("focus", () => { closeOtherPickers(intHide); intRenderTree(true); });
intInput.addEventListener("click", () => {
  if (intBox.classList.contains("hidden")) { closeOtherPickers(intHide); intRenderTree(true); }
});
intInput.addEventListener("keydown", (e) => {
  if (intBox.classList.contains("hidden")) return;
  if (e.key === "ArrowDown") { e.preventDefault(); intSetActive(intActive + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); intSetActive(intActive - 1); }
  else if (e.key === "Enter" && intActive >= 0) { e.preventDefault(); pickInterval(intItems[intActive]); }
  else if (e.key === "Escape") { intHide(); }
});
intBox.addEventListener("mousedown", (e) => {
  e.stopPropagation(); // see note in the taxon picker — avoid a false outside-click on re-render
  const pick = e.target.closest("[data-pick]");
  if (pick) { e.preventDefault(); pickInterval(pick.closest(".opt").dataset.val); return; }
  const row = e.target.closest(".opt");
  if (!row) return;
  e.preventDefault();
  if (row.dataset.exp === "1" && row.dataset.int) { // click a branch row → expand/collapse
    const id = row.dataset.int;
    expandedInts.has(id) ? expandedInts.delete(id) : expandedInts.add(id);
    saveSet(INT_STORE, expandedInts);
    intRenderTree(false);
    const r2 = intBox.querySelector(`.opt[data-int="${CSS.escape(id)}"]`);
    if (r2) r2.scrollIntoView({ block: "nearest" }); // keep it where it was
    return;
  }
  pickInterval(row.dataset.val); // leaf / "Any time" → select
});
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#f-interval") && !e.target.closest("#interval-suggest")) intHide();
});

/* --------------------------------------------- Approximate viewport bbox --- */
function currentViewBbox() {
  const { lat, lng, altitude } = globe.pointOfView();
  // Half-angle of the visible spherical cap for a camera at (1+alt) radii.
  const half = Math.acos(1 / (1 + altitude)) * (180 / Math.PI);
  if (half >= 80) return null; // essentially whole globe -> search globally
  return {
    latmin: Math.max(-90, lat - half),
    latmax: Math.min(90, lat + half),
    lngmin: lng - half,
    lngmax: lng + half,
  };
}

/* --------------------------------------------------------------- Search --- */
let usePaleo = false;
let currentRecs = []; // the localities currently plotted (for stats, export, layers)

let currentTaxon = ""; // remembered so locality detail can float matches to the top
let lastFilterParams = "";  // filter-only query of the last search (reused by occurrence export)
let lastLimit = "2000";

/* Build the PBDB filter parameters (taxon + excludes, age/interval, formation,
 * environment, region, viewport) shared by the locality search and the
 * occurrence-level export, so an export always matches what's on the globe. */
function buildFilterParams() {
  const params = new URLSearchParams();
  const taxon = $("f-taxon").value.trim();
  if (taxon) {
    const ex = excludes.map((s) => "^" + s).join("");
    params.set("base_name", taxon + ex);
  }
  const formation = $("f-formation").value.trim();
  if (formation) params.set("formation", formation);
  const maxma = $("f-maxma").value.trim();
  const minma = $("f-minma").value.trim();
  const unit = $("f-unit").value;
  const toMa = (v) => unit === "yr" ? v / 1e6 : unit === "ka" ? v / 1e3 : v;
  if (maxma || minma) {
    if (maxma) params.set("max_ma", toMa(+maxma));
    if (minma) params.set("min_ma", toMa(+minma));
  } else if (selectedInterval) {
    params.set("interval", selectedInterval);
  }
  const env = $("f-env").value;
  if (env) params.set("envtype", env);
  if (selectedRegion) params.set("cc", selectedRegion); // continent or ISO-2 country code
  if ($("f-view").checked) {
    const b = currentViewBbox();
    if (b) {
      params.set("latmin", b.latmin.toFixed(3));
      params.set("latmax", b.latmax.toFixed(3));
      params.set("lngmin", b.lngmin.toFixed(3));
      params.set("lngmax", b.lngmax.toFixed(3));
    }
  }
  return params;
}

async function search() {
  const taxon = $("f-taxon").value.trim();
  const maxma = $("f-maxma").value.trim();
  const minma = $("f-minma").value.trim();
  const limit = $("f-limit").value;
  currentTaxon = taxon;
  updateTaxonInfo(taxon); // refresh the "about this taxon" card (best-effort, async)

  // Validate the custom range before going near the network. "Oldest" is the
  // larger number of millions of years; flag the two common mistakes clearly.
  if (maxma && minma) {
    const oldest = +maxma, youngest = +minma;
    if (youngest > oldest) {
      setStatus("“Oldest” must be a bigger number than “Youngest” — they look swapped.", "err");
      return;
    }
    if (youngest === oldest) {
      setStatus("“Oldest” and “Youngest” are the same — widen the range to see results.", "err");
      return;
    }
  }

  const params = buildFilterParams();
  // base_name carries both the included taxon and any excluded sub-groups, using
  // PBDB's "^" exclusion syntax (e.g. Dinosauria^Aves = dinosaurs sans birds);
  // the custom range / interval and viewport are also folded in by buildFilterParams.
  lastFilterParams = params.toString(); // filter-only snapshot for occurrence export
  lastLimit = limit;
  params.set("show", "loc,time,paleoloc");
  params.set("limit", limit);
  // Pin PBDB's paleo-coordinates to the Scotese (PALEOMAP) model so the plotted
  // fossils match the GPlates PALEOMAP coastlines we draw in ancient-Earth mode.
  params.set("pgm", "scotese");

  setStatus("Searching PBDB…", "busy");
  $("btn-search").disabled = true;
  try {
    const res = await fetch(`${PBDB}/colls/list.json?${params.toString()}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.join("; "));
    const recs = (json.records || []).filter((r) => r.lng != null && r.lat != null);

    const curR = radiusForAltitude(globe.pointOfView().altitude);
    for (const r of recs) {
      r.color = colorForAge(+r.eag || 0);
      r._mlat = +r.lat; r._mlng = +r.lng;
      r._plat = r.pla != null ? +r.pla : null;
      r._plng = r.pln != null ? +r.pln : null;
      r._r = curR;
    }
    applyCoords(recs);
    currentRecs = recs;
    applyLayerMode(); // points or density hexbins, per the toggle
    if (usePaleo) updatePaleoGlobe(); // refresh the reconstruction for the new age
    renderStats(recs);
    writeHash();
    updateTimescaleActive(); // reflect the active interval on the bottom strip

    const shown = recs.length;
    const noun = shown === 1 ? "locality" : "localities";
    const capped = shown >= +limit ? ` (capped at ${limit} — narrow your filters for more)` : "";
    setStatus(`${shown.toLocaleString()} ${noun}${capped}`, shown ? "" : "err");
    if (!shown) setStatus("No localities matched. Try a broader taxon or age.", "err");
    $("btn-download").disabled = !shown;
    $("f-export").disabled = !shown;
  } catch (e) {
    setStatus("Error: " + e.message, "err");
  } finally {
    $("btn-search").disabled = false;
  }
}

/* --------------------------------------------------------- Taxon info --- */
/* A compact "about this taxon" card for the searched group: silhouette, rank,
 * common name, authority, total occurrences and — most usefully — its
 * stratigraphic range (first/last appearance), with a ⏳ button to point the
 * time machine straight at that range. Mirrors PBDB's Taxon Info tool inline. */
let taxonInfoToken = 0;
async function updateTaxonInfo(name) {
  const box = $("taxon-info");
  if (!box) return;
  if (!name) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  const my = ++taxonInfoToken;
  box.classList.remove("hidden");
  box.innerHTML = `<div class="ti-head">About this taxon</div><div class="loading-row">Loading…</div>`;
  try {
    const res = await fetch(`${PBDB}/taxa/single.json?name=${encodeURIComponent(name)}&show=app,size,img,common`);
    const rec = ((await res.json()).records || [])[0];
    if (my !== taxonInfoToken) return; // a newer search superseded this one
    if (!rec) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    renderTaxonInfo(rec);
  } catch (e) {
    if (my === taxonInfoToken) { box.classList.add("hidden"); box.innerHTML = ""; }
  }
}

function renderTaxonInfo(r) {
  const box = $("taxon-info");
  const name = r.nam || currentTaxon;
  const imgId = r.img ? String(r.img).replace(/\D/g, "") : null;
  const txNo = String(r.oid || "").replace(/\D/g, "");
  const pbdb = txNo ? `https://paleobiodb.org/classic/basicTaxonInfo?taxon_no=${txNo}` : null;
  const extinct = String(r.ext) === "0";
  const sil = imgId
    ? `<img class="ti-sil" loading="lazy" alt="" src="${PBDB}/taxa/thumb.png?id=${imgId}"
         onerror="this.style.display='none'"/>`
    : "";

  // Stratigraphic range: oldest first-appearance (fea) → youngest last-appearance (lla).
  const oldest = +r.fea, youngest = +r.lla;
  let rangeHtml = "";
  if (!isNaN(oldest) && !isNaN(youngest) && oldest > 0) {
    const scale = Math.max(541, oldest);            // span the Phanerozoic, or older if needed
    const x = (a) => (1 - a / scale) * 100;          // old → left, present → right
    const l = x(oldest), w = Math.max(1.5, x(youngest) - l);
    const ivl = [r.tei, r.tli].filter(Boolean);
    const ivlTxt = ivl.length ? (ivl[0] === ivl[1] ? ivl[0] : `${ivl[0]} – ${ivl[1]}`) : "";
    rangeHtml = `
      <div class="ti-range-lbl">Stratigraphic range
        <button type="button" class="tm-set" data-max="${Math.round(oldest)}" data-min="${Math.round(youngest)}"
                title="Set the time machine to this range">⏳</button></div>
      <div class="ti-range"><span class="ti-range-fill" style="left:${l}%;width:${w}%"></span></div>
      <div class="ti-range-ends"><span>${fmtMa(oldest)} Ma</span><span>${fmtMa(youngest)} Ma</span></div>
      ${ivlTxt ? `<div class="ti-ivl">${esc(ivlTxt)}</div>` : ""}`;
  }

  box.innerHTML = `
    <div class="ti-head">About this taxon <span class="ti-src">PBDB</span></div>
    <div class="ti-main">
      ${sil}
      <div class="ti-body">
        <div class="ti-name">${esc(name)}<span class="ti-rank">${esc(RANK[r.rnk] || "")}</span></div>
        ${r.nm2 ? `<div class="ti-common">“${esc(r.nm2)}”</div>` : ""}
        <div class="ti-facts">
          ${r.att ? `<span title="Naming authority">${esc(r.att)}</span>` : ""}
          ${r.noc != null ? `<span><b>${(+r.noc).toLocaleString()}</b> occ.</span>` : ""}
          ${r.siz != null && +r.siz > 1 ? `<span><b>${(+r.siz).toLocaleString()}</b> subtaxa</span>` : ""}
          <span class="ti-tag ${extinct ? "ext" : "extant"}">${extinct ? "Extinct" : "Living members"}</span>
        </div>
      </div>
    </div>
    ${rangeHtml}
    ${pbdb ? `<div class="chips"><a class="chip" target="_blank" rel="noopener" href="${pbdb}">📄 PBDB taxon page</a></div>` : ""}`;
}

/* ------------------------------------------------------------- Export --- */
/* PBDB is CC-BY, so every export carries an attribution / citation line. */
const PBDB_CITE = "Data: Paleobiology Database (paleobiodb.org), CC-BY. " +
  "Continent reconstructions: GPlates / PALEOMAP (Scotese). Exported via PDMap.";

function exportFilename(ext) {
  return `pdmap-${(currentTaxon || "localities").replace(/\W+/g, "_").toLowerCase()}.${ext}`;
}
function saveBlob(text, type, name) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Dispatch to the chosen export format. */
function exportResults() {
  const recs = currentRecs;
  if (!recs.length) return;
  const fmt = $("f-export").value;
  if (fmt === "occ-csv") return exportOccurrencesCSV();
  if (fmt === "geojson") return exportGeoJSON(recs);
  if (fmt === "kml") return exportKML(recs);
  return exportCSV(recs);
}

/* Occurrence-level export — one row per fossil (not per locality), the form most
 * useful for analysis in R / Python / QGIS. Re-runs the current filters against
 * the occurrence endpoint (the globe plots collections, so the rows aren't held
 * locally) and writes taxonomy, age, modern & paleo coordinates, and the source
 * reference for every occurrence. */
async function exportOccurrencesCSV() {
  const btn = $("btn-download");
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "⬇ Fetching…";
  setStatus("Fetching occurrence-level records from PBDB…", "busy");
  try {
    const url = `${PBDB}/occs/list.json?${lastFilterParams}` +
      `&show=class,coords,paleoloc,loc,strat,time,ref&pgm=scotese&limit=${lastLimit}`;
    const json = await (await fetch(url)).json();
    if (json.errors) throw new Error(json.errors.join("; "));
    const occs = json.records || [];
    if (!occs.length) { setStatus("No occurrences to export for this query.", "err"); return; }
    const num = (v) => String(v == null ? "" : v).replace(/^\D+/, ""); // strip "occ:"/"col:" prefixes
    const cls = (v) => (v && !/^NO_|_SPECIFIED/.test(v)) ? v : "";
    const cols = [
      ["occurrence_no", (o) => num(o.oid)],
      ["collection_no", (o) => num(o.cid)],
      ["accepted_name", (o) => o.tna || ""],
      ["identified_name", (o) => o.idn || o.tna || ""],
      ["rank", (o) => RANK[o.rnk] || ""],
      ["phylum", (o) => cls(o.phl)],
      ["class", (o) => cls(o.cll)],
      ["order", (o) => cls(o.odl)],
      ["family", (o) => cls(o.fml)],
      ["genus", (o) => cls(o.gnl)],
      ["early_interval", (o) => o.oei || ""],
      ["late_interval", (o) => o.oli || o.oei || ""],
      ["max_ma", (o) => o.eag ?? ""],
      ["min_ma", (o) => o.lag ?? ""],
      ["lat", (o) => o.lat ?? ""],
      ["lng", (o) => o.lng ?? ""],
      ["paleolat", (o) => o.pla ?? ""],
      ["paleolng", (o) => o.pln ?? ""],
      ["formation", (o) => o.sfm || ""],
      ["country", (o) => o.cc2 || ""],
      ["state", (o) => o.stp || ""],
      ["reference", (o) => o.ref || ""],
    ];
    const cell = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [`# ${PBDB_CITE}`, cols.map((c) => c[0]).join(",")];
    for (const o of occs) rows.push(cols.map((c) => cell(c[1](o))).join(","));
    saveBlob(rows.join("\n"), "text/csv", exportFilename("occurrences.csv"));
    const capped = occs.length >= +lastLimit ? ` (capped at ${lastLimit})` : "";
    setStatus(`Exported ${occs.length.toLocaleString()} occurrences${capped}.`, "");
  } catch (e) {
    setStatus("Occurrence export failed: " + e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

/* Both modern and paleo coordinates are kept in every format. */
function exportGeoJSON(recs) {
  const fc = {
    type: "FeatureCollection",
    metadata: { source: PBDB_CITE, query: currentTaxon || null, count: recs.length },
    features: recs.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r._mlng, r._mlat] },
      properties: {
        collection_no: String(r.oid || "").replace(/\D/g, ""),
        name: r.nam || "", early_interval: r.oei || "", late_interval: r.oli || r.oei || "",
        max_ma: r.eag ?? null, min_ma: r.lag ?? null,
        paleolat: r._plat ?? null, paleolng: r._plng ?? null,
        formation: r.sfm || "", country: r.cc2 || "", occurrences: r.noc ?? null,
      },
    })),
  };
  saveBlob(JSON.stringify(fc, null, 2), "application/geo+json", exportFilename("geojson"));
}

function exportKML(recs) {
  const x = (s) => esc(s);
  const placemarks = recs.map((r) => `    <Placemark>
      <name>${x(r.nam || "Unnamed locality")}</name>
      <description>${x([r.oei, fmtAge(r.eag, r.lag), r.sfm, countryName(r.cc2),
        (r.noc != null ? r.noc + " occurrences" : "")].filter(Boolean).join(" · "))}</description>
      <Point><coordinates>${r._mlng},${r._mlat},0</coordinates></Point>
    </Placemark>`).join("\n");
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <name>PDMap — ${x(currentTaxon || "fossil localities")}</name>
    <description>${x(PBDB_CITE)}</description>
${placemarks}
  </Document></kml>`;
  saveBlob(kml, "application/vnd.google-earth.kml+xml", exportFilename("kml"));
}

/* Opens straight into Excel / Sheets, with both modern and paleo coordinates. */
function exportCSV(recs) {
  const cols = [
    ["collection_no", (r) => String(r.oid || "").replace(/\D/g, "")],
    ["name", (r) => r.nam || ""],
    ["early_interval", (r) => r.oei || ""],
    ["late_interval", (r) => r.oli || r.oei || ""],
    ["max_ma", (r) => r.eag ?? ""],
    ["min_ma", (r) => r.lag ?? ""],
    ["lat", (r) => r._mlat],
    ["lng", (r) => r._mlng],
    ["paleolat", (r) => r._plat ?? ""],
    ["paleolng", (r) => r._plng ?? ""],
    ["formation", (r) => r.sfm || ""],
    ["country", (r) => r.cc2 || ""],
    ["occurrences", (r) => r.noc ?? ""],
  ];
  const cell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [`# ${PBDB_CITE}`, cols.map((c) => c[0]).join(",")];
  for (const r of recs) rows.push(cols.map((c) => cell(c[1](r))).join(","));
  saveBlob(rows.join("\n"), "text/csv", exportFilename("csv"));
}

/* Switch the plotted coordinates between modern and paleo positions. */
function applyCoords(recs) {
  for (const r of recs) {
    if (usePaleo && r._plat != null) { r.plat = r._plat; r.plng = r._plng; }
    else { r.plat = r._mlat; r.plng = r._mlng; }
  }
}

/* ----------------------------------------------- Ancient Earth (paleo) --- */
/* With paleo-coordinates on, replace the modern globe with a reconstruction of
 * the continents at the relevant age, drawn from GPlates' coastline service so
 * the fossils sit on the world as it actually was. */
/* For 0–540 Ma we drape a real paleogeographic texture from the Scotese & Wright
 * (2018) PaleoDEM — land, mountains and, crucially, the shallow shelf seas that
 * flooded the continents, so sea level is shown rather than just coastlines.
 * Beyond that coverage we fall back to GPlates' reconstructed coastlines. */
const PALEO_DEM = "vendor/paleodem";
const PALEO_DEM_MAX = 540;        // covers 0–540 Ma at 5-Myr steps
const pad3 = (n) => String(n).padStart(3, "0");
const nearestDemAge = (age) => Math.min(PALEO_DEM_MAX, Math.max(0, Math.round(age / 5) * 5));

const GPLATES = "https://gws.gplates.org/reconstruct/coastlines/";
// Scotese PALEOMAP — the same model PBDB uses for its paleo-coordinates
// (pgm=scotese), so fossils sit on their true coastlines. Spans 0–750 Ma.
const PALEO_MODEL = "PALEOMAP";
const PALEO_MAX_MA = 750;
const paleoCache = new Map(); // rounded age (Ma) -> Promise<features|null>

globe.polygonGeoJsonGeometry((d) => d.geometry)
  .polygonAltitude(0.004)
  .polygonCapColor(() => "rgba(104, 116, 82, 0.95)")
  .polygonSideColor(() => "rgba(60, 66, 48, 0.5)")
  .polygonStrokeColor(() => "#2b3220")
  .polygonsTransitionDuration(0);

/* Density layer — aggregates localities into a lat/lng grid and draws each cell
 * as a sized, *numbered* marker, so you can read how many sites cluster where
 * (and click a cluster to zoom into it). The grid refines as you zoom in, and
 * the individual localities return once you're close enough. */
const DENSITY_STOPS = ["#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"]; // CVD-safe diverging
const densityColor = (n) => lerpStops(DENSITY_STOPS, Math.log10(Math.max(1, n)) / 3);
const DENSITY_CAP = 250;        // most clusters to label at once (keeps it readable)
let densityAlt = DEFAULT_ALT, densityMax = 1;

const densityOn = () => $("f-density").checked;
const DENSITY_POINTS_ALT = 0.6; // zoom in past this and clusters revert to pins
const densityCellDeg = (alt) => alt > 2 ? 12 : alt > 1.2 ? 8 : alt > 0.7 ? 5 : 3;
const fmtCount = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);

/* Aggregate the plotted localities into grid cells, by their current (modern or
 * paleo) coordinates, returning one weighted marker per populated cell. */
function gridBin(recs, cellDeg) {
  const cells = new Map();
  for (const r of recs) {
    if (r.plat == null || r.plng == null) continue;
    const gy = Math.floor((+r.plat + 90) / cellDeg), gx = Math.floor((+r.plng + 180) / cellDeg);
    const key = gx + ":" + gy;
    let c = cells.get(key);
    if (!c) { c = { n: 0, occ: 0, slat: 0, slng: 0 }; cells.set(key, c); }
    c.n++; c.occ += (+r.noc || 0); c.slat += +r.plat; c.slng += +r.plng;
  }
  return [...cells.values()].map((c) => ({ lat: c.slat / c.n, lng: c.slng / c.n, count: c.n, occ: c.occ }));
}

globe.labelLat((d) => d.lat).labelLng((d) => d.lng)
  .labelText((d) => fmtCount(d.count))
  .labelColor((d) => densityColor(d.count))
  .labelDotRadius((d) => radiusForAltitude(densityAlt) * (1.1 + Math.log10(d.count + 1) * 1.5))
  .labelSize((d) => radiusForAltitude(densityAlt) * (2.6 + Math.log10(d.count + 1) * 1.1))
  .labelResolution(2)
  .labelAltitude(0.013)
  .labelLabel((d) => `<div style="background:#0c1018;border:1px solid #283244;border-radius:8px;
      padding:6px 9px;font-size:12px;color:#e6ebf2;">
      <b>${d.count.toLocaleString()} localities</b><br/>
      <span style="color:#8a97aa">${Math.round(d.occ).toLocaleString()} occurrences · click to zoom in</span></div>`)
  .onLabelClick((d) => {
    globe.controls().autoRotate = false;
    // Always zoom IN from wherever we are now (never snap back out), down to a
    // close-but-safe floor — by then the cluster has split into smaller ones.
    const alt = globe.pointOfView().altitude;
    globe.pointOfView({ lat: d.lat, lng: d.lng, altitude: Math.max(0.05, alt * 0.45) }, 900);
  })
  .labelsTransitionDuration(0);

function renderDensity() {
  const alt = globe.pointOfView().altitude;
  densityAlt = alt;
  if (alt <= DENSITY_POINTS_ALT) {
    // Zoomed in close — drop the clusters and show the individual localities,
    // colour-coded by age (so the geological-time legend applies again).
    globe.labelsData([]);
    globe.pointsData(currentRecs);
    applyPointSize(alt);
    $("density-legend").classList.add("hidden");
    $("geo-legend").classList.remove("hidden");
    return;
  }
  globe.pointsData([]);
  $("geo-legend").classList.add("hidden");
  $("density-legend").classList.remove("hidden");
  let bins = gridBin(currentRecs, densityCellDeg(alt));
  bins.sort((a, b) => b.count - a.count);
  densityMax = bins.length ? bins[0].count : 1;
  const trimmed = bins.length > DENSITY_CAP;
  if (trimmed) bins = bins.slice(0, DENSITY_CAP);
  globe.labelsData(bins);
  buildDensityLegend(trimmed);
}
let densityTimer = null;
function scheduleDensity() {
  clearTimeout(densityTimer);
  densityTimer = setTimeout(() => { if (densityOn()) renderDensity(); }, 140);
}

function buildDensityLegend(trimmed) {
  const el = $("density-legend");
  el.innerHTML = `<h3>Cluster size (localities)</h3>
    <div class="dl-bar" style="background:linear-gradient(90deg,${DENSITY_STOPS.join(",")})"></div>
    <div class="dl-scale"><span>1</span><span>${densityMax.toLocaleString()}</span></div>
    ${trimmed ? `<small class="dl-note">Showing the densest ${DENSITY_CAP} clusters.</small>` : ""}
    <small class="dl-note">Click a cluster to zoom in; zoom in to split clusters apart.</small>`;
}

/* Switch between the per-locality point layer and the aggregated density layer. */
function applyLayerMode() {
  if (densityOn()) {
    renderDensity(); // chooses clusters vs pins by zoom, and toggles the legends
  } else {
    globe.labelsData([]);
    globe.pointsData(currentRecs);
    $("density-legend").classList.add("hidden");
    $("geo-legend").classList.remove("hidden");
  }
}

/* Age (Ma) to reconstruct to: midpoint of the custom range or selected interval,
 * else the median age of the plotted localities. */
function paleoAgeMa() {
  const maxma = $("f-maxma").value.trim();
  const minma = $("f-minma").value.trim();
  if (maxma || minma) {
    const unit = $("f-unit").value;
    const toMa = (v) => unit === "yr" ? v / 1e6 : unit === "ka" ? v / 1e3 : v;
    const hi = maxma ? toMa(+maxma) : toMa(+minma);
    const lo = minma ? toMa(+minma) : 0;
    return (hi + lo) / 2;
  }
  const it = INTERVALS.find((x) => x.name === selectedInterval);
  if (it) return (it.max + it.min) / 2;
  const ages = globe.pointsData().map((r) => +r.eag).filter((v) => !isNaN(v)).sort((a, b) => a - b);
  return ages.length ? ages[Math.floor(ages.length / 2)] : 0;
}

/* Keep the largest landmasses (ranked by vertex count) and drop the thousands of
 * tiny islets, so the reconstruction renders smoothly. */
function biggestFeatures(features, keep) {
  const verts = (g) => {
    if (!g) return 0;
    const rings = g.type === "MultiPolygon" ? g.coordinates.flat() : (g.coordinates || []);
    return rings.reduce((n, r) => n + r.length, 0);
  };
  return features
    .map((f) => [verts(f.geometry), f])
    .sort((a, b) => b[0] - a[0])
    .slice(0, keep)
    .map((x) => x[1]);
}

function fetchPaleoCoastlines(age) {
  const key = Math.round(age);
  if (paleoCache.has(key)) return paleoCache.get(key);
  const p = fetch(`${GPLATES}?time=${key}&model=${PALEO_MODEL}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.features ? biggestFeatures(d.features, 350) : null))
    .catch(() => null);
  paleoCache.set(key, p);
  return p;
}

let paleoToken = 0;
// Tint the globe surface, tolerating the brief window after a texture swap when
// the material (or its colour) hasn't been recreated yet.
function setGlobeColor(hex) {
  const m = globe.globeMaterial();
  if (m && m.color) m.color.set(hex);
}
async function updatePaleoGlobe() {
  const note = $("paleo-note");
  if (!usePaleo) {
    globe.polygonsData([]);
    setGlobeColor(0xffffff); // stop tinting the restored texture
    setBaseLayer($("f-base").value);
    note.classList.add("hidden");
    return;
  }
  const myToken = ++paleoToken;
  const age = paleoAgeMa();
  note.classList.remove("hidden");

  // 0–540 Ma: drape the PaleoDEM paleogeography texture (shows shelf seas).
  if (age <= PALEO_DEM_MAX) {
    const a = nearestDemAge(age);
    globe.polygonsData([]);
    if (a === 0) {
      // The youngest slice is essentially today's geography — use the crisp
      // high-resolution base map instead of the soft 1° PaleoDEM (e.g. for the
      // Quaternary), which is both sharper and accurate for ~0 Ma.
      setGlobeColor(0xffffff);
      setBaseLayer($("f-base").value);
      note.textContent = `Ancient Earth ~0 Ma · essentially modern geography (high-resolution base map).`;
      return;
    }
    globe.globeTileEngineUrl(null).bumpImageUrl(null);
    globe.globeImageUrl(`${PALEO_DEM}/${pad3(a)}.jpg`);
    setGlobeColor(0xffffff);     // the texture supplies the colour
    _aniTries = 0; tryAnisotropy(); // sharpen the draped texture (max anisotropy)
    note.textContent = `Ancient Earth ~${fmtMa(a)} Ma · paleogeography with shallow shelf seas & flooded `
      + `continents (Scotese & Wright 2018 PaleoDEM, CC-BY).`;
    return;
  }

  // Older than the PaleoDEM: reconstructed coastlines only (no sea-level model).
  const clamped = Math.min(PALEO_MAX_MA, age);
  globe.globeTileEngineUrl(null).globeImageUrl(null).bumpImageUrl(null);
  setGlobeColor(0x12354f);
  note.textContent = `Reconstructing continents ~${fmtMa(clamped)} Ma…`;
  const feats = await fetchPaleoCoastlines(clamped);
  if (myToken !== paleoToken) return; // a newer request superseded this one
  if (feats) {
    globe.polygonsData(feats);
    note.textContent = `Ancient Earth ~${fmtMa(clamped)} Ma · ${feats.length} landmasses (GPlates ${PALEO_MODEL}). `
      + `Coastlines only — the sea-level (PaleoDEM) model doesn't reach beyond ${PALEO_DEM_MAX} Ma.`;
  } else {
    globe.polygonsData([]);
    note.textContent = age > PALEO_MAX_MA
      ? `No continent reconstruction beyond ${PALEO_MAX_MA} Ma — plotting paleo-coordinates only.`
      : "Couldn't load the paleogeographic map — plotting paleo-coordinates only.";
  }
}

/* -------------------------------------------------- Locality detail view --- */
let openToken = 0;
async function openLocality(d) {
  const panel = $("detail");
  const body = $("detail-body");
  panel.classList.remove("hidden");
  $("timescale").classList.add("detail-open"); // make room so the panel doesn't cover the strip
  const myToken = ++openToken;

  const collNo = String(d.oid || "").replace(/\D/g, "");
  const place = [d.stp, countryName(d.cc2)].filter(Boolean).join(", ");
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${d._mlat},${d._mlng}`;

  body.innerHTML = `
    <h2>${esc(d.nam || "Unnamed locality")}</h2>
    <div class="chips">
      <span class="chip age" style="border-color:${d.color};color:${d.color}">
        ${esc(d.oei || "")}${d.oli && d.oli !== d.oei ? "–" + esc(d.oli) : ""}</span>
      <span class="chip">${fmtAge(d.eag, d.lag)}${d.eag != null ? tmIcon(+d.eag, +d.lag) : ""}</span>
    </div>
    <div class="meta">
      ${d.sfm ? `<b>Formation:</b> ${esc(d.sfm)}<br/>` : ""}
      ${place ? `<b>Location:</b> ${esc(place)}<br/>` : ""}
      <b>Coordinates:</b> ${d._mlat.toFixed(3)}, ${d._mlng.toFixed(3)}
      ${d._plat != null ? `<br/><b>Paleo-coords (then):</b> ${d._plat.toFixed(1)}, ${d._plng.toFixed(1)}` : ""}
      ${d.env ? `<br/><b>Environment:</b> ${esc(d.env)}` : ""}
    </div>
    <div class="chips">
      <a class="chip" target="_blank" rel="noopener" href="${mapsHref}">📍 Google Maps</a>
      <a class="chip" target="_blank" rel="noopener"
         href="${PBDB}/colls/single.json?id=${d.oid}&show=loc,time,strat,refs">📄 PBDB record</a>
    </div>
    <div id="loc-ref" class="locref"></div>
    <div id="macro-context" class="macro"></div>
    <div class="taxa-head"><h3>Fossils found here</h3><span class="count" id="taxa-count"></span></div>
    <div id="taxa-list"><div class="loading-row">Loading taxa…</div></div>`;

  fetchReference(collNo, myToken); // the publication this collection was recorded from
  fetchMacro(d, myToken); // bedrock / formation context from Macrostrat (best-effort)

  try {
    // Fetch every taxon here, and (if a taxon was searched) the subset that
    // belongs to that clade — so we can float the relevant ones to the top.
    const all = fetch(`${PBDB}/occs/list.json?coll_id=${collNo}&show=class,img&limit=500`)
      .then((r) => r.json());
    const rel = currentTaxon
      ? fetch(`${PBDB}/occs/list.json?coll_id=${collNo}&base_name=${encodeURIComponent(currentTaxon)}&limit=500`)
          .then((r) => r.json()).catch(() => null)
      : Promise.resolve(null);
    const [allJson, relJson] = await Promise.all([all, rel]);
    const relevant = new Set(
      ((relJson && relJson.records) || []).map((o) => o.tna || o.idn).filter(Boolean));
    renderTaxa(allJson.records || [], relevant);
  } catch (e) {
    $("taxa-list").innerHTML = `<div class="loading-row">Could not load taxa: ${esc(e.message)}</div>`;
  }
}

/* Macrostrat geological context — the bedrock map unit(s) at the locality, with
 * lithology and stratigraphic name. CORS-enabled, no key; best-effort only. */
const MACRO = "https://macrostrat.org/api/v2/geologic_units/map";
async function fetchMacro(d, token) {
  const box = $("macro-context");
  if (!box) return;
  box.innerHTML = `<div class="macro-head">Bedrock context</div><div class="loading-row">Looking up geology…</div>`;
  try {
    const res = await fetch(`${MACRO}?lat=${d._mlat}&lng=${d._mlng}`);
    const data = (await res.json())?.success?.data || [];
    if (token !== openToken) return; // a newer locality was opened
    if (!data.length) { box.innerHTML = ""; return; }
    const u = data[0]; // most-specific unit Macrostrat returns first
    const lith = (u.lith || "").split(/[,;]/).slice(0, 3).map((s) => s.trim()).filter(Boolean).join(", ");
    const span = [u.b_int, u.t_int].filter(Boolean);
    const age = span.length ? (span[0] === span[1] ? span[0] : `${span[0]} – ${span[1]}`) : "";
    const rows = [
      u.strat_name && ["Unit", u.strat_name],
      u.name && u.name !== u.strat_name && ["Map unit", u.name],
      lith && ["Lithology", lith],
      age && ["Age", age],
    ].filter(Boolean);
    box.innerHTML = `<div class="macro-head">Bedrock context <span class="macro-src">Macrostrat</span></div>
      ${rows.map(([k, v]) => `<div class="macro-row"><b>${esc(k)}:</b> ${esc(v)}</div>`).join("")}`;
  } catch (e) {
    if (token === openToken && box) box.innerHTML = ""; // silent on failure
  }
}

/* Primary bibliographic reference — the publication this collection's data was
 * recorded from. PBDB is CC-BY, so crediting the source matters; we fetch the
 * formatted citation and link to the full reference record on PBDB. */
async function fetchReference(collNo, token) {
  const box = $("loc-ref");
  if (!box || !collNo) return;
  box.innerHTML = `<div class="locref-head">Reference</div><div class="loading-row">Looking up the source…</div>`;
  try {
    const res = await fetch(`${PBDB}/colls/single.json?id=${collNo}&show=ref`);
    const rec = ((await res.json()).records || [])[0];
    if (token !== openToken) return; // a newer locality was opened
    if (!rec || !rec.ref) { box.innerHTML = ""; return; }
    const refNo = String(rec.rid || "").replace(/\D/g, "");
    const pbdbRef = refNo ? `https://paleobiodb.org/classic/displayReference?reference_no=${refNo}` : null;
    const scholar = `https://scholar.google.com/scholar?q=${encodeURIComponent(rec.ref.replace(/\s+/g, " ").slice(0, 200))}`;
    box.innerHTML = `<div class="locref-head">Reference <span class="locref-src">PBDB · CC-BY</span></div>
      <div class="locref-cite">${esc(rec.ref)}</div>
      <div class="chips">
        ${pbdbRef ? `<a class="chip" target="_blank" rel="noopener" href="${pbdbRef}">📚 Full reference</a>` : ""}
        <a class="chip" target="_blank" rel="noopener" href="${scholar}">🔍 Google Scholar</a>
      </div>`;
  } catch (e) {
    if (token === openToken && box) box.innerHTML = ""; // silent on failure
  }
}

function renderTaxa(occs, relevant = new Set()) {
  // De-duplicate by accepted taxon name, keep the best image we see.
  const seen = new Map();
  for (const o of occs) {
    const name = o.tna || o.idn;
    if (!name) continue;
    if (!seen.has(name)) seen.set(name, o);
    else if (!seen.get(name).img && o.img) seen.set(name, o);
  }
  // Taxa within the searched clade first, then everything else; each alphabetical.
  const isRel = (o) => relevant.has(o.tna || o.idn);
  const list = [...seen.values()].sort((a, b) =>
    (isRel(b) - isRel(a)) || (a.tna || "").localeCompare(b.tna || ""));
  $("taxa-count").textContent = `${list.length} taxa`;

  const cap = 80;
  const html = list.slice(0, cap).map((o) => taxonCard(o, isRel(o))).join("");
  const more = list.length > cap ? `<div class="loading-row">…and ${list.length - cap} more</div>` : "";
  $("taxa-list").innerHTML = html + more || `<div class="loading-row">No taxa recorded.</div>`;
  enrichTaxa();
}

/* --- Wikipedia enrichment: lazily add a real photo + description per taxon ---
 * Wikipedia's REST summary API is CORS-enabled and returns a thumbnail and a
 * short extract. We fetch only for cards scrolled into view, to stay light. */
const wikiCache = new Map();
function fetchWiki(name) {
  if (wikiCache.has(name)) return wikiCache.get(name);
  const p = fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.type === "standard")
      ? { thumb: d.thumbnail && d.thumbnail.source, extract: d.extract,
          url: d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page }
      : null)
    .catch(() => null);
  wikiCache.set(name, p);
  return p;
}

let enrichToken = 0;
async function enrichTaxa() {
  const myToken = ++enrichToken; // cancel enrichment if a new locality is opened
  const cards = [...document.querySelectorAll(".taxon")];
  let i = 0;
  const worker = async () => {
    while (i < cards.length && myToken === enrichToken) await enrichCard(cards[i++]);
  };
  await Promise.all(Array.from({ length: 5 }, worker)); // up to 5 concurrent fetches
}

async function enrichCard(card) {
  const name = card.dataset.wiki;
  if (!name) return;
  const info = await fetchWiki(name);
  if (!info) return;
  if (info.thumb) {
    const thumb = card.querySelector(".tx-thumb");
    if (thumb) thumb.innerHTML =
      `<a href="${esc(info.url || "#")}" target="_blank" rel="noopener" title="View on Wikipedia">
         <img class="photo" loading="lazy" alt="${esc(name)}" src="${esc(info.thumb)}"/></a>`;
  }
  if (info.extract) {
    const d = card.querySelector(".tx-desc");
    if (d) d.textContent = info.extract;
  }
}

const RANK = { 2: "subspecies", 3: "species", 4: "subgenus", 5: "genus", 6: "subtribe",
  7: "tribe", 8: "subfamily", 9: "family", 10: "superfamily", 11: "infraorder",
  12: "suborder", 13: "order", 14: "superorder", 15: "infraclass", 16: "subclass",
  17: "class", 18: "superclass", 19: "subphylum", 20: "phylum", 21: "superphylum",
  22: "subkingdom", 23: "kingdom", 25: "unranked clade" };

function taxonCard(o, isMatch = false) {
  const name = o.tna || o.idn;
  const txNo = String(o.tid || "").replace(/\D/g, "");
  const imgId = o.img ? String(o.img).replace(/\D/g, "") : null;
  const cls = [o.phl, o.cll, o.fml].filter((x) => x && !/NO_.*_SPECIFIED|NO_ORDER/.test(x)).join(" › ");

  const wiki = `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, "_"))}`;
  const imgFossil = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(name + " fossil")}`;
  const imgArt = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(name + " paleoart")}`;
  const pbdb = txNo ? `https://paleobiodb.org/classic/basicTaxonInfo?taxon_no=${txNo}` : null;

  const sil = imgId
    ? `<img class="silhouette" loading="lazy" alt="" src="${PBDB}/taxa/thumb.png?id=${imgId}"
         onerror="this.classList.add('empty');this.removeAttribute('src');this.textContent='🦴'"/>`
    : `<div class="silhouette empty">🦴</div>`;

  return `<div class="taxon${isMatch ? " match" : ""}" data-wiki="${esc(name)}">
    <div class="tx-thumb">${sil}</div>
    <div class="tx-body">
      <div class="tx-name">${esc(name)}<span class="tx-rank">${RANK[o.rnk] || ""}</span></div>
      ${cls ? `<div class="tx-class">${esc(cls)}</div>` : ""}
      <div class="tx-desc"></div>
      <div class="tx-links">
        <a target="_blank" rel="noopener" href="${wiki}">Wikipedia</a>
        <a target="_blank" rel="noopener" href="${imgFossil}">Fossil images</a>
        <a target="_blank" rel="noopener" href="${imgArt}">Paleoart</a>
        ${pbdb ? `<a target="_blank" rel="noopener" href="${pbdb}">PBDB</a>` : ""}
      </div>
    </div>
  </div>`;
}

/* Country-code → readable name for every code PBDB returns (also the source for
 * the Region filter's country list). Codes follow PBDB's table (config.json?show=
 * countries), which is ISO-3166-1 alpha-2 except UK (not GB) and FA (not FK).
 * A few names are shortened to their everyday form (USA, UK). */
const COUNTRIES = {
  AF: "Afghanistan", AX: "Åland Islands", AL: "Albania", DZ: "Algeria", AS: "American Samoa",
  AD: "Andorra", AO: "Angola", AI: "Anguilla", AQ: "Antarctica", AG: "Antigua & Barbuda",
  AR: "Argentina", AM: "Armenia", AW: "Aruba", AU: "Australia", AT: "Austria", AZ: "Azerbaijan",
  BS: "Bahamas", BH: "Bahrain", BD: "Bangladesh", BB: "Barbados", BY: "Belarus", BE: "Belgium",
  BZ: "Belize", BJ: "Benin", BM: "Bermuda", BT: "Bhutan", BO: "Bolivia", BA: "Bosnia & Herzegovina",
  BW: "Botswana", BV: "Bouvet Island", BR: "Brazil", IO: "British Indian Ocean Territory",
  BN: "Brunei", BG: "Bulgaria", BF: "Burkina Faso", BI: "Burundi", CV: "Cabo Verde", KH: "Cambodia",
  CM: "Cameroon", CA: "Canada", KY: "Cayman Islands", CF: "Central African Republic", TD: "Chad",
  CL: "Chile", CN: "China", CX: "Christmas Island", CC: "Cocos (Keeling) Islands", CO: "Colombia",
  KM: "Comoros", CG: "Congo", CD: "Congo (DRC)", CK: "Cook Islands", CR: "Costa Rica",
  CI: "Côte d’Ivoire", HR: "Croatia", CU: "Cuba", CW: "Curaçao", CY: "Cyprus", CZ: "Czechia",
  DK: "Denmark", DJ: "Djibouti", DM: "Dominica", DO: "Dominican Republic", EC: "Ecuador",
  EG: "Egypt", SV: "El Salvador", GQ: "Equatorial Guinea", ER: "Eritrea", EE: "Estonia",
  SZ: "Eswatini", ET: "Ethiopia", FA: "Falkland Islands", FO: "Faroe Islands", FJ: "Fiji",
  FI: "Finland", FR: "France", GF: "French Guiana", PF: "French Polynesia",
  TF: "French Southern Territories", GA: "Gabon", GM: "Gambia", GE: "Georgia", DE: "Germany",
  GH: "Ghana", GI: "Gibraltar", GR: "Greece", GL: "Greenland", GD: "Grenada", GP: "Guadeloupe",
  GU: "Guam", GT: "Guatemala", GG: "Guernsey", GN: "Guinea", GW: "Guinea-Bissau", GY: "Guyana",
  HT: "Haiti", HM: "Heard & McDonald Islands", VA: "Vatican City", HN: "Honduras", HK: "Hong Kong",
  HU: "Hungary", IS: "Iceland", IN: "India", ID: "Indonesia", IR: "Iran", IQ: "Iraq", IE: "Ireland",
  IM: "Isle of Man", IL: "Israel", IT: "Italy", JM: "Jamaica", JP: "Japan", JE: "Jersey",
  JO: "Jordan", KZ: "Kazakhstan", KE: "Kenya", KI: "Kiribati", KP: "North Korea", KR: "South Korea",
  KW: "Kuwait", KG: "Kyrgyzstan", LA: "Laos", LV: "Latvia", LB: "Lebanon", LS: "Lesotho",
  LR: "Liberia", LY: "Libya", LI: "Liechtenstein", LT: "Lithuania", LU: "Luxembourg", MO: "Macau",
  MG: "Madagascar", MW: "Malawi", MY: "Malaysia", MV: "Maldives", ML: "Mali", MT: "Malta",
  MH: "Marshall Islands", MQ: "Martinique", MR: "Mauritania", MU: "Mauritius", YT: "Mayotte",
  MX: "Mexico", FM: "Micronesia", MD: "Moldova", MC: "Monaco", MN: "Mongolia", ME: "Montenegro",
  MS: "Montserrat", MA: "Morocco", MZ: "Mozambique", MM: "Myanmar", NA: "Namibia", NR: "Nauru",
  NP: "Nepal", NL: "Netherlands", NC: "New Caledonia", NZ: "New Zealand", NI: "Nicaragua",
  NE: "Niger", NG: "Nigeria", NU: "Niue", NF: "Norfolk Island", MK: "North Macedonia",
  MP: "Northern Mariana Islands", NO: "Norway", OM: "Oman", PK: "Pakistan", PW: "Palau",
  PS: "Palestine", PA: "Panama", PG: "Papua New Guinea", PY: "Paraguay", PE: "Peru",
  PH: "Philippines", PN: "Pitcairn Islands", PL: "Poland", PT: "Portugal", PR: "Puerto Rico",
  QA: "Qatar", RE: "Réunion", RO: "Romania", RU: "Russia", RW: "Rwanda", BL: "St Barthélemy",
  SH: "St Helena", KN: "St Kitts & Nevis", LC: "St Lucia", MF: "St Martin",
  PM: "St Pierre & Miquelon", VC: "St Vincent & Grenadines", WS: "Samoa", SM: "San Marino",
  ST: "São Tomé & Príncipe", SA: "Saudi Arabia", SN: "Senegal", RS: "Serbia", SC: "Seychelles",
  SL: "Sierra Leone", SG: "Singapore", SX: "Sint Maarten", SK: "Slovakia", SI: "Slovenia",
  SB: "Solomon Islands", SO: "Somalia", ZA: "South Africa", GS: "South Georgia",
  SS: "South Sudan", ES: "Spain", LK: "Sri Lanka", SD: "Sudan", SR: "Suriname",
  SJ: "Svalbard & Jan Mayen", SE: "Sweden", CH: "Switzerland", SY: "Syria", TW: "Taiwan",
  TJ: "Tajikistan", TZ: "Tanzania", TH: "Thailand", TL: "Timor-Leste", TG: "Togo", TK: "Tokelau",
  TO: "Tonga", TT: "Trinidad & Tobago", TN: "Tunisia", TR: "Türkiye", TM: "Turkmenistan",
  TC: "Turks & Caicos Islands", TV: "Tuvalu", UG: "Uganda", UA: "Ukraine",
  AE: "United Arab Emirates", UK: "UK", US: "USA", UM: "US Minor Outlying Islands",
  BQ: "Bonaire",
  UY: "Uruguay", UZ: "Uzbekistan", VU: "Vanuatu", VE: "Venezuela", VN: "Vietnam",
  VG: "British Virgin Islands", VI: "US Virgin Islands", WF: "Wallis & Futuna",
  EH: "Western Sahara", YE: "Yemen", ZM: "Zambia", ZW: "Zimbabwe" };
const countryName = (cc) => COUNTRIES[cc] || cc || "";

/* PBDB's own continent codes (config.json?show=continents) — used by the Region
 * filter alongside the country codes above; both go to PBDB's cc param. */
const PBDB_REGIONS = [
  { code: "AFR", name: "Africa" },
  { code: "ASI", name: "Asia" },
  { code: "EUR", name: "Europe" },
  { code: "NOA", name: "North America" },
  { code: "SOA", name: "South America" },
  { code: "AUS", name: "Australia" },
  { code: "ATA", name: "Antarctica" },
  { code: "OCE", name: "Oceania (Pacific islands)" },
  { code: "IOC", name: "Indian Ocean territories" },
];

/* PBDB's open-ocean basin codes (config.json?show=countries, codes O1–O7) — real
 * marine regions, distinct from the land groupings above. These let you filter to
 * the deep sea, which the continent codes don't cover. */
const OCEANS = [
  { code: "O1", name: "Arctic Ocean" },
  { code: "O2", name: "North Atlantic" },
  { code: "O3", name: "South Atlantic" },
  { code: "O4", name: "North Pacific" },
  { code: "O5", name: "South Pacific" },
  { code: "O6", name: "Indian Ocean" },
  { code: "O7", name: "Southern Ocean" },
];

/* Which countries sit under each PBDB region, so the Region picker can be browsed
 * as a tree (continent ▸ its countries) instead of one long alphabetical list.
 * Grouping is only for browsing — the value sent to PBDB is always the code below.
 * Codes follow PBDB's table, which mostly matches ISO-3166-1 but uses UK (not GB)
 * and FA (not FK). */
const REGION_MEMBERS = {
  AFR: "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW SH",
  ASI: "AF AM AZ BH BD BT BN KH CN GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP KR OM PK PS PH QA SA SG LK SY TW TJ TH TL TR TM AE UZ VN YE",
  EUR: "AX AL AD AT BY BE BA BG HR CY CZ DK EE FO FI FR DE GI GR GG HU IS IE IM IT JE LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SJ SE CH UA UK VA",
  NOA: "AI AG AW BS BB BZ BM VG CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA PR BL KN LC MF PM VC SX TT TC US VI BQ",
  SOA: "AR BO BR CL CO EC FA GF GY PE PY SR UY VE",
  AUS: "AU",
  ATA: "AQ BV HM TF GS",
  OCE: "AS CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV UM VU WF",
  IOC: "IO CX CC",
};

/* Browsable tree: each PBDB region node carries its member countries (A–Z), then
 * the open oceans as their own branch. Any country not bucketed above falls into a
 * catch-all so nothing is unreachable. */
const REGION_TREE = (function buildRegionTree() {
  const assigned = new Set();
  const tree = PBDB_REGIONS.map((r) => {
    const codes = (REGION_MEMBERS[r.code] || "").split(/\s+/).filter(Boolean);
    const children = codes.filter((c) => COUNTRIES[c]).map((c) => {
      assigned.add(c);
      return { code: c, name: COUNTRIES[c] };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { code: r.code, name: r.name, children };
  });
  const leftover = Object.keys(COUNTRIES).filter((c) => !assigned.has(c))
    .map((c) => ({ code: c, name: COUNTRIES[c] })).sort((a, b) => a.name.localeCompare(b.name));
  if (leftover.length) tree.push({ code: "", name: "Other territories", children: leftover });
  // Open oceans: a non-selectable header whose children are the selectable basins.
  tree.push({ code: "", name: "Oceans (open water)", children: OCEANS.map((o) => ({ ...o, tag: "ocean" })) });
  return tree;
})();

/* code → human label, covering region, ocean and every country code. */
const REGION_LABEL = (function () {
  const m = {};
  for (const r of PBDB_REGIONS) m[r.code] = r.name;
  for (const o of OCEANS) m[o.code] = o.name;
  for (const [c, n] of Object.entries(COUNTRIES)) m[c] = n;
  return m;
})();

/* Extra search terms so a country is found by names other than its short label —
 * e.g. "Britain" or "United Kingdom" both find UK, "Turkey" finds Türkiye. */
const REGION_ALIASES = {
  UK: "united kingdom britain great britain england scotland wales",
  US: "united states of america", RU: "russian federation", CZ: "czech republic",
  TR: "turkey", SZ: "swaziland", MM: "burma", CI: "ivory coast", MK: "macedonia",
  CD: "democratic republic of the congo drc zaire", CG: "republic of the congo",
  CV: "cape verde", TL: "east timor", VA: "holy see vatican", FA: "falklands malvinas",
  KP: "north korea dprk", KR: "south korea", LA: "lao", SY: "syrian arab republic",
  BQ: "caribbean netherlands sint eustatius saba", NL: "holland",
};
const regionLabel = (code) => REGION_LABEL[code] || code || "";

/* ----------------------------------------------- Taxon autocomplete --- */
const POPULAR = [
  { group: "Dinosaurs", items: ["Dinosauria", "Theropoda", "Sauropoda", "Ceratopsia",
    "Tyrannosaurus", "Triceratops", "Velociraptor", "Stegosaurus"] },
  { group: "Other prehistoric reptiles", items: ["Pterosauria", "Plesiosauria",
    "Ichthyosauria", "Mosasauria", "Pseudosuchia"] },
  { group: "Mammals", items: ["Mammalia", "Proboscidea", "Mammuthus", "Smilodon",
    "Cetacea", "Primates", "Equidae"] },
  { group: "Invertebrates", items: ["Trilobita", "Ammonoidea", "Brachiopoda",
    "Crinoidea", "Bivalvia", "Gastropoda", "Anthozoa"] },
  { group: "Plants & microfossils", items: ["Plantae", "Coniferophyta", "Foraminifera"] },
  { group: "Broad groups", items: ["Vertebrata", "Reptilia", "Aves", "Amphibia",
    "Chondrichthyes", "Insecta"] },
];

const optRow = (name, rank, count) =>
  `<div class="opt" data-val="${esc(name)}">
     <span class="nm">${esc(name)}</span>
     ${rank ? `<span class="rk">${esc(rank)}</span>` : ""}
     ${count ? `<span class="ct">${count}</span>` : ""}
   </div>`;

const PICK_BTN = (name) => `<button type="button" class="pick" data-pick title="Search ${esc(name)}">use ›</button>`;
const TAX_HINT = `<div class="tree-hint">Click a row to open it · click <b>use ›</b> to choose</div>`;

function freshTaxRoots() {
  return POPULAR.map((g) => ({
    group: g.group,
    nodes: g.items.map((name) => ({ name, children: null, expanded: false, loading: false })),
  }));
}

/* A registry of every picker's hide(), so opening one closes the others — never
 * two trees on screen at once. Plus tiny localStorage helpers for remembering
 * which branches were expanded, across reloads. */
const pickerHides = [];
const closeOtherPickers = (except) => pickerHides.forEach((h) => h !== except && h());

/* Full classification path for a taxon, for the field's hover tooltip. */
const lineageCache = new Map();
function taxonLineage(name) {
  if (lineageCache.has(name)) return lineageCache.get(name);
  const p = fetch(`${PBDB}/taxa/list.json?name=${encodeURIComponent(name)}&rel=all_parents&status=accepted`)
    .then((r) => r.json()).then((d) => (d.records || []).map((r) => r.nam).filter(Boolean).join(" › "))
    .catch(() => "");
  lineageCache.set(name, p);
  return p;
}

/* Children of a taxon, fetched once and shared between every picker. */
const taxChildCache = new Map();
function fetchTaxonChildren(node) {
  const key = node.oid ? `id:${node.oid}` : `nm:${node.name}`;
  if (taxChildCache.has(key)) return taxChildCache.get(key);
  const sel = node.oid ? `id=${String(node.oid).replace(/\D/g, "")}`
                       : `name=${encodeURIComponent(node.name)}`;
  const p = fetch(`${PBDB}/taxa/list.json?${sel}&rel=children&status=accepted&show=size`)
    .then((r) => r.json())
    .then((d) => (d.records || [])
      .map((r) => ({ name: r.nam, oid: r.oid, rnk: RANK[+r.rnk] || "", noc: +r.noc || 0,
        children: null, expanded: false, loading: false }))
      .filter((c) => c.noc > 0)        // only groups that actually have fossils
      .sort((a, b) => b.noc - a.noc)   // most-collected first
      .slice(0, 60))
    .catch(() => []);
  taxChildCache.set(key, p);
  return p;
}

/* A reusable taxon picker: a text box with live search plus a lazy drill-down
 * tree. Powers both the "Taxon name" and "Exclude groups" fields. Its tree state
 * (expanded branches, fetched children) lives on `roots`, so it persists between
 * openings. */
function createTaxonPicker(input, box, { isSel, onPick, closeOnPick, storeKey, allowFreeText }) {
  const roots = freshTaxRoots();
  let index = [], items = [], active = -1, timer = null, req = 0;
  const expandedKeys = storeKey ? loadSet(storeKey) : new Set(); // persisted branches
  const keyOf = (n) => n.oid ? `id:${n.oid}` : `nm:${n.name}`;

  const show = () => box.classList.remove("hidden");
  const hide = () => { box.classList.add("hidden"); active = -1; };
  const openTree = (scrollSel) => { closeOtherPickers(hide); renderTree(scrollSel); };
  pickerHides.push(hide);
  const sync = () => { items = [...box.querySelectorAll(".opt")].map((el) => el.dataset.val); active = -1; };

  function nodeHtml(node, depth) {
    const key = index.push(node) - 1;
    const has = node.children && node.children.length;
    const expandable = node.children === null || has; // unknown or known-to-have kids
    const open = node.expanded && has;
    const tw = node.loading ? `<span class="tw">⋯</span>`
      : expandable ? `<span class="tw">${open ? "▾" : "▸"}</span>`
      : `<span class="tw none"></span>`;
    const meta = node.noc != null ? `<span class="ct">${(+node.noc).toLocaleString()}</span>` : "";
    const rank = node.rnk ? `<span class="rk">${esc(node.rnk)}</span>` : "";
    const sel = isSel(node.name) ? " sel" : "";
    let html = `<div class="opt tnode${sel}" data-tk="${key}" data-val="${esc(node.name)}" data-exp="${expandable ? 1 : 0}" style="padding-left:${6 + depth * 16}px">
      ${tw}<span class="nm">${esc(node.name)}</span>${rank}${meta}${PICK_BTN(node.name)}</div>`;
    if (open) html += node.children.map((c) => nodeHtml(c, depth + 1)).join("");
    return html;
  }

  function renderTree(scrollSel) {
    index = [];
    box.innerHTML = TAX_HINT + roots.map((g) =>
      `<div class="grp">${esc(g.group)}</div>` + g.nodes.map((n) => nodeHtml(n, 0)).join("")).join("");
    sync(); show();
    if (scrollSel) { const s = box.querySelector(".opt.sel"); if (s) s.scrollIntoView({ block: "center" }); }
  }

  function scrollNode(node) {
    const i = index.indexOf(node);
    const row = i >= 0 && box.querySelector(`.opt[data-tk="${i}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  function rememberExpansion(node) {
    if (!storeKey) return;
    node.expanded ? expandedKeys.add(keyOf(node)) : expandedKeys.delete(keyOf(node));
    saveSet(storeKey, expandedKeys);
  }

  async function expand(node) {
    if (node.loading) return;
    if (node.children !== null) {
      node.expanded = !node.expanded; rememberExpansion(node);
      renderTree(); scrollNode(node); return;
    }
    node.loading = true; renderTree(); scrollNode(node);
    node.children = await fetchTaxonChildren(node);
    node.loading = false; node.expanded = true; rememberExpansion(node);
    renderTree(); scrollNode(node);
  }

  /* Re-open the branches the user had expanded last time (fetching children as
   * needed) so the tree looks the same after a reload. */
  async function restoreExpanded() {
    if (!expandedKeys.size) return;
    const visit = async (nodes) => {
      for (const n of nodes) {
        if (!expandedKeys.has(keyOf(n))) continue;
        if (n.children === null) n.children = await fetchTaxonChildren(n);
        n.expanded = true;
        await visit(n.children || []);
      }
    };
    await visit(roots.flatMap((g) => g.nodes));
    if (!box.classList.contains("hidden")) renderTree();
  }
  restoreExpanded();

  async function liveSearch(q) {
    const my = ++req;
    try {
      const recs = ((await fetch(`${PBDB}/taxa/auto.json?name=${encodeURIComponent(q)}&limit=12`)
        .then((r) => r.json())).records) || [];
      if (my !== req) return; // superseded by a newer keystroke
      // Collapse the duplicate entries PBDB returns for one clade, keyed on
      // name + occurrence count so cross-code homonyms (e.g. Euhelopus) survive.
      const byKey = new Map();
      for (const r of recs) {
        const k = `${r.nam}|${r.noc}`, cur = byKey.get(k);
        if (!cur || (/^[A-Z]/.test(r.nam) && !/^[A-Z]/.test(cur.nam))) byKey.set(k, r);
      }
      const list = [...byKey.values()];
      box.innerHTML = list.length
        ? list.map((r) => optRow(r.nam, RANK[+r.rnk] || "", (+r.noc).toLocaleString())).join("")
        : `<div class="grp">No matching taxa — check the spelling</div>`;
      sync(); show();
    } catch (e) { /* network blip — leave the box as-is */ }
  }

  function choose(val) {
    onPick(val);
    if (closeOnPick) hide();
    else { input.value = ""; renderTree(); } // exclude: clear & keep browsing for more
  }
  function setActive(i) {
    const opts = box.querySelectorAll(".opt");
    if (!opts.length) return;
    active = (i + opts.length) % opts.length;
    opts.forEach((el, n) => el.classList.toggle("active", n === active));
    opts[active].scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { renderTree(); return; }
    timer = setTimeout(() => liveSearch(q), 180);
  });
  input.addEventListener("focus", () => openTree(true)); // re-opening shows the tree
  // Clicking the field when it's closed (e.g. after a pick) reopens the tree,
  // without needing to click away and back first.
  input.addEventListener("click", () => { if (box.classList.contains("hidden")) openTree(true); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hide(); return; }
    if (e.key === "Enter") {
      if (active >= 0) { e.preventDefault(); choose(items[active]); }
      else if (allowFreeText && input.value.trim()) { e.preventDefault(); choose(input.value.trim()); }
      return;
    }
    if (box.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
  });
  box.addEventListener("mousedown", (e) => {
    // Keep this click from reaching the outside-click handler — re-rendering the
    // tree detaches the clicked node, which would otherwise look like an outside click.
    e.stopPropagation();
    const pick = e.target.closest("[data-pick]");
    if (pick) { e.preventDefault(); choose(pick.closest(".opt").dataset.val); return; }
    const row = e.target.closest(".opt");
    if (!row) return;
    e.preventDefault();
    const node = row.dataset.tk != null ? index[+row.dataset.tk] : null;
    if (row.dataset.exp === "1" && node) expand(node); // click a branch row → drill in
    else choose(row.dataset.val);                       // leaf or search row → select
  });

  return { renderTree, hide };
}

/* Main "Taxon name" field */
const taxonInput = $("f-taxon");
const taxonPicker = createTaxonPicker(taxonInput, $("taxon-suggest"), {
  isSel: (name) => name === taxonInput.value.trim(),
  closeOnPick: true,
  storeKey: "pdmap.tax.exp",
  onPick: (name) => {
    taxonInput.value = name;
    taxonLineage(name).then((p) => { taxonInput.title = p || name; }); // full-path tooltip
    search();
  },
});

/* "Exclude groups" field — multiple removable chips, same tree/search picker */
let excludes = [];
function renderExcludeChips() {
  const box = $("exclude-chips");
  box.innerHTML = excludes.map((n) =>
    `<span class="chip-tag">${esc(n)}<button type="button" class="x" data-rm="${esc(n)}" title="Remove">×</button></span>`).join("");
  box.classList.toggle("empty", !excludes.length);
}
function addExclude(name) { if (!excludes.includes(name)) { excludes.push(name); renderExcludeChips(); search(); } }
function removeExclude(name) { excludes = excludes.filter((x) => x !== name); renderExcludeChips(); search(); }
$("exclude-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-rm]");
  if (b) removeExclude(b.dataset.rm);
});
const excludePicker = createTaxonPicker($("f-exclude"), $("exclude-suggest"), {
  isSel: (name) => excludes.includes(name),
  closeOnPick: false,
  allowFreeText: true,        // type any name + Enter to exclude it
  storeKey: "pdmap.exc.exp",
  onPick: addExclude,
});
renderExcludeChips();
pickerHides.push(intHide); // so opening the taxon/exclude tree also closes the interval tree

/* =========================================================================
 * Region picker — a tree (continent ▸ its countries) with type-to-search,
 * mirroring the interval picker. Selecting a continent or country sets its
 * PBDB cc code in `selectedRegion`; the input just shows the readable label.
 * ========================================================================= */
const rgInput = $("f-region"), rgBox = $("region-suggest"), RG_STORE = "pdmap.rg.exp";
let rgItems = [], rgActive = -1;
const expandedRegions = loadSet(RG_STORE);

const RG_HINT = `<div class="tree-hint">Click <b>▸</b> to open a continent · click a name to choose it</div>`;
const rgWorldRow = () =>
  `<div class="opt tnode${selectedRegion === "" ? " sel" : ""}" data-val="">
     <span class="tw none"></span><span class="nm">🌍 Whole world</span><span class="lvl">all regions</span></div>`;

function rgTreeHtml() {
  return REGION_TREE.map((g) => {
    const open = expandedRegions.has(g.code || g.name);
    const tw = `<span class="tw">${open ? "▾" : "▸"}</span>`;
    const sel = g.code && g.code === selectedRegion ? " sel" : "";
    // A real region (continent/ocean) is itself selectable; the catch-all isn't.
    const pick = g.code ? PICK_BTN(g.name) : "";
    const kind = g.code ? (g.code === "OCE" || g.code === "IOC" ? "ocean" : "continent") : "group";
    let html = `<div class="opt tnode${sel}" data-val="${g.code}" data-grp="${esc(g.code || g.name)}" data-exp="1">
        ${tw}<span class="nm">${esc(g.name)}</span><span class="lvl">${kind}</span>${pick}</div>`;
    if (open) html += g.children.map((c) =>
      `<div class="opt tnode${c.code === selectedRegion ? " sel" : ""}" data-val="${c.code}" style="padding-left:30px">
         <span class="tw none"></span><span class="nm">${esc(c.name)}</span><span class="lvl">${esc(c.tag || c.code)}</span></div>`).join("");
    return html;
  }).join("");
}

function rgSync() { rgItems = [...rgBox.querySelectorAll(".opt")].map((el) => el.dataset.val); rgActive = -1; }
function rgShow() { rgBox.classList.remove("hidden"); }
function rgHide() {
  rgBox.classList.add("hidden"); rgActive = -1;
  rgInput.value = selectedRegion ? regionLabel(selectedRegion) : ""; // drop any half-typed query
}
pickerHides.push(rgHide);

function rgRenderTree(scrollToSel) {
  rgBox.innerHTML = RG_HINT + rgWorldRow() + rgTreeHtml();
  rgSync(); rgShow();
  if (scrollToSel) { const s = rgBox.querySelector(".opt.sel"); if (s) s.scrollIntoView({ block: "center" }); }
}

function rgRenderSearch(q) {
  const ql = q.trim().toLowerCase();
  const rows = [];
  for (const g of REGION_TREE) {
    if (g.code && g.name.toLowerCase().includes(ql)) {
      const kind = g.code === "OCE" || g.code === "IOC" ? "ocean" : "continent";
      rows.push(`<div class="opt" data-val="${g.code}"><span class="nm">${esc(g.name)}</span><span class="lvl">${kind}</span></div>`);
    }
    for (const c of g.children) {
      const alias = REGION_ALIASES[c.code] || "";
      if (c.name.toLowerCase().includes(ql) || alias.includes(ql) || c.code.toLowerCase() === ql) {
        rows.push(`<div class="opt" data-val="${c.code}"><span class="nm">${esc(c.name)}</span><span class="rk">${esc(g.name)}</span><span class="lvl">${esc(c.tag || c.code)}</span></div>`);
      }
    }
  }
  rgBox.innerHTML = rows.length ? rows.join("") : `<div class="grp">No region matches “${esc(q)}”</div>`;
  rgSync(); rgShow();
}

function setRegion(code) { // update state + label without searching (load / clear)
  selectedRegion = code || "";
  rgInput.value = selectedRegion ? regionLabel(selectedRegion) : "";
}
function pickRegion(code) {
  setRegion(code);
  rgHide();
  search();
}
function rgSetActive(i) {
  const opts = rgBox.querySelectorAll(".opt");
  if (!opts.length) return;
  rgActive = (i + opts.length) % opts.length;
  opts.forEach((el, n) => el.classList.toggle("active", n === rgActive));
  opts[rgActive].scrollIntoView({ block: "nearest" });
}

rgInput.addEventListener("input", () => {
  const q = rgInput.value.trim();
  q ? rgRenderSearch(q) : rgRenderTree(false);
});
rgInput.addEventListener("focus", () => { closeOtherPickers(rgHide); rgInput.select(); rgRenderTree(true); });
rgInput.addEventListener("click", () => {
  if (rgBox.classList.contains("hidden")) { closeOtherPickers(rgHide); rgRenderTree(true); }
});
rgInput.addEventListener("keydown", (e) => {
  if (rgBox.classList.contains("hidden")) return;
  if (e.key === "ArrowDown") { e.preventDefault(); rgSetActive(rgActive + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); rgSetActive(rgActive - 1); }
  else if (e.key === "Enter" && rgActive >= 0) { e.preventDefault(); pickRegion(rgItems[rgActive]); }
  else if (e.key === "Escape") { rgHide(); }
});
rgBox.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  const pick = e.target.closest("[data-pick]");
  if (pick) { e.preventDefault(); pickRegion(pick.closest(".opt").dataset.val); return; }
  const row = e.target.closest(".opt");
  if (!row) return;
  e.preventDefault();
  if (row.dataset.exp === "1" && row.dataset.grp != null) { // a continent header → expand/collapse
    const id = row.dataset.grp;
    expandedRegions.has(id) ? expandedRegions.delete(id) : expandedRegions.add(id);
    saveSet(RG_STORE, expandedRegions);
    rgRenderTree(false);
    const r2 = rgBox.querySelector(`.opt[data-grp="${CSS.escape(id)}"]`);
    if (r2) r2.scrollIntoView({ block: "nearest" });
    return;
  }
  pickRegion(row.dataset.val); // World row or a country leaf → select
});

/* One outside-click handler closes whichever picker is open. */
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".suggest-wrap")) { taxonPicker.hide(); excludePicker.hide(); rgHide(); }
});

/* ----------------------------------------------------------------- Wire up --- */
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault(); taxonPicker.hide(); excludePicker.hide(); search();
});
$("btn-clear").addEventListener("click", () => {
  $("f-taxon").value = ""; $("f-exclude").value = ""; $("f-formation").value = "";
  excludes = []; renderExcludeChips();
  $("f-interval").value = ""; selectedInterval = "";
  $("f-maxma").value = ""; $("f-minma").value = ""; $("f-env").value = "";
  setRegion("");
  $("f-view").checked = false; intHint();
  $("btn-download").disabled = true; $("f-export").disabled = true;
  legendSel = null; buildLegend();
  if (typeof tmStop === "function") tmStop();
  currentTaxon = ""; updateTaxonInfo("");
  currentRecs = [];
  globe.pointsData([]); globe.hexBinPointsData([]);
  setStatus("");
  writeHash();
});
$("btn-download").addEventListener("click", exportResults);
$("detail-close").addEventListener("click", () => {
  $("detail").classList.add("hidden");
  $("timescale").classList.remove("detail-open");
});
$("panel-toggle").addEventListener("click", () => $("panel").classList.remove("collapsed"));
$("panel-close").addEventListener("click", () => $("panel").classList.add("collapsed"));

$("f-paleo").addEventListener("change", (e) => {
  usePaleo = e.target.checked;
  applyCoords(currentRecs);
  applyLayerMode();
  updatePaleoGlobe();
  writeHash();
});
$("f-spin").addEventListener("change", (e) => {
  spinWanted = e.target.checked;
  updateSpin(globe.pointOfView().altitude);
});
// While ancient-Earth mode owns the globe surface, just remember the choice for
// when paleo mode is switched back off.
$("f-base").addEventListener("change", (e) => { if (!usePaleo) setBaseLayer(e.target.value); });

/* Default to crisp satellite imagery when we're online (so zooming in is sharp
 * out of the box); fall back to the offline Blue Marble otherwise. */
(function pickDefaultBaseLayer() {
  const mode = navigator.onLine === false ? "marble" : "satellite";
  $("f-base").value = mode;
  setBaseLayer(mode);
})();

/* =========================================================================
 * Shareable state — every filter (plus paleo / colour / density toggles) is
 * captured in one object, used both for the URL permalink and saved searches.
 * ========================================================================= */
function getState() {
  return {
    taxon: $("f-taxon").value.trim(),
    exclude: excludes.join("^"),
    interval: selectedInterval,
    maxma: $("f-maxma").value.trim(),
    minma: $("f-minma").value.trim(),
    unit: $("f-unit").value,
    env: $("f-env").value,
    region: selectedRegion,
    formation: $("f-formation").value.trim(),
    view: $("f-view").checked ? 1 : 0,
    limit: $("f-limit").value,
    paleo: usePaleo ? 1 : 0,
    base: $("f-base").value,
    cb: cbSafe ? 1 : 0,
    density: $("f-density").checked ? 1 : 0,
  };
}
function applyState(s) {
  if (!s) return;
  $("f-taxon").value = s.taxon || ""; currentTaxon = s.taxon || "";
  excludes = s.exclude ? s.exclude.split("^").filter(Boolean) : [];
  renderExcludeChips();
  selectedInterval = s.interval || "";
  $("f-interval").value = selectedInterval;
  $("f-interval").title = selectedInterval ? intervalPath(selectedInterval) : "";
  $("f-maxma").value = s.maxma || "";
  $("f-minma").value = s.minma || "";
  if (s.unit) $("f-unit").value = s.unit;
  $("f-env").value = s.env || "";
  setRegion(s.region || "");
  $("f-formation").value = s.formation || "";
  $("f-view").checked = !!+s.view;
  if (s.limit) $("f-limit").value = s.limit;
  usePaleo = !!+s.paleo; $("f-paleo").checked = usePaleo;
  if (s.base) { $("f-base").value = s.base; if (!usePaleo) setBaseLayer(s.base); }
  cbSafe = !!+s.cb; $("f-cb").checked = cbSafe;
  $("f-density").checked = !!+s.density;
  intHint();
}
function writeHash() {
  const s = getState();
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(s)) {
    if (v === "" || v === 0 || v == null) continue;
    if (k === "unit" && v === "Ma") continue;       // default
    if (k === "limit" && v === "2000") continue;    // default
    p.set(k, v);
  }
  const q = p.toString();
  history.replaceState(null, "", q ? "#" + q : location.pathname + location.search);
}
function readHash() {
  const h = location.hash.replace(/^#/, "");
  if (!h) return null;
  const o = {};
  for (const [k, v] of new URLSearchParams(h)) o[k] = v;
  return Object.keys(o).length ? o : null;
}
async function copyLink() {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); flash("🔗 Link copied to clipboard"); }
  catch { prompt("Copy this link:", location.href); }
}

/* A brief status message that restores the previous one afterwards. */
function flash(msg) {
  const el = $("status"), prev = el.textContent, cls = el.className;
  setStatus(msg, "busy");
  setTimeout(() => { if (el.textContent === msg) { el.textContent = prev; el.className = cls; } }, 2200);
}

/* =========================================================================
 * Diversity stats — a quick breakdown of the current result set.
 * ========================================================================= */
function renderStats(recs) {
  const body = $("stats-body");
  if (!recs.length) { body.innerHTML = `<p class="muted-note">No results to summarise.</p>`; return; }
  const byBand = new Map(), byCountry = new Map(), byFm = new Map();
  let totalOcc = 0;
  for (const r of recs) {
    const b = bandFor(+r.eag || 0);
    const key = b ? b.name : "Unknown";
    const e = byBand.get(key) || { colls: 0, occs: 0, color: b ? bandColor(b) : "#777", min: b ? b.min : 1e9 };
    e.colls++; e.occs += (+r.noc || 0); byBand.set(key, e);
    totalOcc += (+r.noc || 0);
    if (r.cc2) byCountry.set(r.cc2, (byCountry.get(r.cc2) || 0) + 1);
    if (r.sfm) byFm.set(r.sfm, (byFm.get(r.sfm) || 0) + 1);
  }
  const bands = [...byBand.entries()].sort((a, b) => a[1].min - b[1].min);
  const maxC = Math.max(...bands.map(([, e]) => e.colls));
  const barRows = bands.map(([name, e]) =>
    `<div class="bar-row" title="${e.occs.toLocaleString()} occurrences">
       <span class="bar-lbl">${esc(name)}</span>
       <span class="bar-track"><span class="bar-fill" style="width:${Math.round(e.colls / maxC * 100)}%;background:${e.color}"></span></span>
       <span class="bar-num">${e.colls.toLocaleString()}</span>
     </div>`).join("");
  // Each chip is a button that flies the globe to that group's localities. `attr`
  // tags it so the delegated handler below knows what to centre on.
  const top = (m, fmt, attr) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `<button type="button" class="stat-chip" ${attr(k)}
        title="Fly to these localities">${esc(fmt ? fmt(k) : k)} <b>${v}</b></button>`).join("");
  const countryChips = top(byCountry, countryName, (k) => `data-fly-cc="${esc(k)}"`);
  const fmChips = top(byFm, null, (k) => `data-fly-fm="${esc(k)}"`);
  body.innerHTML = `
    <div class="stat-top"><span><b>${recs.length.toLocaleString()}</b> localities</span>
      <span><b>${totalOcc.toLocaleString()}</b> occurrences</span></div>
    <div class="stat-sec">Localities by period</div>
    <div class="bars">${barRows}</div>
    <div class="stat-sec">Top countries</div>
    <div class="stat-chips">${countryChips || "—"}</div>
    <div class="stat-sec">Top formations</div>
    <div class="stat-chips">${fmChips || "—"}</div>`;
}

/* Fly the globe to the centroid of the localities matching a predicate (used by
 * the clickable country / formation chips). A spherical mean keeps groups that
 * straddle the antimeridian honest, and the spread sets a sensible zoom. */
function flyToGroup(pred, label, tight) {
  const pts = currentRecs.filter(pred);
  if (!pts.length) { flash(`No mapped localities for ${label}.`); return; }
  const D = Math.PI / 180;
  let x = 0, y = 0, z = 0;
  for (const r of pts) {
    const la = r.plat * D, lo = r.plng * D;
    x += Math.cos(la) * Math.cos(lo); y += Math.cos(la) * Math.sin(lo); z += Math.sin(la);
  }
  x /= pts.length; y /= pts.length; z /= pts.length;
  const lat = Math.atan2(z, Math.hypot(x, y)) / D;
  const lng = Math.atan2(y, x) / D;
  // Furthest point from the centroid → how tightly to zoom (one site = close in).
  let spread = 0;
  for (const r of pts) {
    spread = Math.max(spread, Math.hypot((r.plat - lat), (r.plng - lng) *
      Math.cos(lat * D)));
  }
  // A formation pins down a much smaller area than a whole country, so zoom in
  // tighter (lower floor + scale) when the caller asks for it.
  const alt = tight
    ? Math.min(2.2, Math.max(0.08, spread / 50 + 0.1))
    : Math.min(2.2, Math.max(0.25, spread / 35 + 0.3));
  globe.controls().autoRotate = false;
  globe.pointOfView({ lat, lng, altitude: alt }, 1200);
  flash(`📍 ${label} — ${pts.length} ${pts.length === 1 ? "locality" : "localities"}`);
}
$("stats-body").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-fly-cc]");
  if (cc) { flyToGroup((r) => (r.cc2 || "") === cc.dataset.flyCc, countryName(cc.dataset.flyCc)); return; }
  const fm = e.target.closest("[data-fly-fm]");
  if (fm) flyToGroup((r) => (r.sfm || "") === fm.dataset.flyFm, fm.dataset.flyFm, true);
});

/* =========================================================================
 * Saved searches — name and reload any filter combination (localStorage).
 * ========================================================================= */
const SAVED_KEY = "pdmap.saved";
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); } catch (e) { return []; } };
const storeSaved = (l) => { try { localStorage.setItem(SAVED_KEY, JSON.stringify(l)); } catch (e) { /* private mode */ } };
function defaultSaveName() {
  const s = getState();
  const when = s.interval || (s.maxma ? `${s.maxma}–${s.minma || 0} ${s.unit}` : "all ages");
  return `${s.taxon || "All taxa"} · ${when}`;
}
function saveSearch() {
  const name = (prompt("Name this search:", defaultSaveName()) || "").trim();
  if (!name) return;
  const list = loadSaved().filter((x) => x.name !== name);
  list.unshift({ name, state: getState() });
  storeSaved(list.slice(0, 30));
  renderSaved();
  $("saved-wrap").open = true;
  flash("★ Saved");
}
function renderSaved() {
  const list = loadSaved();
  $("saved-wrap").classList.toggle("hidden", !list.length);
  $("saved-list").innerHTML = list.map((it, i) =>
    `<div class="saved-row">
       <button type="button" class="saved-load" data-load="${i}" title="Load this search">${esc(it.name)}</button>
       <button type="button" class="saved-del" data-del="${i}" title="Delete">×</button>
     </div>`).join("");
}
$("saved-list").addEventListener("click", (e) => {
  const load = e.target.closest("[data-load]"), del = e.target.closest("[data-del]");
  const list = loadSaved();
  if (del) { list.splice(+del.dataset.del, 1); storeSaved(list); renderSaved(); return; }
  if (load) { applyState(list[+load.dataset.load].state); buildLegend(); updatePaleoGlobe(); search(); }
});

/* =========================================================================
 * Time machine — sweep through deep time; the continents follow in paleo mode.
 * ========================================================================= */
const tmRange = $("tm-range"), tmBand = $("tm-band"), tmLabel = $("tm-label"), tmPlay = $("tm-play");
let tmPlaying = false, tmToken = 0, tmTimer = null;
const tmAge = () => +tmRange.value;
function tmUpdateLabel() {
  const b = bandFor(tmAge());
  tmLabel.textContent = `${tmAge()} Ma${b ? " · " + b.name : ""}`;
}
async function tmApply() {
  const age = tmAge(), half = +tmBand.value;
  $("f-unit").value = "Ma";
  $("f-maxma").value = Math.round(age + half);
  $("f-minma").value = Math.max(0, Math.round(age - half));
  selectedInterval = ""; $("f-interval").value = ""; intHint();
  tmUpdateLabel();
  await search();
}
function tmOnInput() {
  tmUpdateLabel();
  clearTimeout(tmTimer);
  tmTimer = setTimeout(tmApply, 250); // debounce while dragging
}
function tmStop() { tmPlaying = false; tmToken++; tmPlay.textContent = "▶"; tmPlay.classList.remove("on"); }
async function tmPlayLoop() {
  const my = ++tmToken;
  tmPlaying = true; tmPlay.textContent = "⏸"; tmPlay.classList.add("on");
  if (!usePaleo) { usePaleo = true; $("f-paleo").checked = true; } // watch continents move
  if (tmAge() < 20) tmRange.value = tmRange.max;                   // start from the deep past
  while (tmPlaying && my === tmToken && tmAge() > 0) {
    await tmApply();
    if (my !== tmToken) return;
    tmRange.value = Math.max(0, tmAge() - +tmBand.value);
    await new Promise((r) => setTimeout(r, 450));
  }
  if (my === tmToken) { await tmApply(); tmStop(); }
}
tmPlay.addEventListener("click", () => (tmPlaying ? tmStop() : tmPlayLoop()));
tmRange.addEventListener("input", () => { if (tmPlaying) tmStop(); tmOnInput(); });
tmBand.addEventListener("change", tmUpdateLabel);
tmUpdateLabel();

/* Point the time machine at a specific age span (from a ⏳ icon next to any
 * displayed date range): set the custom range, move the slider, and re-search. */
function applyTimeRange(maxMa, minMa) {
  if (tmPlaying) tmStop();
  $("f-unit").value = "Ma";
  $("f-maxma").value = maxMa;
  $("f-minma").value = minMa;
  selectedInterval = ""; $("f-interval").value = ""; $("f-interval").title = "";
  tmRange.value = Math.min(+tmRange.max, Math.max(0, Math.round((maxMa + minMa) / 2)));
  // Snap the window selector to the nearest preset for a tidy follow-on ▶ sweep.
  const half = (maxMa - minMa) / 2;
  const presets = [...tmBand.options].map((o) => +o.value);
  tmBand.value = String(presets.reduce((a, b) => Math.abs(b - half) < Math.abs(a - half) ? b : a));
  tmUpdateLabel(); intHint();
  flash(`⏳ Time set to ${fmtMa(maxMa)}–${fmtMa(minMa)} Ma`);
  search();
}
/* One delegated handler for every ⏳ icon, wherever a date range is shown. */
document.addEventListener("click", (e) => {
  const b = e.target.closest(".tm-set");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  applyTimeRange(+b.dataset.max, +b.dataset.min);
});

/* =========================================================================
 * Fly-to place search (OpenStreetMap / Nominatim).
 * ========================================================================= */
$("f-place").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const q = $("f-place").value.trim();
  if (!q) return;
  flash(`Finding “${q}”…`);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { "Accept-Language": "en" } });
    const hit = (await res.json())[0];
    if (!hit) { flash(`No place found for “${q}”.`); return; }
    globe.controls().autoRotate = false;
    globe.pointOfView({ lat: +hit.lat, lng: +hit.lon, altitude: 1.1 }, 1200);
    flash(`📍 ${(hit.display_name || q).split(",").slice(0, 2).join(",")}`);
  } catch (err) { flash("Place search failed — try again."); }
});

/* =========================================================================
 * One-click sample queries (onboarding).
 * ========================================================================= */
const BLANK = { taxon: "", exclude: "", interval: "", maxma: "", minma: "", unit: "Ma",
  env: "", region: "", formation: "", view: 0 };
const SAMPLES = [
  { label: "🦖 T. rex", state: { taxon: "Tyrannosaurus", interval: "Cretaceous" } },
  { label: "🦣 Ice-age mammals", state: { taxon: "Mammalia", maxma: "2.5", minma: "0", unit: "Ma" } },
  { label: "🐚 Jurassic ammonites", state: { taxon: "Ammonoidea", interval: "Jurassic" } },
  { label: "🪼 Cambrian life", state: { interval: "Cambrian" } },
  { label: "🌿 Ediacaran biota", state: { interval: "Ediacaran" } },
  { label: "🪲 Trilobites", state: { taxon: "Trilobita" } },
];
function buildSamples() {
  $("samples").innerHTML = SAMPLES.map((s, i) =>
    `<button type="button" class="sample" data-s="${i}">${esc(s.label)}</button>`).join("");
}
$("samples").addEventListener("click", (e) => {
  const b = e.target.closest("[data-s]"); if (!b) return;
  const s = SAMPLES[+b.dataset.s];
  applyState({ ...BLANK, limit: $("f-limit").value, paleo: usePaleo ? 1 : 0,
    base: $("f-base").value, cb: cbSafe ? 1 : 0, density: $("f-density").checked ? 1 : 0, ...s.state });
  if ($("f-taxon").value) taxonLineage($("f-taxon").value).then((p) => { taxonInput.title = p || ""; });
  search();
});
buildSamples();

/* =========================================================================
 * Remaining wiring — interactive legend, colour & density toggles, buttons.
 * ========================================================================= */
$("legend-list").addEventListener("click", (e) => {
  if (e.target.closest(".tm-set")) return; // the ⏳ icon has its own handler
  const li = e.target.closest("[data-period]");
  if (li) setLegendFilter(li.dataset.period);
});
$("f-cb").addEventListener("change", (e) => {
  cbSafe = e.target.checked;
  buildLegend(); buildTimescale(); recolorPoints();
  writeHash();
});
$("f-density").addEventListener("change", () => { applyLayerMode(); writeHash(); });
$("btn-save").addEventListener("click", saveSearch);
$("btn-link").addEventListener("click", copyLink);
renderSaved();

/* A friendly first search so the globe isn't empty on load — unless the URL
 * carries a shared query, in which case we restore that exactly. Load the live
 * timescale first so the interval picker is fully populated from the start. */
(async function init() {
  await loadTimescale();
  const hash = readHash();
  if (hash) {
    applyState(hash);
    buildLegend();
    taxonLineage($("f-taxon").value).then((p) => { taxonInput.title = p || ""; });
  } else {
    $("f-taxon").value = "Dinosauria"; currentTaxon = "Dinosauria";
    taxonLineage("Dinosauria").then((p) => { taxonInput.title = p || "Dinosauria"; });
    selectedInterval = "Cretaceous";
    intInput.value = "Cretaceous";
    intInput.title = intervalPath("Cretaceous");
    intHint();
  }
  if (usePaleo) updatePaleoGlobe();
  search();
})();

/* On phones, start with the panel tucked away so the globe is the hero;
 * the ☰ button reopens it. */
if (window.matchMedia("(max-width: 640px)").matches) $("panel").classList.add("collapsed");
