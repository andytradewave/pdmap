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
/* Rebuilds the colour-blind ramp (the legend list itself was retired — the top
 * timescale is the colour key now). Kept as buildLegend() so its many call sites
 * still refresh the ramp after the bands or cb-mode change. */
function buildLegend() {
  buildCbMap();
}
function pointPaint(d) { return d.color; }

/* ----------------------------------------------- Geological timescale --- */
/* Full ICS timescale (eons → eras → periods → epochs → ages), fetched live
 * from PBDB so the interval names line up exactly with what the API accepts.
 * Falls back to the built-in PERIODS list if we're offline. */
const LEVELS = ["eon", "era", "period", "epoch", "age"];
let INTERVALS = PERIODS.map((p) => // sensible offline default
  ({ name: p.name, type: "period", max: p.max, min: p.min, color: p.color }));
let selectedInterval = "";
let selectedRegion = "";          // PBDB cc code (continent or country); "" = whole world
let usePaleo = false;             // ancient-Earth (paleo-coordinate) mode
let excludes = [];                // taxa subtracted from the base taxon
let intervalRoots = [];           // top of the timescale tree (the eons)
let intById = new Map();          // interval id -> node

/* Wire each interval to its parent so the top timescale can drill down a branch
 * (eon ▸ era ▸ period ▸ epoch ▸ age) and walk ancestry for tooltips/highlights. */
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
}
buildIntervalTree();

const fmtMa = (v) => v == null ? "?" :
  +v === 0 ? "0" :
  v >= 10 ? String(Math.round(v)) :
  v >= 1 ? (+v).toFixed(1) :
  v >= 0.01 ? (+v).toFixed(3) : (+v).toFixed(4);

buildLegend(); // draw the offline fallback legend immediately

/* -------------------------------------------------- Geologic timescale --- */
/* A colourful, drill-down timescale pinned to the top of the page. The header
 * is a single eon/era row covering all of geological time — the three Precambrian
 * eons compressed to a fixed width on the left (they're ~8× longer than the
 * Phanerozoic and would otherwise crush the scale), then the Phanerozoic eras.
 * Selecting an eon/era opens its periods below it, a period opens its epochs, an
 * epoch its ages — each row zoomed to fill the width and showing only the
 * children of the chosen branch, so everything the tree exposes is reachable by
 * drilling in. The whole stack auto-collapses to a single line showing the
 * current pick and re-opens on hover. Picks drive the same selectedInterval the
 * search uses. */
const intByName = (name) => INTERVALS.find((x) => x.name === name);
const DEPTH = { eon: 0, era: 1, period: 2, epoch: 3, age: 4 };
const PRECAMBRIAN_EON_FLEX = 60; // fixed (compressed) width per Precambrian eon
const TM_MAX = 541;              // time-machine scrubber spans the Phanerozoic (Ma)

/* Walk a node up to its ancestor of the given level (or itself if it matches). */
function ancestorOfType(node, type) {
  let it = node;
  while (it) {
    if (it.type === type) return it;
    it = it.parent != null ? intById.get(it.parent) : null;
  }
  return null;
}

/* Phanerozoic = younger than ~545 Ma. The live data also tags it via the
 * Phanerozoic eon, but the age cut-off works for the offline fallback too. */
function scaleOfType(type) {
  return INTERVALS.filter((it) => it.type === type && it.max <= 545 && it.max - it.min > 0)
    .sort((a, b) => b.max - a.max); // oldest on the left
}
function precambrianEons() {
  return INTERVALS.filter((it) => it.type === "eon" && it.max > 545 && it.max - it.min > 0)
    .sort((a, b) => b.max - a.max);
}

/* One proportional, clickable cell. `flex` is its flex-grow share. Cells on the
 * selected lineage are highlighted — the deepest pick strongest (`on`), its
 * ancestors marked (`active`). `dimOthers` dulls the siblings of a chosen cell so
 * the selected one stands out; rows with nothing chosen yet stay bright. */
function tsSegHtml(node, flex, active, dimOthers) {
  const onPath = active && active.has(node.name);
  const cls = node.name === selectedInterval ? " on"
    : (onPath ? " active"
    : (dimOthers ? " dim" : ""));
  const col = node.color ? bandColor(node) : "#9a8aa0";
  return `<button type="button" class="ts-seg${cls}" data-val="${esc(node.name)}"
    style="flex:${flex.toFixed(3)} ${flex.toFixed(3)} 0;background:${col}"
    title="${esc(node.name)} · ${esc(node.type)} · ${fmtMa(node.max)}–${fmtMa(node.min)} Ma — click to filter">
    <span class="ts-seg-lbl">${esc(node.name)}</span></button>`;
}

/* Build a bar's cells, sizing each by `weightFn` but normalising the row so the
 * shares always sum to 100. Without this, a row of very short intervals (e.g. the
 * Holocene's ages, each a few thousand years) has flex-grow values summing to far
 * less than 1, so flexbox only grows them to a sliver and the row squashes to the
 * left. `min-width` (in CSS) still keeps tiny cells clickable. */
function tsBar(nodes, active, dimOthers, weightFn) {
  const weights = nodes.map((n) => Math.max(weightFn(n), 1e-6));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return nodes.map((n, i) => tsSegHtml(n, weights[i] / total * 100, active, dimOthers)).join("");
}

function tsRowHtml(label, inner) {
  if (!inner) return "";
  return `<div class="ts-row"><span class="ts-cap">${esc(label)}</span>
    <div class="ts-bar">${inner}</div></div>`;
}

/* The collapsed line: the current pick as a single coloured cell, the active
 * custom time-machine window, or a prompt. */
function tsSummaryHtml() {
  const it = selectedInterval ? intByName(selectedInterval) : null;
  if (!it) {
    // A custom age range (time machine, custom range, ⏳ icons) overrides any
    // interval, so surface it here rather than a bare "All time".
    const mx = $("f-maxma").value, mn = $("f-minma").value;
    if (mx || mn) {
      const b = bandFor((+mx + +mn) / 2);
      return `<div class="ts-seg none"><span class="ts-seg-lbl">⏳ ${fmtMa(+mx)}–${fmtMa(+mn)} Ma${b ? " · " + esc(b.name) : ""} — custom window ▾</span></div>`;
    }
    return `<div class="ts-seg none">
      <span class="ts-seg-lbl">All time — hover to choose an interval ▾</span></div>`;
  }
  const col = it.color ? bandColor(it) : "#9a8aa0";
  return `<button type="button" class="ts-seg on" data-val="${esc(it.name)}"
    style="background:${col}" title="${esc(intervalPath(it.name))}">
    <span class="ts-seg-lbl">${esc(it.name)} · ${esc(it.type)} · ${fmtMa(it.max)}–${fmtMa(it.min)} Ma</span></button>`;
}

