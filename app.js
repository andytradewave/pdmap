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
const colorForAge = (ma) => {
  const p = BANDS.find((p) => ma <= p.max && ma > p.min);
  return p ? p.color : "#9a8aa0";
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
  .pointColor((d) => d.color)
  .pointAltitude(0.01)
  .pointRadius((d) => d._r || 0.22)
  .pointLabel(pointLabel)
  .onPointClick(openLocality)
  .pointsTransitionDuration(0);

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

function setStatus(msg, cls = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + cls;
}

/* -------------------------------------------------------- Build controls --- */
function buildLegend() {
  const ul = $("legend-list");
  ul.innerHTML = "";
  // Youngest at the top, like a stratigraphic column read from the surface down.
  for (const p of [...BANDS].sort((a, b) => a.min - b.min)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch" style="background:${p.color}"></span>
      ${esc(p.name)}<span class="age">${fmtMa(p.max)}–${fmtMa(p.min)}</span>`;
    ul.appendChild(li);
  }
}

/* ----------------------------------------------- Geological timescale --- */
/* Full ICS timescale (eons → eras → periods → epochs → ages), fetched live
 * from PBDB so the interval names line up exactly with what the API accepts.
 * Falls back to the built-in PERIODS list if we're offline. */
const LEVELS = ["eon", "era", "period", "epoch", "age"];
let INTERVALS = PERIODS.map((p) => // sensible offline default
  ({ name: p.name, type: "period", max: p.max, min: p.min, color: p.color }));
let selectedInterval = "";

const fmtMa = (v) => v == null ? "?" :
  +v === 0 ? "0" :
  v >= 10 ? String(Math.round(v)) :
  v >= 1 ? (+v).toFixed(1) :
  v >= 0.01 ? (+v).toFixed(3) : (+v).toFixed(4);

buildLegend(); // draw the offline fallback legend immediately

async function loadTimescale() {
  try {
    const res = await fetch(`${PBDB}/intervals/list.json?scale=1&vocab=pbdb`);
    const recs = (await res.json()).records || [];
    if (!recs.length) return;
    INTERVALS = recs
      .filter((r) => LEVELS.includes(r.type))
      .map((r) => ({ name: r.interval_name, type: r.type,
        max: +r.b_age, min: +r.t_age, color: r.color || "#9a8aa0" }));
    // Colour points and the legend from every period now available, so anything
    // back to the Hadean gets its proper ICS colour instead of falling to grey.
    const periods = INTERVALS.filter((it) => it.type === "period");
    if (periods.length) { BANDS = periods; buildLegend(); recolorPoints(); }
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

function intSync() {
  intItems = [...intBox.querySelectorAll(".opt")].map((el) => el.dataset.val);
  intActive = -1;
}
function intShow() { intBox.classList.remove("hidden"); }
function intHide() { intBox.classList.add("hidden"); intActive = -1; }

function intRender(q) {
  const ql = q.trim().toLowerCase();
  let list = INTERVALS;
  if (ql) list = INTERVALS.filter((it) => it.name.toLowerCase().includes(ql));
  else list = INTERVALS.filter((it) => it.type === "era" || it.type === "period"); // quick picks
  // A persistent "all of time" reset at the very top of the unfiltered list.
  const anyRow = ql ? "" :
    `<div class="opt" data-val=""><span class="nm">Any time</span>
       <span class="lvl">all ages</span></div>`;
  intBox.innerHTML = anyRow + (list.length ? intGrouped(list)
    : `<div class="grp">No interval matches “${esc(q)}”</div>`);
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

function pickInterval(name) {
  selectedInterval = name;
  intInput.value = name;
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
  intRender(intInput.value);
});
intInput.addEventListener("focus", () => intRender(intInput.value));
intInput.addEventListener("keydown", (e) => {
  if (intBox.classList.contains("hidden")) return;
  if (e.key === "ArrowDown") { e.preventDefault(); intSetActive(intActive + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); intSetActive(intActive - 1); }
  else if (e.key === "Enter" && intActive >= 0) { e.preventDefault(); pickInterval(intItems[intActive]); }
  else if (e.key === "Escape") { intHide(); }
});
intBox.addEventListener("mousedown", (e) => {
  const opt = e.target.closest(".opt");
  if (opt) { e.preventDefault(); pickInterval(opt.dataset.val); }
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

let currentTaxon = ""; // remembered so locality detail can float matches to the top

async function search() {
  const taxon = $("f-taxon").value.trim();
  const maxma = $("f-maxma").value.trim();
  const minma = $("f-minma").value.trim();
  const env = $("f-env").value;
  const limit = $("f-limit").value;
  currentTaxon = taxon;

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

  const params = new URLSearchParams();
  params.set("show", "loc,time,paleoloc");
  params.set("limit", limit);
  if (taxon) params.set("base_name", taxon);

  // Convert the custom range to Ma based on the chosen units (Ma / ka / years),
  // so "the last few thousand years" is just as easy as "the Jurassic".
  const unit = $("f-unit").value;
  const toMa = (v) => unit === "yr" ? v / 1e6 : unit === "ka" ? v / 1e3 : v;
  if (maxma || minma) {
    if (maxma) params.set("max_ma", toMa(+maxma));
    if (minma) params.set("min_ma", toMa(+minma));
  } else if (selectedInterval) {
    params.set("interval", selectedInterval);
  }
  if (env) params.set("envtype", env);

  if ($("f-view").checked) {
    const b = currentViewBbox();
    if (b) {
      params.set("latmin", b.latmin.toFixed(3));
      params.set("latmax", b.latmax.toFixed(3));
      params.set("lngmin", b.lngmin.toFixed(3));
      params.set("lngmax", b.lngmax.toFixed(3));
    }
  }

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
    globe.pointsData(recs);
    if (usePaleo) updatePaleoGlobe(); // refresh the reconstruction for the new age

    const shown = recs.length;
    const noun = shown === 1 ? "locality" : "localities";
    const capped = shown >= +limit ? ` (capped at ${limit} — narrow your filters for more)` : "";
    setStatus(`${shown.toLocaleString()} ${noun}${capped}`, shown ? "" : "err");
    if (!shown) setStatus("No localities matched. Try a broader taxon or age.", "err");
    $("btn-download").disabled = !shown;
  } catch (e) {
    setStatus("Error: " + e.message, "err");
  } finally {
    $("btn-search").disabled = false;
  }
}

/* ------------------------------------------------------------- Download --- */
/* Export whatever is currently plotted as CSV — opens straight into Excel /
 * Sheets, with both modern and paleo coordinates kept. */
function downloadResults() {
  const recs = globe.pointsData();
  if (!recs.length) return;
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
  const rows = [cols.map((c) => c[0]).join(",")];
  for (const r of recs) rows.push(cols.map((c) => cell(c[1](r))).join(","));

  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pdmap-${(currentTaxon || "localities").replace(/\W+/g, "_").toLowerCase()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
const GPLATES = "https://gws.gplates.org/reconstruct/coastlines/";
const PALEO_MODEL = "MERDITH2021"; // plate model spanning 0–1000 Ma
const PALEO_MAX_MA = 1000;
const paleoCache = new Map(); // rounded age (Ma) -> Promise<features|null>

globe.polygonGeoJsonGeometry((d) => d.geometry)
  .polygonAltitude(0.004)
  .polygonCapColor(() => "rgba(104, 116, 82, 0.95)")
  .polygonSideColor(() => "rgba(60, 66, 48, 0.5)")
  .polygonStrokeColor(() => "#2b3220")
  .polygonsTransitionDuration(0);

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
async function updatePaleoGlobe() {
  const note = $("paleo-note");
  if (!usePaleo) {
    globe.polygonsData([]);
    globe.globeMaterial().color.set(0xffffff); // stop tinting the restored texture
    setBaseLayer($("f-base").value);
    note.classList.add("hidden");
    return;
  }
  const myToken = ++paleoToken;
  const age = paleoAgeMa();
  const clamped = Math.min(PALEO_MAX_MA, Math.max(0, age));
  // Turn the surface into a plain ocean and drop the modern imagery.
  globe.globeTileEngineUrl(null).globeImageUrl(null).bumpImageUrl(null);
  globe.globeMaterial().color.set(0x12354f);
  note.classList.remove("hidden");
  note.textContent = `Reconstructing continents ~${fmtMa(clamped)} Ma…`;
  const feats = await fetchPaleoCoastlines(clamped);
  if (myToken !== paleoToken) return; // a newer request superseded this one
  if (feats) {
    globe.polygonsData(feats);
    note.textContent = `Ancient Earth ~${fmtMa(clamped)} Ma · ${feats.length} landmasses (GPlates ${PALEO_MODEL}).`;
  } else {
    globe.polygonsData([]);
    note.textContent = age > PALEO_MAX_MA
      ? `No continent reconstruction beyond ${PALEO_MAX_MA} Ma — plotting paleo-coordinates only.`
      : "Couldn't load the paleogeographic map — plotting paleo-coordinates only.";
  }
}

/* -------------------------------------------------- Locality detail view --- */
async function openLocality(d) {
  const panel = $("detail");
  const body = $("detail-body");
  panel.classList.remove("hidden");

  const collNo = String(d.oid || "").replace(/\D/g, "");
  const place = [d.stp, countryName(d.cc2)].filter(Boolean).join(", ");
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${d._mlat},${d._mlng}`;

  body.innerHTML = `
    <h2>${esc(d.nam || "Unnamed locality")}</h2>
    <div class="chips">
      <span class="chip age" style="border-color:${d.color};color:${d.color}">
        ${esc(d.oei || "")}${d.oli && d.oli !== d.oei ? "–" + esc(d.oli) : ""}</span>
      <span class="chip">${fmtAge(d.eag, d.lag)}</span>
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
    <div class="taxa-head"><h3>Fossils found here</h3><span class="count" id="taxa-count"></span></div>
    <div id="taxa-list"><div class="loading-row">Loading taxa…</div></div>`;

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

/* Minimal ISO-3166 lookup for the common codes PBDB returns. */
const COUNTRIES = { US: "USA", CA: "Canada", GB: "UK", AU: "Australia", CN: "China",
  RU: "Russia", AR: "Argentina", DE: "Germany", FR: "France", ES: "Spain", IT: "Italy",
  MX: "Mexico", BR: "Brazil", ZA: "South Africa", IN: "India", MN: "Mongolia",
  MA: "Morocco", EG: "Egypt", PL: "Poland", SE: "Sweden", NO: "Norway", JP: "Japan",
  NZ: "New Zealand", CL: "Chile", BO: "Bolivia", PE: "Peru", KZ: "Kazakhstan" };
const countryName = (cc) => COUNTRIES[cc] || cc || "";

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

const taxonInput = $("f-taxon");
const suggestBox = $("taxon-suggest");
let acItems = [];     // current option values, in display order
let acActive = -1;    // keyboard-highlighted index
let acTimer = null;

const optRow = (name, rank, count) =>
  `<div class="opt" data-val="${esc(name)}">
     <span class="nm">${esc(name)}</span>
     ${rank ? `<span class="rk">${esc(rank)}</span>` : ""}
     ${count ? `<span class="ct">${count}</span>` : ""}
   </div>`;

function syncAcItems() {
  acItems = [...suggestBox.querySelectorAll(".opt")].map((el) => el.dataset.val);
  acActive = -1;
}
function showSuggest() { suggestBox.classList.remove("hidden"); }
function hideSuggest() { suggestBox.classList.add("hidden"); acActive = -1; }

function showPopular() {
  suggestBox.innerHTML = POPULAR.map((g) =>
    `<div class="grp">${esc(g.group)}</div>` + g.items.map((n) => optRow(n)).join("")
  ).join("");
  syncAcItems();
  showSuggest();
}

let acReq = 0;
async function liveSuggest(q) {
  const myReq = ++acReq;
  try {
    const res = await fetch(`${PBDB}/taxa/auto.json?name=${encodeURIComponent(q)}&limit=10`);
    if (myReq !== acReq) return; // a newer keystroke superseded this response
    const recs = (await res.json()).records || [];
    // Collapse the duplicate entries PBDB returns for one clade — e.g. "Dinosauria"
    // recorded at six ranks. We key on name + occurrence count: same-name homonyms
    // under different governing codes (the dinosaur vs. the plant Euhelopus) have
    // different occurrence totals, so they're kept apart rather than merged.
    const byKey = new Map();
    for (const r of recs) {
      const key = `${r.nam}|${r.noc}`;
      const cur = byKey.get(key);
      // Prefer the formally-capitalised spelling when both forms appear.
      if (!cur || (/^[A-Z]/.test(r.nam) && !/^[A-Z]/.test(cur.nam))) byKey.set(key, r);
    }
    const list = [...byKey.values()];
    suggestBox.innerHTML = list.length
      ? list.map((r) => optRow(r.nam, RANK[+r.rnk] || "", (+r.noc).toLocaleString())).join("")
      : `<div class="grp">No matching taxa — check the spelling</div>`;
    syncAcItems();
    showSuggest();
  } catch (e) { /* network blip — leave the box as-is */ }
}

function pickSuggestion(val) {
  taxonInput.value = val;
  hideSuggest();
  search();
}
function setActive(i) {
  const opts = suggestBox.querySelectorAll(".opt");
  if (!opts.length) return;
  acActive = (i + opts.length) % opts.length;
  opts.forEach((el, n) => el.classList.toggle("active", n === acActive));
  opts[acActive].scrollIntoView({ block: "nearest" });
}

taxonInput.addEventListener("input", () => {
  clearTimeout(acTimer);
  const q = taxonInput.value.trim();
  if (q.length < 2) { showPopular(); return; }
  acTimer = setTimeout(() => liveSuggest(q), 180);
});
taxonInput.addEventListener("focus", () => {
  const q = taxonInput.value.trim();
  q.length >= 2 ? liveSuggest(q) : showPopular();
});
taxonInput.addEventListener("keydown", (e) => {
  if (suggestBox.classList.contains("hidden")) return;
  if (e.key === "ArrowDown") { e.preventDefault(); setActive(acActive + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setActive(acActive - 1); }
  else if (e.key === "Enter" && acActive >= 0) { e.preventDefault(); pickSuggestion(acItems[acActive]); }
  else if (e.key === "Escape") { hideSuggest(); }
});
suggestBox.addEventListener("mousedown", (e) => {
  const opt = e.target.closest(".opt");
  if (opt) { e.preventDefault(); pickSuggestion(opt.dataset.val); }
});
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".suggest-wrap")) hideSuggest();
});

