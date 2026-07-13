#!/usr/bin/env node
/* ===========================================================================
 * build-taxonomy-index.mjs — the build-time Wikidata × PBDB merge.
 *
 * Paleoscope stays a pure static front-end: rather than an always-on service
 * joining Wikidata + PBDB at request time, this script does the join once, in
 * CI, and emits a static artifact the browser reads directly:
 *
 *     vendor/taxonomy-index.json
 *
 * It walks the POPULAR seed taxa and their descendants (to --depth levels); for
 * each node it pulls the Wikidata hierarchy / rank / taxon name / common name /
 * image / Wikispecies + Wikipedia sitelinks and the "PBDB taxon ID" (P5055),
 * and overlays the PBDB occurrence count. The result covers the common picker
 * paths with zero runtime and zero hosting; the long tail falls through to live
 * upstream calls in taxonomy.js behind the identical interface.
 *
 * Refresh cadence: re-run in CI (e.g. weekly) and commit the regenerated index
 * — the same pattern already used for the PaleoDEM textures in vendor/.
 *
 *   Usage:  node tools/build-taxonomy-index.mjs [--depth 2] [--max 1200]
 *                                               [--out vendor/taxonomy-index.json]
 * =========================================================================== */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const PBDB = "https://paleobiodb.org/data1.2";
const WD_API = "https://www.wikidata.org/w/api.php";
const WD_SPARQL = "https://query.wikidata.org/sparql";
const WS_BASE = "https://species.wikimedia.org/wiki/";
const WP_BASE = "https://en.wikipedia.org/wiki/";
const UA = "Paleoscope-taxonomy-build/1.0 (https://github.com/andytradewave/pdmap; andy.boniface@fixsolutions.co.uk)";

/* Same seed list the app ships in POPULAR — keep the two in sync. */
const SEEDS = [
  "Dinosauria", "Theropoda", "Sauropoda", "Ceratopsia", "Tyrannosaurus",
  "Triceratops", "Velociraptor", "Stegosaurus", "Pterosauria", "Plesiosauria",
  "Ichthyosauria", "Mosasauria", "Pseudosuchia", "Mammalia", "Proboscidea",
  "Mammuthus", "Smilodon", "Cetacea", "Primates", "Equidae", "Trilobita",
  "Ammonoidea", "Brachiopoda", "Crinoidea", "Bivalvia", "Gastropoda", "Anthozoa",
  "Plantae", "Coniferophyta", "Foraminifera", "Vertebrata", "Reptilia", "Aves",
  "Amphibia", "Chondrichthyes", "Insecta",
];

/* Wikidata taxon-rank Q-item → label (same table as taxonomy.js). */
const RANK_QID = {
  Q7432: "species", Q68947: "subspecies", Q34740: "genus", Q3238261: "subgenus",
  Q18012823: "supergenus", Q35409: "family", Q164280: "subfamily",
  Q2136103: "superfamily", Q10296147: "epifamily", Q5481039: "infrafamily",
  Q227936: "tribe", Q3965313: "subtribe", Q3798630: "infratribe",
  Q14817220: "supertribe", Q100900625: "supersubtribe", Q36602: "order",
  Q105883353: "order", Q5868144: "superorder", Q5867959: "suborder",
  Q2889003: "infraorder", Q6311258: "parvorder", Q6462265: "grandorder",
  Q6054237: "magnorder", Q7506274: "mirorder", Q7504331: "legion",
  Q37517: "class", Q3504061: "superclass", Q5867051: "subclass",
  Q2007442: "infraclass", Q26197587: "parvclass", Q60922428: "megaclass",
  Q21061204: "subterclass", Q38348: "phylum", Q2111790: "superphylum",
  Q1153785: "subphylum", Q2361851: "infraphylum", Q36732: "kingdom",
  Q19858692: "superkingdom", Q2752679: "subkingdom", Q3150876: "infrakingdom",
  Q26857882: "parvkingdom", Q146481: "domain", Q713623: "clade",
  Q334460: "division", Q30093070: "division", Q3491997: "subdivision",
  Q30093105: "subdivision", Q3181348: "section", Q3025161: "series",
  Q112082101: "ichnogenus", Q113015256: "ichnospecies", Q115227428: "ichnofamily",
  Q125838332: "oogenus", Q125838338: "oospecies", Q125838324: "oofamily",
};