/* The chain of nodes whose children we drill in beneath the header: from the
 * selection's eon/era (the level shown in the header) down to the selection
 * itself. Each link adds one finer row showing only that branch's children, so
 * the periods row holds just the selected eon/era's periods, then its epochs,
 * then its ages. */
function drillNodes(sel) {
  const top = sel.max <= 545 ? "era" : "eon"; // the level the header already shows
  const list = [];
  let it = sel;
  while (it) {
    list.unshift(it);
    if (DEPTH[it.type] <= DEPTH[top]) break;
    it = it.parent != null ? intById.get(it.parent) : null;
  }
  return list;
}

/* ------------------------------------------- The world at a given time --- */
/* Vendored, openly-licensed deep-time datasets, sampled across the Phanerozoic
 * and linearly interpolated. These are model/proxy *estimates* carrying real
 * uncertainty (shown as ranges) — for orientation, not precision — and most
 * don't extend into the Precambrian. Sources are cited on the card. */

// Atmosphere & climate. [Ma, CO2 ppm, O2 %, global mean surface temp °C].
// CO2 after the Foster/Hönisch Phanerozoic proxy compilations; O2 after Berner
// GEOCARBSULF; temperature after PhanDA (Judd et al. 2024) / Scotese (2021).
const PALEOCLIM = [
  [0, 415, 21, 14.5], [20, 400, 21, 16.5], [35, 560, 21, 18.5], [50, 850, 20, 21],
  [66, 620, 24, 23], [90, 900, 26, 26], [120, 1150, 27, 24], [145, 1050, 26, 22],
  [170, 1500, 25, 21], [200, 1800, 23, 20], [230, 1700, 18, 22], [250, 2000, 16, 27],
  [280, 420, 30, 18], [300, 350, 32, 13], [330, 500, 28, 18], [360, 1300, 22, 20],
  [400, 2100, 18, 21], [420, 2800, 16, 22], [444, 3800, 15, 14], [460, 4200, 14, 23],
  [485, 4600, 14, 24], [510, 5200, 13, 24], [541, 5600, 13, 22],
];
const CLIM_TODAY = { co2: 415, o2: 21, temp: 14.5 };

// Earth almanac. [Ma, day length h, sea level m vs present, seawater 87Sr/86Sr].
// Day length from rhythmite/cyclostratigraphy reconstructions (Williams, Waltham);
// sea level after Haq/Miller Phanerozoic curves; 87Sr/86Sr after McArthur LOWESS.
const ALMANAC = [
  [0, 24.0, 0, 0.7092], [50, 23.7, 70, 0.7077], [100, 23.5, 170, 0.7074],
  [145, 23.2, 110, 0.7073], [200, 22.9, 50, 0.7077], [250, 22.6, -20, 0.7071],
  [300, 22.4, -30, 0.7078], [350, 22.1, 80, 0.7082], [400, 21.9, 170, 0.7085],
  [444, 21.5, 200, 0.7079], [485, 21.3, 120, 0.7088], [541, 21.1, 30, 0.7085],
];

// Major confirmed impacts. [name, Ma, lat, lng, crater diameter km] (Earth Impact DB).
const IMPACTS = [
  ["Chicxulub", 66, 21.4, -89.5, 180], ["Popigai", 35.7, 71.6, 111.2, 90],
  ["Chesapeake Bay", 35.5, 37.3, -76.0, 40], ["Manicouagan", 215, 51.4, -68.7, 100],
  ["Morokweng", 145, -23.5, 23.5, 70], ["Acraman", 580, -32.0, 135.5, 90],
  ["Woodleigh", 364, -26.1, 114.7, 60], ["Siljan", 377, 61.0, 14.9, 52],
  ["Charlevoix", 342, 47.5, -70.3, 54], ["Rochechouart", 207, 45.8, 0.9, 23],
  ["Kara", 70, 69.1, 64.2, 65], ["Tookoonooka", 128, -27.0, 143.0, 55],
  ["Mistastin", 36, 55.9, -63.3, 28], ["Boltysh", 65.4, 48.8, 32.2, 24],
];
// Major Large Igneous Provinces. [name, Ma, lat, lng, linked event, Wikipedia
// title — the short display names above rarely match a Wikipedia title (or,
// worse, match a *different* generic/disambiguation page), so each is pinned.
const LIPS = [
  ["Deccan Traps", 66, 19, 74, "end-Cretaceous", "Deccan Traps"],
  ["Siberian Traps", 252, 67, 90, "end-Permian", "Siberian Traps"],
  ["CAMP", 201, 20, -40, "end-Triassic", "Central Atlantic magmatic province"],
  ["Karoo–Ferrar", 183, -30, 25, "Toarcian event", "Karoo-Ferrar"],
  ["Emeishan Traps", 259, 26, 103, "Capitanian event", "Emeishan Traps"],
  ["Ontong Java", 121, 0, 160, "Aptian anoxia", "Ontong Java Plateau"],
  ["Paraná–Etendeka", 134, -25, -50, "", "Paraná and Etendeka traps"],
  ["N. Atlantic IP", 56, 65, -10, "PETM", "North Atlantic Igneous Province"],
  ["Viluy Traps", 373, 65, 120, "Late Devonian", "Viluy traps"],
  ["Columbia River", 16, 46, -118, "", "Columbia River Basalt Group"],
];

/* Linear interpolation over an anchor table keyed by Ma in column 0. */
function interpRows(rows, ma, cols) {
  if (ma == null) return null;
  if (ma <= rows[0][0]) return cols.map((c) => rows[0][c]);
  for (let i = 1; i < rows.length; i++) {
    if (ma <= rows[i][0]) {
      const a = rows[i - 1], b = rows[i], f = (ma - a[0]) / (b[0] - a[0]);
      return cols.map((c) => a[c] + (b[c] - a[c]) * f);
    }
  }
  const z = rows[rows.length - 1]; return cols.map((c) => z[c]);
}
function climateAt(ma) {
  if (ma == null || ma > 541) return null;
  const [co2, o2, temp] = interpRows(PALEOCLIM, ma, [1, 2, 3]);
  return { co2, o2, temp };
}
function almanacAt(ma) {
  if (ma == null || ma > 541) return null;
  const [day, sea, sr] = interpRows(ALMANAC, ma, [1, 2, 3]);
  return { day, sea, sr, daysYear: 8766 / day }; // ~constant 8766 h/year
}

/* The age (Ma) the panels describe (a single representative value) and the full
 * span of the selected context (used to pick events that fall within it). */