/* ----------------------------------------------------------------- Wire up --- */
$("search-form").addEventListener("submit", (e) => { e.preventDefault(); hideSuggest(); search(); });
$("btn-clear").addEventListener("click", () => {
  $("f-taxon").value = ""; $("f-interval").value = ""; selectedInterval = "";
  $("f-maxma").value = ""; $("f-minma").value = ""; $("f-env").value = "";
  $("f-view").checked = false; intHint();
  globe.pointsData([]); setStatus("");
});
$("btn-download").addEventListener("click", downloadResults);
$("detail-close").addEventListener("click", () => $("detail").classList.add("hidden"));
$("panel-toggle").addEventListener("click", () => $("panel").classList.remove("collapsed"));
$("panel-close").addEventListener("click", () => $("panel").classList.add("collapsed"));

$("f-paleo").addEventListener("change", (e) => {
  usePaleo = e.target.checked;
  const recs = globe.pointsData();
  applyCoords(recs);
  globe.pointsData([...recs]);
  updatePaleoGlobe();
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

/* A friendly first search so the globe isn't empty on load. Load the live
 * timescale first so the interval picker is fully populated from the start. */
(async function init() {
  await loadTimescale();
  $("f-taxon").value = "Dinosauria";
  selectedInterval = "Cretaceous";
  intInput.value = "Cretaceous";
  intHint();
  search();
})();

/* On phones, start with the panel tucked away so the globe is the hero;
 * the ☰ button reopens it. */
if (window.matchMedia("(max-width: 640px)").matches) $("panel").classList.add("collapsed");