/* -------------------------------------------------- args & tiny helpers --- */
const args = process.argv.slice(2);
const argVal = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const MAX_DEPTH = +argVal("--depth", "2");
const MAX_NODES = +argVal("--max", "1200");
const OUT = argVal("--out", "vendor/taxonomy-index.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function getJson(url, opts = {}) {
  calls++;
  await sleep(120); // be a polite API citizen — one call every ~120ms
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}
const wdApi = (params) =>
  getJson(WD_API + "?" + new URLSearchParams({ format: "json", ...params }));
const sparql = (query) =>
  getJson(WD_SPARQL + "?" + new URLSearchParams({ format: "json", query }),
    { headers: { Accept: "application/sparql-results+json" } }).then((d) => d.results.bindings);
const qidOf = (uri) => (uri || "").split("/").pop();
const claim = (ent, prop) => ent && ent.claims && ent.claims[prop] && ent.claims[prop][0];
function claimStr(ent, prop) {
  const v = claim(ent, prop);
  const dv = v && v.mainsnak && v.mainsnak.datavalue && v.mainsnak.datavalue.value;
  if (dv == null) return "";
  return typeof dv === "string" ? dv : (dv.id || dv.text || "");
}
/* English common name (P1843), which is monolingual text in many languages. */
function commonName(ent) {
  for (const c of (ent && ent.claims && ent.claims.P1843) || []) {
    const dv = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
    if (dv && dv.language === "en" && dv.text) return dv.text;
  }
  return "";
}
const commonsUrl = (file) => file
  ? "https://commons.wikimedia.org/wiki/Special:FilePath/" +
    encodeURIComponent(file.replace(/ /g, "_")) + "?width=120"
  : null;

/* Resolve a scientific name → QID, preferring an exact taxon-name (P225) match. */
async function resolveQid(name) {
  const rows = await sparql(
    `SELECT ?t WHERE { ?t wdt:P225 "${name.replace(/"/g, '\\"')}" } LIMIT 5`);
  if (rows.length) return qidOf(rows[0].t.value);
  const s = await wdApi({ action: "wbsearchentities", search: name, language: "en",
    type: "item", limit: "7" });
  const ids = (s.search || []).map((x) => x.id);
  if (!ids.length) return null;
  const g = await wdApi({ action: "wbgetentities", ids: ids.join("|"), props: "claims", languages: "en" });
  for (const id of ids) {
    const p225 = claimStr(g.entities[id], "P225");
    if (p225 && p225.toLowerCase() === name.toLowerCase()) return id;
  }
  return null;
}

/* Wikidata entity → the fields we bake per node. */
async function fetchNode(qid, fallbackName) {
  const g = await wdApi({ action: "wbgetentities", ids: qid,
    props: "labels|claims|sitelinks", languages: "en" });
  const ent = g.entities[qid];
  const sl = (ent && ent.sitelinks) || {};
  const name = claimStr(ent, "P225") || fallbackName;
  return {
    qid,
    name,
    rank: RANK_QID[claimStr(ent, "P105")] || "",
    common: commonName(ent) || (ent.labels && ent.labels.en && ent.labels.en.value) || "",
    image: commonsUrl(claimStr(ent, "P18")),
    wikispecies: sl.specieswiki ? WS_BASE + encodeURIComponent(sl.specieswiki.title.replace(/ /g, "_")) : null,
    wikipedia: sl.enwiki ? WP_BASE + encodeURIComponent(sl.enwiki.title.replace(/ /g, "_")) : null,
    pbdbId: claimStr(ent, "P5055") || null,
  };
}

/* PBDB occurrence counts for a parent's immediate children, keyed by name. */
async function pbdbChildCounts(name) {
  try {
    const d = await getJson(`${PBDB}/taxa/list.json?name=${encodeURIComponent(name)}&rel=children&status=accepted&show=size`);
    const m = new Map();
    for (const r of d.records || []) m.set(r.nam, +r.noc || 0);
    return m;
  } catch { return new Map(); }
}

/* Does PBDB recognise this exact scientific name? (the bridge fast path). */
async function pbdbHasName(name) {
  try {
    const d = await getJson(`${PBDB}/taxa/single.json?name=${encodeURIComponent(name)}`);
    const r = (d.records || [])[0];
    return r && r.nam === name;
  } catch { return false; }
}

/* PBDB canonical name for a P5055 taxon id. NB: Wikidata's P5055 values are not
 * always reliable (ids get reassigned/merged in PBDB), so this is used only as
 * a fallback when PBDB does not recognise the taxon by its Wikispecies name,
 * and the result is itself re-validated before being trusted. */