function currentAgeMa() {
  const mx = $("f-maxma").value, mn = $("f-minma").value;
  if (mx || mn) return (+mx + +mn) / 2;
  if (selectedInterval) { const it = intByName(selectedInterval); if (it) return (it.max + it.min) / 2; }
  return 0;
}
function currentSpanMa() {
  const mx = $("f-maxma").value, mn = $("f-minma").value;
  if (mx || mn) return [Math.min(+mx, +mn), Math.max(+mx, +mn)];
  if (selectedInterval) { const it = intByName(selectedInterval); if (it) return [it.min, it.max]; }
  return [0, 0];
}

/* Impacts + LIPs whose age falls within (or just outside) the selected span. */
function eventsInSpan([min, max]) {
  const pad = Math.max(2, (max - min) * 0.04);
  const lo = min - pad, hi = max + pad;
  const im = IMPACTS.filter(([, ma]) => ma >= lo && ma <= hi)
    .map(([name, ma, lat, lng, d]) => ({ type: "impact", name, ma, lat, lng, d }));
  const li = LIPS.filter(([, ma]) => ma >= lo && ma <= hi)
    .map(([name, ma, lat, lng, ev, wiki]) => ({ type: "lip", name, ma, lat, lng, ev, wiki }));
  return [...im, ...li].sort((a, b) => a.ma - b.ma);
}

/* Paint the "world at this time" card for an age (defaults to the current time
 * context): atmosphere & climate, an Earth almanac, and notable events. */
function renderPaleoclimate(ma) {
  const box = $("paleoclimate");
  if (!box) return;
  if (ma === undefined) ma = currentAgeMa();
  box.classList.remove("hidden");
  const ageLbl = (ma == null || ma < 1) ? "Present day" : `~${fmtMa(ma)} Ma`;
  const c = climateAt(ma), a = almanacAt(ma);
  const events = eventsInSpan(currentSpanMa());
  const head = `<h3>World at this time <span class="climate-age">${esc(ageLbl)}</span></h3>`;

  if (!c) { // Precambrian — atmosphere/almanac estimates aren't meaningful here
    box.innerHTML = head + `<p class="muted-note">No reliable whole-Earth estimates before ~541 Ma (the Precambrian).</p>`
      + (events.length ? eventsHtml(events) : "");
    if (events.length) enrichEvents();
    return;
  }

  // Uncertainty widens with age; show each central value with a plausible range.
  const f = Math.min(1, ma / 500);
  const co2Rel = 0.2 + 0.45 * f, tBand = 1.5 + 2.5 * f, o2Band = 1 + 2 * f;
  const bar = (frac, cls) => `<div class="cl-bar"><i class="${cls}" style="width:${Math.max(2, Math.min(100, frac * 100)).toFixed(0)}%"></i></div>`;
  const rng = (lo, hi, u = "") => `<small>${Math.round(lo).toLocaleString()}–${Math.round(hi).toLocaleString()}${u}</small>`;
  const co2x = c.co2 / CLIM_TODAY.co2;
  const co2cmp = co2x >= 1.15 || co2x <= 0.85 ? `${co2x.toFixed(1)}× today` : "≈ today";
  const dT = c.temp - CLIM_TODAY.temp, tcmp = Math.abs(dT) < 0.6 ? "≈ today" : `${dT > 0 ? "+" : ""}${dT.toFixed(0)}° vs now`;

  box.innerHTML = head + `
    <div class="wt-grp">Atmosphere &amp; climate</div>
    <div class="climate-row"><span class="cl-k">CO₂</span>${bar(c.co2 / 6000, "co2")}<span class="cl-v">${Math.round(c.co2).toLocaleString()} ppm <small>${co2cmp}</small></span></div>
    <div class="climate-row"><span class="cl-k">O₂</span>${bar(c.o2 / 35, "o2")}<span class="cl-v">${c.o2.toFixed(0)}% ${rng(c.o2 - o2Band, c.o2 + o2Band, "%")}</span></div>
    <div class="climate-row"><span class="cl-k">Temp</span>${bar((c.temp - 8) / 22, "temp")}<span class="cl-v">${c.temp.toFixed(0)} °C <small>${tcmp}</small></span></div>
    <div class="climate-row co2-rng"><span class="cl-k"></span><span class="cl-v wide">CO₂ likely ${rng(c.co2 * (1 - co2Rel), c.co2 * (1 + co2Rel), " ppm")} · Temp ${rng(c.temp - tBand, c.temp + tBand, " °C")}</span></div>
    <div class="wt-grp">Earth almanac</div>
    <div class="wt-row"><span class="wt-k">Day length</span><span class="wt-v">${a.day.toFixed(1)} h</span></div>
    <div class="wt-row"><span class="wt-k">Days per year</span><span class="wt-v">${Math.round(a.daysYear)}</span></div>
    <div class="wt-row"><span class="wt-k">Sea level</span><span class="wt-v">${a.sea >= 0 ? "+" : ""}${Math.round(a.sea)} m vs today</span></div>
    <div class="wt-row"><span class="wt-k">Seawater ⁸⁷Sr/⁸⁶Sr</span><span class="wt-v">${a.sr.toFixed(4)}</span></div>
    ${eventsHtml(events)}
    <small class="climate-note">Model/proxy estimates — CO₂ after Hönisch/Foster &amp; GEOCARBSULF, O₂ after Berner, temperature after PhanDA/Scotese, day length after rhythmites, sea level after Haq/Miller, Sr after McArthur. Wide uncertainty.</small>`;
  if (events.length) enrichEvents();
}

function eventsHtml(events) {
  if (!events.length) return "";
  return `<div class="wt-grp">Events around this time</div>
    <div class="wt-events">${events.map((e) => {
      const detail = `${esc(e.name)}${e.type === "impact" ? " impact crater" : " (Large Igneous Province)"} · `
        + `${fmtMa(e.ma)} Ma · ${fmtLatLng(e.lat, e.lng)}`
        + (e.type === "impact" ? ` · ${e.d} km diameter` : (e.ev ? ` · linked to the ${esc(e.ev)}` : ""));
      return `
      <div class="wt-event" data-wiki-name="${esc(e.name)}" data-wiki-type="${e.type}" data-wiki-title="${esc(e.wiki || "")}">
        <div class="wt-ev-row" title="${detail.replace(/"/g, "&quot;")}">
          <span class="wt-ev-ic">${e.type === "impact" ? "☄️" : "🌋"}</span>
          <span class="wt-ev-nm">${esc(e.name)}${e.type === "impact" ? " crater" : " (LIP)"}</span>
          <span class="wt-ev-meta">${fmtMa(e.ma)} Ma${e.type === "impact" ? ` · ${e.d} km` : (e.ev ? ` · ${esc(e.ev)}` : "")}</span>
          <button type="button" class="wt-ev-fly" data-lat="${e.lat}" data-lng="${e.lng}"
            data-name="${esc(e.name)}" title="Fly to ${esc(e.name)}" aria-label="Fly to ${esc(e.name)}">🌍</button>
        </div>
        <div class="wt-ev-desc"></div>
      </div>`;
    }).join("")}</div>`;
}

