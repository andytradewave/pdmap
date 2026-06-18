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

const colorForAge = (ma) => {
  const p = PERIODS.find((p) => ma <= p.max && ma > p.min) ||
            (ma > 635 ? { color: "#9a8aa0" } : PERIODS[0]);
  return p.color;
};

/* ----------------------------------------------------------------- Globe --- */
const ASSET = "vendor/img";
const globe = Globe()(document.getElementById("globe"))
  .globeImageUrl(`${ASSET}/earth-blue-marble.jpg`)
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
globe.onZoom((pov) => applyPointSize(pov.altitude));
// Belt-and-braces: the controls' own change event fires on every zoom/drag,
// including mouse-wheel, so point sizing always tracks the camera distance.
globe.controls().addEventListener("change", () =>
  applyPointSize(globe.pointOfView().altitude));

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
      <span style="color:#8a97aa">${d.noc || "?"} occurrence(s)${d.cc2 ? " · " + esc(d.cc2) : ""}</span>
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
function buildPeriodDropdown() {
  const sel = $("f-period");
  sel.innerHTML = `<option value="">Any age</option>`;
  for (const p of PERIODS) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = `${p.name}  (${p.max}–${p.min} Ma)`;
    sel.appendChild(o);
  }
}
function buildLegend() {
  const ul = $("legend-list");
  ul.innerHTML = "";
  for (const p of PERIODS) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch" style="background:${p.color}"></span>
      ${p.name}<span class="age">${p.max}–${p.min}</span>`;
    ul.appendChild(li);
  }
}
buildPeriodDropdown();
buildLegend();

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

async function search() {
  const taxon = $("f-taxon").value.trim();
  const period = $("f-period").value;
  const maxma = $("f-maxma").value.trim();
  const minma = $("f-minma").value.trim();
  const env = $("f-env").value;
  const limit = $("f-limit").value;

  const params = new URLSearchParams();
  params.set("show", "loc,time,paleoloc");
  params.set("limit", limit);
  if (taxon) params.set("base_name", taxon);

  if (maxma || minma) {
    if (maxma) params.set("max_ma", maxma);
    if (minma) params.set("min_ma", minma);
  } else if (period) {
    params.set("interval", period);
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

    const shown = recs.length;
    const capped = shown >= +limit ? ` (capped at ${limit} — narrow your filters for more)` : "";
    setStatus(`${shown.toLocaleString()} localities${capped}`, shown ? "" : "err");
    if (!shown) setStatus("No localities matched. Try a broader taxon or age.", "err");
  } catch (e) {
    setStatus("Error: " + e.message, "err");
  } finally {
    $("btn-search").disabled = false;
  }
}

/* Switch the plotted coordinates between modern and paleo positions. */
function applyCoords(recs) {
  for (const r of recs) {
    if (usePaleo && r._plat != null) { r.plat = r._plat; r.plng = r._plng; }
    else { r.plat = r._mlat; r.plng = r._mlng; }
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
    const res = await fetch(`${PBDB}/occs/list.json?coll_id=${collNo}&show=class,img&limit=500`);
    const json = await res.json();
    renderTaxa(json.records || []);
  } catch (e) {
    $("taxa-list").innerHTML = `<div class="loading-row">Could not load taxa: ${esc(e.message)}</div>`;
  }
}

function renderTaxa(occs) {
  // De-duplicate by accepted taxon name, keep the best image we see.
  const seen = new Map();
  for (const o of occs) {
    const name = o.tna || o.idn;
    if (!name) continue;
    if (!seen.has(name)) seen.set(name, o);
    else if (!seen.get(name).img && o.img) seen.set(name, o);
  }
  const list = [...seen.values()].sort((a, b) => (a.tna || "").localeCompare(b.tna || ""));
  $("taxa-count").textContent = `${list.length} taxa`;

  const cap = 80;
  const html = list.slice(0, cap).map(taxonCard).join("");
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

function taxonCard(o) {
  const name = o.tna || o.idn;
  const txNo = String(o.tid || "").replace(/\D/g, "");
  const imgId = o.img ? String(o.img).replace(/\D/g, "") : null;
  const cls = [o.phl, o.cll, o.fml].filter((x) => x && !/NO_.*_SPECIFIED|NO_ORDER/.test(x)).join(" › ");

  const wiki = `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, "_"))}`;
  const imgFossil = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(name + " fossil")}`;
  const imgLife = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(name + " life reconstruction")}`;
  const pbdb = txNo ? `https://paleobiodb.org/classic/basicTaxonInfo?taxon_no=${txNo}` : null;

  const sil = imgId
    ? `<img class="silhouette" loading="lazy" alt="" src="${PBDB}/taxa/thumb.png?id=${imgId}"
         onerror="this.classList.add('empty');this.removeAttribute('src');this.textContent='🦴'"/>`
    : `<div class="silhouette empty">🦴</div>`;

  return `<div class="taxon" data-wiki="${esc(name)}">
    <div class="tx-thumb">${sil}</div>
    <div class="tx-body">
      <div class="tx-name">${esc(name)}<span class="tx-rank">${RANK[o.rnk] || ""}</span></div>
      ${cls ? `<div class="tx-class">${esc(cls)}</div>` : ""}
      <div class="tx-desc"></div>
      <div class="tx-links">
        <a target="_blank" rel="noopener" href="${wiki}">Wikipedia</a>
        <a target="_blank" rel="noopener" href="${imgFossil}">Fossil images</a>
        <a target="_blank" rel="noopener" href="${imgLife}">Life reconstruction</a>
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
    "Ichthyosauria", "Mosasauridae", "Crocodylia"] },
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
    // Collapse the formal + vernacular spellings PBDB returns for one taxon.
    const byId = new Map();
    for (const r of recs) {
      const cur = byId.get(r.oid);
      if (!cur || (/^[A-Z]/.test(r.nam) && !/^[A-Z]/.test(cur.nam))) byId.set(r.oid, r);
    }
    const list = [...byId.values()];
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
  $("f-taxon").value = ""; $("f-period").value = ""; $("f-maxma").value = "";
  $("f-minma").value = ""; $("f-env").value = ""; $("f-view").checked = false;
  globe.pointsData([]); setStatus("");
});
$("detail-close").addEventListener("click", () => $("detail").classList.add("hidden"));
$("panel-toggle").addEventListener("click", () => $("panel").classList.remove("collapsed"));
$("panel-close").addEventListener("click", () => $("panel").classList.add("collapsed"));

$("f-paleo").addEventListener("change", (e) => {
  usePaleo = e.target.checked;
  const recs = globe.pointsData();
  applyCoords(recs);
  globe.pointsData([...recs]);
});
$("f-spin").addEventListener("change", (e) => {
  globe.controls().autoRotate = e.target.checked;
});

/* A friendly first search so the globe isn't empty on load. */
$("f-taxon").value = "Dinosauria";
$("f-period").value = "Cretaceous";
search();

/* On phones, start with the panel tucked away so the globe is the hero;
 * the ☰ button reopens it. */
if (window.matchMedia("(max-width: 640px)").matches) $("panel").classList.add("collapsed");