async function pbdbNameForId(pbdbId) {
  try {
    const d = await getJson(`${PBDB}/taxa/single.json?id=txn:${pbdbId}`);
    const r = (d.records || [])[0];
    return r ? r.nam : null;
  } catch { return null; }
}

/* --------------------------------------------------------------- build --- */
async function main() {
  console.error(`Building taxonomy index: depth=${MAX_DEPTH} max=${MAX_NODES} → ${OUT}`);
  const nodes = {};       // name → node
  const overrides = {};   // wikidataName → pbdbName (only when they differ)
  const queue = [];       // { name, qid, depth }
  const seen = new Set(); // qids processed/queued

  for (const name of SEEDS) {
    const qid = await resolveQid(name).catch(() => null);
    if (qid && !seen.has(qid)) { seen.add(qid); queue.push({ name, qid, depth: 0 }); }
    else if (!qid) console.error("  ! no Wikidata match for seed", name);
  }

  let processed = 0;
  while (queue.length && processed < MAX_NODES) {
    const { name, qid, depth } = queue.shift();
    processed++;
    let node;
    try { node = await fetchNode(qid, name); }
    catch (e) { console.error("  ! fetchNode failed", name, e.message); continue; }

    // Bridge seed. Fast path: PBDB recognises most higher taxa by their exact
    // Wikispecies name — that's identity, no override needed. Only when PBDB
    // does NOT know the name do we fall back to the (unreliable) P5055 id, and
    // then re-validate the resulting name before recording it as an override.
    if (await pbdbHasName(node.name)) {
      node.pbdbName = node.name;
    } else if (node.pbdbId) {
      const pbName = await pbdbNameForId(node.pbdbId);
      if (pbName && pbName !== node.name && await pbdbHasName(pbName)) {
        node.pbdbName = pbName;
        overrides[node.name] = pbName;
      }
    }

    // Children: Wikidata hierarchy overlaid with PBDB counts, filtered/sorted
    // exactly like the runtime picker (only groups with fossils, most first).
    let childNames = [];
    if (depth < MAX_DEPTH) {
      try {
        const rows = await sparql(
          `SELECT ?c ?name ?rank WHERE {
             ?c wdt:P171 wd:${qid} . ?c wdt:P225 ?name .
             OPTIONAL { ?c wdt:P105 ?rank. }
           } LIMIT 400`);
        const counts = await pbdbChildCounts(node.pbdbName || name);
        const kids = [];
        const dedupe = new Set();
        for (const b of rows) {
          const cn = b.name.value;
          if (dedupe.has(cn)) continue; dedupe.add(cn);
          const noc = counts.get(cn) || 0;
          if (noc <= 0) continue; // hide empty groups, like the picker
          kids.push({ name: cn, qid: qidOf(b.c.value),
            rank: b.rank ? RANK_QID[qidOf(b.rank.value)] || "" : "", noc });
        }
        kids.sort((a, b) => b.noc - a.noc);
        const capped = kids.slice(0, 60);
        childNames = capped.map((k) => k.name);
        for (const k of capped) {
          // stub each child now (count/rank/qid), enqueue for full expansion
          if (!nodes[k.name]) nodes[k.name] = { qid: k.qid, rank: k.rank, noc: k.noc };
          else { nodes[k.name].noc = k.noc; if (!nodes[k.name].qid) nodes[k.name].qid = k.qid; }
          if (k.qid && !seen.has(k.qid) && depth + 1 <= MAX_DEPTH) {
            seen.add(k.qid); queue.push({ name: k.name, qid: k.qid, depth: depth + 1 });
          }
        }
      } catch (e) { console.error("  ! children failed", name, e.message); }
    }

    nodes[name] = { ...(nodes[name] || {}), ...node, children: childNames };
    if (processed % 25 === 0)
      console.error(`  … ${processed} nodes, ${queue.length} queued, ${calls} API calls`);
  }

  const out = {
    generated: new Date().toISOString(),
    source: "Wikidata (query.wikidata.org) × PBDB (paleobiodb.org)",
    depth: MAX_DEPTH,
    count: Object.keys(nodes).length,
    nodes,
    overrides,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.error(`Done: ${out.count} nodes, ${Object.keys(overrides).length} bridge overrides, ${calls} API calls → ${OUT}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