/* Signed decimal degrees → a compact N/S/E/W string, e.g. "21.4°N, 89.5°W". */
function fmtLatLng(lat, lng) {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(1)}°${lng >= 0 ? "E" : "W"}`;
}

/* --- Wikipedia enrichment for events, mirroring enrichTaxa/fetchWiki below ---
 * LIPs carry a hand-pinned Wikipedia title (see LIPS above) since their short
 * display names often match the wrong page (e.g. a generic "large igneous
 * province" definition, or an unrelated place). Impact craters are reliably
 * named "X crater" on Wikipedia, so those are found via search — but a title
 * sharing no word with the event name (e.g. a "list of..." page) is discarded
 * rather than shown as a wrong description. */
function titleLooksRelevant(title, name) {
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2);
  const nameWords = new Set(words(name));
  return words(title).some((w) => nameWords.has(w));
}
const eventWikiCache = new Map();
function fetchEventWiki(name, type, pinnedTitle) {
  const key = `${type}:${name}`;
  if (eventWikiCache.has(key)) return eventWikiCache.get(key);
  const p = pinnedTitle
    ? fetchWiki(pinnedTitle)
    : fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&origin=*&srsearch=${encodeURIComponent(name + " impact crater")}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && d.query && d.query.search && d.query.search[0] && d.query.search[0].title)
        .then((title) => (title && titleLooksRelevant(title, name) ? fetchWiki(title) : null))
        .catch(() => null);
  eventWikiCache.set(key, p);
  return p;
}

let eventEnrichToken = 0;
async function enrichEvents() {
  const myToken = ++eventEnrichToken; // cancel if the time range changes mid-fetch
  const cards = [...document.querySelectorAll(".wt-event")];
  let i = 0;
  const worker = async () => {
    while (i < cards.length && myToken === eventEnrichToken) {
      const card = cards[i++];
      const info = await fetchEventWiki(card.dataset.wikiName, card.dataset.wikiType, card.dataset.wikiTitle || null);
      if (myToken !== eventEnrichToken) return;
      const d = card.querySelector(".wt-ev-desc");
      if (d && info && info.extract) d.textContent = info.extract;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

let topScaleWired = false;
function buildTopScale() {
  const host = $("timescale");
  if (!host) return;
  host.classList.remove("hidden");
  if (!topScaleWired) {
    // Open the stack on hover, close on leave with a short delay. The delay gives
    // hysteresis so a cursor resting near the bottom edge can't rapidly toggle
    // the bar open/closed (the old pure-:hover version flickered there).
    const inner = host.querySelector(".tscale-inner");
    let closeTimer = null;
    const open = () => { clearTimeout(closeTimer); host.classList.add("open"); };
    // Re-rendering the stack under the cursor (on every pick) can fire a spurious
    // mouseleave; only actually close if, after the delay, the cursor really has
    // left — otherwise picking a cell would snap the bar shut mid-drill.
    const close = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!inner.matches(":hover") && !$("ts-clear").matches(":hover")) host.classList.remove("open");
      }, 160);
    };
    // One delegated handler for every cell. A tap on the collapsed summary opens
    // the stack (touch devices have no hover); a tap on a cell picks it — and we
    // keep the bar open so you can carry on drilling deeper without re-opening.
    host.addEventListener("click", (e) => {
      const seg = e.target.closest(".ts-seg");
      if (!seg) return;
      // Picking re-renders the stack, detaching this very node; stop the event so
      // the document outside-close handler below doesn't then see a target that's
      // no longer inside #timescale and wrongly snap the bar shut.
      e.stopPropagation();
      if (seg.closest("#ts-summary")) { host.classList.toggle("open"); return; }
      if (seg.dataset.val != null) { pickInterval(seg.dataset.val); open(); }
    });
    $("ts-clear").addEventListener("click", () => { if (selectedInterval) pickInterval(""); });
    // mouseenter/leave don't fire on the pointer-events:none container, so bind to
    // the interactive children (the panel and the clear button).
    [inner, $("ts-clear")].forEach((el) => {
      el.addEventListener("mouseenter", open);
      el.addEventListener("mouseleave", close);
    });
    // On touch, a tap outside the bar closes it (hover handles this on desktop).
    document.addEventListener("click", (e) => { if (!e.target.closest("#timescale")) host.classList.remove("open"); });
    topScaleWired = true;
  }
  tmPaintRainbow(); // keep the scrubber's period colours in sync (cb mode, live data)
  syncTopScale();
}

/* Paint the time-machine track with the Phanerozoic period rainbow (oldest on
 * the left, matching the drill rows), so the playhead reads against real periods.
 * Uses a hoisted declaration so buildTopScale can call it before the time-machine
 * block below runs. */
function tmPaintRainbow() {
  const track = $("tm-track");
  if (!track) return;
  const ps = BANDS.filter((b) => b.max <= TM_MAX && b.max - b.min > 0).sort((a, b) => b.max - a.max);
  if (!ps.length) return;
  const stops = [];
  for (const p of ps) {
    const l = Math.max(0, (TM_MAX - p.max) / TM_MAX * 100);
    const r = Math.min(100, (TM_MAX - p.min) / TM_MAX * 100);
    const c = bandColor(p);
    stops.push(`${c} ${l.toFixed(2)}%`, `${c} ${r.toFixed(2)}%`);
  }
  track.style.background = `linear-gradient(to right, ${stops.join(",")})`;
}

/* Re-render the header + drill rows + summary from the current selection. Cheap;
 * called after every search and whenever the pick changes. */
function syncTopScale() {
  const stack = $("ts-stack");
  if (!stack) return;

  const sel = selectedInterval ? intByName(selectedInterval) : null;
  // Names along the selection's lineage, so ancestors of the pick get an in-path
  // marker even though only the pick itself is the strong-outlined "selected".
  const active = new Set();
  for (let it = sel; it; it = it.parent != null ? intById.get(it.parent) : null) active.add(it.name);

  // A row dims its off-path cells only when it actually contains the chosen
  // interval at that level — the deepest (frontier) row, whose options aren't
  // chosen yet, stays fully lit.
  const dimRow = (nodes) => nodes.some((n) => active.has(n.name));

  const eons = precambrianEons();
  const eras = scaleOfType("era");
  // Header: a single eon/era row. Precambrian eons are compressed to a fixed
  // share so they don't crush the proportional eras.
  const headerNodes = [...eons, ...eras];
  const headerDim = dimRow(headerNodes);
  const dur = (n) => n.max - n.min;
  let html = tsRowHtml("Eon · Era",
    tsBar(headerNodes, active, headerDim, (n) => n.type === "eon" ? PRECAMBRIAN_EON_FLEX : dur(n)));

  // Drill rows: the selected eon/era's periods, then its epochs, then its ages —
  // only the chosen branch, each row zoomed to fill the width.
  if (sel) {
    for (const node of drillNodes(sel)) {
      if (node.children && node.children.length) {
        // Oldest on the left, matching the header (the tree keeps them youngest-
        // first, so sort a copy rather than disturbing it).
        const kids = [...node.children].sort((a, b) => b.max - a.max);
        const lvl = kids[0].type;
        const label = (lvl[0].toUpperCase() + lvl.slice(1)) + "s · " + node.name;
        html += tsRowHtml(label, tsBar(kids, active, dimRow(kids), dur));
      }
    }
  }
  stack.innerHTML = html;

  $("ts-summary").innerHTML = tsSummaryHtml();
  $("ts-clear").classList.toggle("hidden", !selectedInterval);
  renderPaleoclimate();        // air & climate for the current time context
  if (typeof updateEventRings === "function") updateEventRings(); // impact/LIP rings track the span
  if (typeof renderFilterChips === "function") renderFilterChips(); // keep the chip bar in sync
}
buildTopScale(); // draw from the built-in periods immediately; refined once the live scale loads

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
    if (periods.length) { BANDS = periods; buildLegend(); buildTopScale(); recolorPoints(); }
  } catch (e) { /* offline — keep the built-in periods */ }
}

function recolorPoints() {
  const recs = globe.pointsData();
  if (!recs.length) return;
  for (const r of recs) r.color = colorForAge(+r.eag || 0);
  globe.pointColor(globe.pointColor()); // re-trigger the colour accessor
}

/* ---- interval selection (driven by the top timescale strip) ----
 * The timescale at the top of the page is now the only interval picker; these
 * helpers hold the shared selection state it (and saved searches, samples, the
 * time machine) read and write. */

/* Full ancestry of a named interval, e.g. "Phanerozoic › Mesozoic › Cretaceous",
 * used for the summary tooltip. */
function intervalPath(name) {
  let it = INTERVALS.find((x) => x.name === name);
  const names = [];
  while (it) { names.unshift(it.name); it = it.parent != null ? intById.get(it.parent) : null; }
  return names.join(" › ");
}

/* Choose an interval (or clear it with ""), then re-run the search. The custom
 * range / time machine write into f-maxma/f-minma, which override any interval in
 * search(); picking an interval is an explicit choice to use it, so clear that
 * range and halt any running sweep. The time-machine playhead is parked at the
 * pick's midpoint so it reflects where you are, and the top timescale updates. */
function pickInterval(name) {
  selectedInterval = name;
  $("f-maxma").value = ""; $("f-minma").value = "";
  if (typeof tmStop === "function") tmStop();
  const it = name ? intByName(name) : null;
  if (it && typeof tmSetAge === "function") tmSetAge((it.max + it.min) / 2);
  syncTopScale();
  search();
}

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
    syncTopScale(); // reflect the active interval on the top timescale
    addNeotomaSites(recs); // supplement with Quaternary sites (best-effort, async)

    const shown = recs.length;
    const noun = shown === 1 ? "locality" : "localities";
    const capped = shown >= +limit ? ` (capped at ${limit} — narrow your filters for more)` : "";
    setStatus(`${shown.toLocaleString()} ${noun}${capped}`, shown ? "" : "err");
    if (!shown) setStatus("No localities matched. Try a broader taxon or age.", "err");
    $("btn-download").disabled = !shown;
    $("f-export").disabled = !shown;
    $("results-empty").classList.toggle("hide", shown > 0); // drop the placeholder once there are results
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

/* Plate-boundary overlay — tectonic plate boundaries (ridges, trenches, faults)
 * from the GPlates topological model, drawn as bright lines lifted just above the
 * surface. Shows today's plates on the modern globe, or the reconstructed
 * boundaries for the age in ancient-Earth mode. */
globe.pathPointLat((p) => p[0]).pathPointLng((p) => p[1]).pathPointAlt(0.012)
  .pathColor(() => "#ffd24a")
  .pathStroke(1.6).pathDashLength(0.02).pathDashGap(0.012)
  .pathDashAnimateTime(0).pathTransitionDuration(0);

const GPLATES_BOUNDS = "https://gws.gplates.org/topology/plate_boundaries";
const TOPO_MODEL = "MERDITH2021"; // a full topological model (0–1000 Ma)
const topoCache = new Map();
const geomToPaths = (g) => {
  const out = [];
  if (!g) return out;
  const flip = (line) => line.map(([lng, lat]) => [lat, lng]);
  if (g.type === "LineString") out.push(flip(g.coordinates));
  else if (g.type === "MultiLineString") for (const l of g.coordinates) out.push(flip(l));
  else if (g.type === "Polygon") for (const r of g.coordinates) out.push(flip(r));
  else if (g.type === "MultiPolygon") for (const p of g.coordinates) for (const r of p) out.push(flip(r));
  return out;
};
// The topology service recomputes per age and is often slow (several seconds), so
// this is best-effort: snap to round ages (better cache hits), time out hard so a
// slow response never blocks the globe, and don't cache failures (retry later).
function fetchPlateBoundaries(age) {
  const key = Math.round(age / 10) * 10;
  if (topoCache.has(key)) return topoCache.get(key);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  const p = fetch(`${GPLATES_BOUNDS}?time=${key}&model=${TOPO_MODEL}`, { signal: ac.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d || !d.features) return null;
      const paths = [];
      for (const ft of d.features) paths.push(...geomToPaths(ft.geometry));
      return paths.length ? paths : null;
    })
    .catch(() => null)
    .finally(() => clearTimeout(timer));
  topoCache.set(key, p);
  p.then((v) => { if (!v) topoCache.delete(key); }); // allow a retry if it failed
  return p;
}
const platesOn = () => $("f-plates") && $("f-plates").checked;
let platesReqKey = -1;
async function updatePlateBoundaries() {
  if (!platesOn()) { globe.pathsData([]); return; }
  const age = usePaleo ? Math.min(PALEO_MAX_MA, paleoAgeMa()) : 0;
  const key = Math.round(age / 10) * 10;
  platesReqKey = key;
  if (!topoCache.has(key)) flash(`Loading plate boundaries ~${fmtMa(age)} Ma…`);
  const paths = await fetchPlateBoundaries(age);
  // Apply unless the toggle was turned off or a *different* age was requested since.
  if (!platesOn() || platesReqKey !== key) return;
  globe.pathsData(paths || []);
  if (!paths) flash("Plate boundaries unavailable right now — try again in a moment.");
}

/* Event rings — impacts (☄) and large igneous provinces (🌋) within the selected
 * span, pulsed at their *modern* coordinates (so only shown on the modern globe,
 * not the paleo reconstruction where positions would be wrong). */
globe.ringColor((d) => (t) => d._type === "impact"
  ? `rgba(255,80,60,${(1 - t) * 0.9})` : `rgba(255,160,40,${(1 - t) * 0.9})`)
  .ringMaxRadius((d) => d._type === "impact" ? 2.4 : 3.2)
  .ringPropagationSpeed(1.4).ringRepeatPeriod(1500).ringAltitude(0.012);
function updateEventRings() {
  if (usePaleo) { globe.ringsData([]); return; }
  const evs = eventsInSpan(currentSpanMa()).filter((e) => e.ma <= 545);
  globe.ringsData(evs.map((e) => ({ lat: e.lat, lng: e.lng, _type: e.type, name: e.name })));
}

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
    return;
  }
  globe.pointsData([]);
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
  updatePlateBoundaries(); // tectonic plate overlay (paleo only; checks its toggle)
  updateEventRings();      // impact/LIP rings (modern only)
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
/* Every collection (point) plotted at the same coordinates as `d` — different
 * beds, ages or studies recorded at one site. Lets you browse them inline rather
 * than opening each from an external page. */
function collectionsAtSite(d) {
  const key = (r) => `${(+r._mlat).toFixed(3)},${(+r._mlng).toFixed(3)}`;
  const k = key(d);
  return currentRecs.filter((r) => key(r) === k);
}

let openToken = 0;
async function openLocality(d) {
  if (d._src === "neotoma") { openNeotomaSite(d); return; }
  const panel = $("detail");
  const body = $("detail-body");
  panel.classList.remove("hidden");
  $("timescale").classList.add("detail-open"); // make room so the panel doesn't cover the strip
  $("layers-btn").classList.add("detail-open"); // ...and so the layers button stays reachable
  $("layers-pop").classList.add("detail-open");
  const myToken = ++openToken;

  const collNo = String(d.oid || "").replace(/\D/g, "");
  const place = [d.stp, countryName(d.cc2)].filter(Boolean).join(", ");
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${d._mlat},${d._mlng}`;

  // Other collections plotted at this exact spot — show them as an inline,
  // switchable list so the various collections at the point can be browsed here.
  const site = collectionsAtSite(d);
  const siteHtml = site.length > 1 ? `
    <div class="site-colls">
      <div class="site-colls-head">${site.length} collections at this site — tap to view</div>
      <div class="site-colls-list">
        ${site.map((r) => {
          const cur = String(r.oid) === String(d.oid);
          return `<button type="button" class="coll-row${cur ? " on" : ""}" data-oid="${esc(String(r.oid))}">
            <span class="coll-dot" style="background:${r.color}"></span>
            <span class="coll-nm">${esc(r.nam || "Unnamed collection")}</span>
            <span class="coll-age" style="color:${r.color}">${esc(r.oei || fmtAge(r.eag, r.lag))}</span></button>`;
        }).join("")}
      </div>
    </div>` : "";

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
    ${siteHtml}
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

/* Detail view for a Neotoma site (Quaternary). Its taxa came back with the
 * search, so they're shown inline; the Explorer link is for digging deeper. */
function openNeotomaSite(d) {
  const panel = $("detail"), body = $("detail-body");
  panel.classList.remove("hidden");
  $("timescale").classList.add("detail-open");
  $("layers-btn").classList.add("detail-open");
  $("layers-pop").classList.add("detail-open");
  ++openToken;
  const taxa = [...(d._ntaxa || [])].sort((a, b) => a.localeCompare(b));
  const types = [...(d._ntypes || [])];
  const siteid = String(d.oid).replace("neo:", "");
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${d._mlat},${d._mlng}`;
  body.innerHTML = `
    <h2>${esc(d.nam)}</h2>
    <div class="chips">
      <span class="chip age" style="border-color:${d.color};color:${d.color}">${esc(types.join(", ") || "Neotoma site")}</span>
      <span class="chip">${fmtAge(d.eag, d.lag)}</span>
    </div>
    <div class="meta">
      <b>Source:</b> ${esc(d._ndb || "Neotoma")} · Quaternary record<br/>
      <b>Coordinates:</b> ${d._mlat.toFixed(3)}, ${d._mlng.toFixed(3)}
    </div>
    <div class="chips">
      <a class="chip" target="_blank" rel="noopener" href="${mapsHref}">📍 Google Maps</a>
      <a class="chip" target="_blank" rel="noopener" href="https://apps.neotomadb.org/explorer/?siteids=${siteid}">🗺 Neotoma Explorer</a>
    </div>
    <div class="taxa-head"><h3>Taxa recorded here</h3><span class="count">${taxa.length}</span></div>
    <div id="taxa-list">${taxa.length
      ? `<ul class="neo-taxa">${taxa.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
      : `<div class="loading-row">No taxa listed for this site.</div>`}</div>`;
}

/* Supplement the PBDB results with Quaternary records from the Neotoma
 * Paleoecology Database (open, CORS) — pollen, mammals, beetles, etc. — which is
 * where the very recent past is rich and PBDB is sparse. Grouped to one point per
 * site, bounded to the current view, and only when the span reaches the
 * Quaternary. Fired after a search; appends to whatever that search plotted. */
let neoToken = 0;
async function addNeotomaSites(baseRecs) {
  if (!$("f-neotoma") || !$("f-neotoma").checked) return;
  const [min, max] = currentSpanMa();
  if (min > 2.6) return; // Neotoma only covers the Quaternary
  const my = ++neoToken;
  const ageYoung = Math.max(0, Math.round(min * 1e6));
  const ageOld = Math.max(ageYoung + 1, Math.round(Math.min(max, 2.6) * 1e6));
  const params = new URLSearchParams({ ageyoung: String(ageYoung), ageold: String(ageOld), limit: "5000" });
  const bbox = currentViewBbox();
  if (bbox) params.set("loc", JSON.stringify({ type: "Polygon", coordinates: [[
    [bbox.lngmin, bbox.latmin], [bbox.lngmax, bbox.latmin], [bbox.lngmax, bbox.latmax],
    [bbox.lngmin, bbox.latmax], [bbox.lngmin, bbox.latmin]]] }));
  try {
    const r = await fetch(`https://api.neotomadb.org/v2.0/data/occurrences?${params}`);
    const j = await r.json();
    if (my !== neoToken || currentRecs !== baseRecs) return; // a newer search/toggle superseded us
    const sites = new Map();
    const curR = radiusForAltitude(globe.pointOfView().altitude);
    for (const o of (j.data || [])) {
      const s = o.site; if (!s || !s.location) continue;
      let c; try { c = JSON.parse(s.location).coordinates; } catch (_) { continue; }
      while (Array.isArray(c) && Array.isArray(c[0])) c = c[0]; // drill Polygon/Multi rings to a vertex
      if (!Array.isArray(c) || !isFinite(+c[0]) || !isFinite(+c[1])) continue;
      let rec = sites.get(s.siteid);
      if (!rec) {
        const ageMa = (o.age && o.age.age != null ? +o.age.age : 0) / 1e6;
        rec = { _src: "neotoma", oid: "neo:" + s.siteid, nam: s.sitename || "Neotoma site",
          _mlat: +c[1], _mlng: +c[0], _plat: null, _plng: null,
          eag: ageMa, lag: ageMa, oei: "", color: colorForAge(ageMa), _r: curR,
          env: "", cc2: "", sfm: "", _ntaxa: new Set(), _ntypes: new Set(), _ndb: s.database || "" };
        sites.set(s.siteid, rec);
      }
      if (o.sample && o.sample.taxonname) rec._ntaxa.add(o.sample.taxonname);
      if (s.datasettype) rec._ntypes.add(s.datasettype);
    }
    const neo = [...sites.values()];
    if (!neo.length) return;
    currentRecs = baseRecs.concat(neo);
    applyCoords(currentRecs);
    applyLayerMode();
    flash(`+${neo.length.toLocaleString()} Quaternary site${neo.length > 1 ? "s" : ""} from Neotoma`);
  } catch (e) { /* silent — Neotoma is a best-effort supplement */ }
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
  e.preventDefault(); taxonPicker.hide(); excludePicker.hide(); showTab("results"); search();
});
$("btn-clear").addEventListener("click", () => {
  $("f-taxon").value = ""; $("f-exclude").value = ""; $("f-formation").value = "";
  excludes = []; renderExcludeChips();
  selectedInterval = "";
  $("f-maxma").value = ""; $("f-minma").value = ""; $("f-env").value = "";
  setRegion("");
  $("f-view").checked = false;
  $("btn-download").disabled = true; $("f-export").disabled = true;
  buildLegend();
  if (typeof tmStop === "function") tmStop();
  currentTaxon = ""; updateTaxonInfo("");
  currentRecs = [];
  globe.pointsData([]); globe.hexBinPointsData([]);
  setStatus("");
  syncTopScale(); // reflect the cleared interval on the top timescale
  writeHash();
});
$("btn-download").addEventListener("click", exportResults);
$("detail-close").addEventListener("click", () => {
  $("detail").classList.add("hidden");
  $("timescale").classList.remove("detail-open");
  $("layers-btn").classList.remove("detail-open");
  $("layers-pop").classList.remove("detail-open");
});
// Switch the detail view to another collection at the same site (inline browse).
$("detail").addEventListener("click", (e) => {
  const row = e.target.closest(".coll-row[data-oid]");
  if (row) {
    if (row.classList.contains("on")) return;
    const rec = currentRecs.find((r) => String(r.oid) === row.dataset.oid);
    if (rec) openLocality(rec);
    return;
  }
  // Tapping a taxon card's blurb expands it to the full Wikipedia extract.
  const desc = e.target.closest(".tx-desc");
  if (desc) desc.classList.toggle("expanded");
});
$("panel-toggle").addEventListener("click", () => $("panel").classList.remove("collapsed"));
$("panel-close").addEventListener("click", () => $("panel").classList.add("collapsed"));

/* ----- Search / Results tabs ----- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  $("tab-search").classList.toggle("on", name === "search");
  $("tab-results").classList.toggle("on", name === "results");
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab"); if (t) showTab(t.dataset.tab);
});

/* ----- Map & layers popover (display options live off the globe now) ----- */
const layersBtn = $("layers-btn"), layersPop = $("layers-pop");
layersBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const nowHidden = layersPop.classList.toggle("hidden");
  layersBtn.classList.toggle("on", !nowHidden);
});
document.addEventListener("click", (e) => {
  if (!layersPop.classList.contains("hidden") &&
      !e.target.closest("#layers-pop") && !e.target.closest("#layers-btn")) {
    layersPop.classList.add("hidden"); layersBtn.classList.remove("on");
  }
});

/* ----- Active-filter chips: the live query as removable pills ----- */
function renderFilterChips() {
  const box = $("filter-chips"); if (!box) return;
  const chips = [];
  const taxon = $("f-taxon").value.trim();
  if (taxon) chips.push({ k: "Taxon", v: taxon, clear: "taxon" });
  for (const x of excludes) chips.push({ k: "Exclude", v: x, clear: "exclude:" + x });
  const mx = $("f-maxma").value, mn = $("f-minma").value;
  if (mx || mn) chips.push({ k: "Time", v: `${mx || "0"}–${mn || "0"} ${$("f-unit").value}`, clear: "range" });
  else if (selectedInterval) chips.push({ k: "Time", v: selectedInterval, clear: "interval" });
  if (selectedRegion) chips.push({ k: "Region", v: $("f-region").value || selectedRegion, clear: "region" });
  const fm = $("f-formation").value.trim();
  if (fm) chips.push({ k: "Formation", v: fm, clear: "formation" });
  if ($("f-env").value) chips.push({ k: "Env", v: $("f-env").selectedOptions[0].text, clear: "env" });
  box.innerHTML = chips.map((c) =>
    `<span class="fchip"><span class="k">${esc(c.k)}:</span> ${esc(c.v)}<button type="button" aria-label="Remove" data-clear="${esc(c.clear)}">✕</button></span>`).join("");
}
$("filter-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-clear]"); if (!b) return;
  const c = b.dataset.clear;
  if (c === "interval") { pickInterval(""); return; } // re-runs search itself
  if (c === "taxon") { $("f-taxon").value = ""; currentTaxon = ""; updateTaxonInfo(""); }
  else if (c.startsWith("exclude:")) { excludes = excludes.filter((x) => x !== c.slice(8)); renderExcludeChips(); }
  else if (c === "range") { $("f-maxma").value = ""; $("f-minma").value = ""; }
  else if (c === "region") { setRegion(""); }
  else if (c === "formation") { $("f-formation").value = ""; }
  else if (c === "env") { $("f-env").value = ""; }
  search();
});

$("f-paleo").addEventListener("change", (e) => {
  usePaleo = e.target.checked;
  applyCoords(currentRecs);
  applyLayerMode();
  updatePaleoGlobe();
  writeHash();
});
$("f-plates").addEventListener("change", updatePlateBoundaries);
$("f-neotoma").addEventListener("change", () => search()); // re-run to add/remove the supplement
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
  syncTopScale(); // reflect the restored interval on the top timescale
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
const tmTrack = $("tm-track"), tmKnob = $("tm-knob"), tmBand = $("tm-band"),
  tmLabel = $("tm-label"), tmPlay = $("tm-play");
let tmPlaying = false, tmToken = 0, tmTimer = null, tmDragging = false;
let tmAgeMa = 100; // the playhead's current age, in Ma
const tmAge = () => tmAgeMa;

/* Move the playhead to an age and refresh the knob + label (oldest on the left,
 * matching the rainbow: age TM_MAX → 0%, age 0 → 100%). */
function tmSetAge(ma) {
  tmAgeMa = Math.min(TM_MAX, Math.max(0, Math.round(ma)));
  tmKnob.style.left = ((TM_MAX - tmAgeMa) / TM_MAX * 100).toFixed(2) + "%";
  const b = bandFor(tmAgeMa);
  tmLabel.textContent = `${tmAgeMa} Ma${b ? " · " + b.name : ""}`;
  renderPaleoclimate(tmAgeMa); // live air/climate readout as the playhead moves
}
async function tmApply() {
  const age = tmAge(), half = +tmBand.value;
  $("f-unit").value = "Ma";
  $("f-maxma").value = Math.round(age + half);
  $("f-minma").value = Math.max(0, Math.round(age - half));
  selectedInterval = ""; // a custom range overrides any interval pick
  await search();         // re-runs syncTopScale, so the summary shows the window
}
function tmOnInput() {
  clearTimeout(tmTimer);
  tmTimer = setTimeout(tmApply, 250); // debounce while dragging
}
function tmStop() { tmPlaying = false; tmToken++; tmPlay.textContent = "▶"; tmPlay.classList.remove("on"); }
async function tmPlayLoop() {
  const my = ++tmToken;
  tmPlaying = true; tmPlay.textContent = "⏸"; tmPlay.classList.add("on");
  if (!usePaleo) { usePaleo = true; $("f-paleo").checked = true; } // watch continents move
  if (tmAge() < 20) tmSetAge(TM_MAX);                              // start from the deep past
  while (tmPlaying && my === tmToken && tmAge() > 0) {
    await tmApply();
    if (my !== tmToken) return;
    tmSetAge(Math.max(0, tmAge() - +tmBand.value));
    await new Promise((r) => setTimeout(r, 450));
  }
  if (my === tmToken) { await tmApply(); tmStop(); }
}

// Drag (or click) the track to scrub. Pointer capture keeps the drag alive even
// when the cursor leaves the thin track vertically.
const tmAgeFromX = (clientX) => {
  const r = tmTrack.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return TM_MAX * (1 - frac);
};
tmTrack.addEventListener("pointerdown", (e) => {
  if (tmPlaying) tmStop();
  tmDragging = true;
  tmTrack.setPointerCapture(e.pointerId);
  tmSetAge(tmAgeFromX(e.clientX)); tmOnInput();
});
tmTrack.addEventListener("pointermove", (e) => {
  if (!tmDragging) return;
  tmSetAge(tmAgeFromX(e.clientX)); tmOnInput();
});
const tmEndDrag = (e) => { if (tmDragging) { tmDragging = false; try { tmTrack.releasePointerCapture(e.pointerId); } catch (_) {} } };
tmTrack.addEventListener("pointerup", tmEndDrag);
tmTrack.addEventListener("pointercancel", tmEndDrag);
tmPlay.addEventListener("click", () => (tmPlaying ? tmStop() : tmPlayLoop()));
tmBand.addEventListener("change", () => tmSetAge(tmAgeMa));
tmSetAge(tmAgeMa);

/* Point the time machine at a specific age span (from a ⏳ icon next to any
 * displayed date range): set the custom range, move the playhead, and re-search. */
function applyTimeRange(maxMa, minMa) {
  if (tmPlaying) tmStop();
  $("f-unit").value = "Ma";
  $("f-maxma").value = maxMa;
  $("f-minma").value = minMa;
  selectedInterval = ""; // a custom range overrides any interval pick
  tmSetAge((maxMa + minMa) / 2);
  // Snap the window selector to the nearest preset for a tidy follow-on ▶ sweep.
  const half = (maxMa - minMa) / 2;
  const presets = [...tmBand.options].map((o) => +o.value);
  tmBand.value = String(presets.reduce((a, b) => Math.abs(b - half) < Math.abs(a - half) ? b : a));
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
async function flyToPlace() {
  const q = $("f-place").value.trim();
  if (!q) return;
  flash(`Finding “${q}”…`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000); // don't hang on a slow/throttled lookup
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { "Accept-Language": "en" }, signal: ac.signal });
    const hit = (await res.json())[0];
    if (!hit) { flash(`No place found for “${q}”.`); return; }
    globe.controls().autoRotate = false;
    globe.pointOfView({ lat: +hit.lat, lng: +hit.lon, altitude: 1.1 }, 1200);
    flash(`📍 ${(hit.display_name || q).split(",").slice(0, 2).join(",")}`);
  } catch (err) {
    flash("Couldn’t reach the place finder — try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
}
// Enter (desktop), the mobile keyboard's "go/search" key, and a tap-able button —
// phones don't reliably send Enter, so the button is the dependable trigger.
$("f-place").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); flyToPlace(); } });

// The 🌍 button on each "events around this time" row flies the globe there
// (the row's title attribute carries type/age/coordinates); tapping the
// Wikipedia blurb below it expands the clamped text, same as taxon cards.
$("paleoclimate").addEventListener("click", (e) => {
  const btn = e.target.closest(".wt-ev-fly");
  if (btn) {
    globe.controls().autoRotate = false;
    globe.pointOfView({ lat: +btn.dataset.lat, lng: +btn.dataset.lng, altitude: 1.1 }, 1200);
    flash(`🌍 ${btn.dataset.name}`);
    return;
  }
  const desc = e.target.closest(".wt-ev-desc");
  if (desc) desc.classList.toggle("expanded");
});
$("f-place").addEventListener("search", flyToPlace);
$("btn-place").addEventListener("click", flyToPlace);

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
  showTab("results");
  search();
});
buildSamples();

/* =========================================================================
 * Remaining wiring — interactive legend, colour & density toggles, buttons.
 * ========================================================================= */
$("f-cb").addEventListener("change", (e) => {
  cbSafe = e.target.checked;
  buildLegend(); buildTopScale(); recolorPoints();
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
  }
  if (usePaleo) updatePaleoGlobe();
  search(); // re-runs syncTopScale, reflecting the selected interval up top
})();

/* On phones, start with the panel tucked away so the globe is the hero;
 * the ☰ button reopens it. */
if (window.matchMedia("(max-width: 640px)").matches) $("panel").classList.add("collapsed");
