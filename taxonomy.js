/* ===========================================================================
 * Paleoscope — TaxonProvider: the taxonomy (display + navigation) layer.
 *
 * Historically Paleoscope drove its tree-of-life picker, autocomplete, "About
 * this taxon" card and lineage tooltips entirely from the Paleobiology Database
 * (PBDB) taxonomic service. PBDB's taxonomy is often broken (stale opinions,
 * homonyms, questionable placement), so this module lets the *taxonomy* layer be
 * driven from Wikispecies instead — consumed through its structured backbone,
 * Wikidata — while fossil *occurrences* stay on PBDB.
 *
 * It exposes ONE async interface (`window.TaxonProvider`) with two swappable
 * implementations selected by a feature flag:
 *
 *   ?taxonomy=wikispecies   (or localStorage "paleoscope.taxonomy")
 *
 *   search(query)      → [{ name, id, rank, common, noc }]        // autocomplete
 *   children(node)     → [{ name, id, rank, noc }]                // picker drill-down
 *   lineage(name)      → "root › … › leaf"                        // tooltip / card
 *   info(name)         → { name, rank, common, authority, extinct,
 *                          imageUrl, wikispeciesUrl, wikipediaUrl, pbdbUrl,
 *                          subtaxaCount, occCount, range, source, pbdbName, … }
 *   subtaxa(node)      → [{ name, rank, noc }]                    // info-card list
 *   pbdbQueryName(name)→ "PBDB-valid base_name string"            // the bridge
 *
 * The bridge (`pbdbQueryName`) is the make-or-break piece: a name chosen from
 * Wikispecies must still resolve to PBDB occurrences. It is identity for most
 * higher taxa (Dinosauria, Mammalia, Trilobita are spelled the same in both)
 * and consults a name→PBDB-name override map seeded from Wikidata's "PBDB taxon
 * ID" property (P5055) for the mismatches.
 *
 * No live backend: a build script (tools/build-taxonomy-index.mjs) joins
 * Wikidata + PBDB once and ships a static vendor/taxonomy-index.json, which the
 * Wikidata provider reads first and only falls through to live upstream calls on
 * a miss. The whole thing stays a pure static front-end.
 * =========================================================================== */
(function () {
  "use strict";

  const PBDB = "https://paleobiodb.org/data1.2";
  const WD_API = "https://www.wikidata.org/w/api.php";
  const WD_SPARQL = "https://query.wikidata.org/sparql";
  const WS_BASE = "https://species.wikimedia.org/wiki/";
  const WP_BASE = "https://en.wikipedia.org/wiki/";

  /* PBDB numeric rank → label (mirrors app.js RANK; kept here so the module is
   * self-contained and load-order independent). */
  const RANK_NUM = { 2: "subspecies", 3: "species", 4: "subgenus", 5: "genus",
    6: "subtribe", 7: "tribe", 8: "subfamily", 9: "family", 10: "superfamily",
    11: "infraorder", 12: "suborder", 13: "order", 14: "superorder",
    15: "infraclass", 16: "subclass", 17: "class", 18: "superclass",
    19: "subphylum", 20: "phylum", 21: "superphylum", 22: "subkingdom",
    23: "kingdom", 25: "unranked clade" };

  /* Wikidata taxon-rank Q-item → label. Generated from Wikidata (items that are
   * an instance/subclass of "taxonomic rank", Q427626); trimmed to the ranks
   * that actually turn up in animal/plant/microfossil hierarchies. */
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
    Q26857882: "parvkingdom", Q146481: "domain", Q62075839: "realm",
    Q65082852: "subrealm", Q2981883: "cohort", Q6541077: "subcohort",
    Q4226087: "infracohort", Q6054425: "supercohort", Q60445775: "megacohort",
    Q713623: "clade", Q334460: "division", Q30093070: "division",
    Q3491997: "subdivision", Q30093105: "subdivision", Q3181348: "section",
    Q10861426: "section", Q3025161: "series", Q3146751: "supergroup",
    Q112082101: "ichnogenus", Q113015256: "ichnospecies", Q115227428: "ichnofamily",
    Q125838332: "oogenus", Q125838338: "oospecies", Q125838324: "oofamily",
    Q7574964: "species group", Q1783100: "superspecies",
  };

  /* -------------------------------------------------- small fetch helpers --- */
  async function getJson(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    return r.json();
  }
  const wdApi = (params) =>
    getJson(WD_API + "?" + new URLSearchParams({ format: "json", origin: "*", ...params }));
  const sparql = (query) =>
    getJson(WD_SPARQL + "?" + new URLSearchParams({ format: "json", query }),
      { headers: { Accept: "application/sparql-results+json" } })
      .then((d) => d.results.bindings);
  const qidOf = (uri) => (uri || "").split("/").pop();

  /* A tiny promise-memoiser so repeated look-ups (same picker reopened, same
   * name hovered) hit the network once — same pattern app.js already uses. */
  function memo() {
    const m = new Map();
    return (key, make) => {
      if (m.has(key)) return m.get(key);
      const p = Promise.resolve().then(make).catch((e) => { m.delete(key); throw e; });
      m.set(key, p);
      return p;
    };
  }

  /* ======================================================================= *
   * PBDB provider — wraps the existing PBDB taxonomy calls. This is the
   * default and the migration fallback; behaviour matches the pre-migration
   * app exactly, just funnelled through the interface.
   * ======================================================================= */
  const PbdbProvider = (function () {
    const childCache = memo(), lineageCache = memo(), infoCache = memo();

    /* A few taxa where PBDB's own opinion disagrees with the accepted cladogram
     * (Avialae belongs in Paraves, Aves in Avialae). Hand-patched, exactly as
     * the pre-migration app did. */
    const REPARENT = { Avialae: "Paraves", Aves: "Avialae" };

    const fetchRecord = (name) =>
      getJson(`${PBDB}/taxa/list.json?name=${encodeURIComponent(name)}&status=accepted&show=size`)
        .then((d) => (d.records || [])[0] || null).catch(() => null);

    async function children(node) {
      const key = node.id ? `id:${node.id}` : `nm:${node.name}`;
      return childCache(key, async () => {
        const sel = node.id ? `id=${String(node.id).replace(/\D/g, "")}`
                            : `name=${encodeURIComponent(node.name)}`;
        const d = await getJson(`${PBDB}/taxa/list.json?${sel}&rel=children&status=accepted&show=size`);
        let recs = (d.records || [])
          .filter((r) => !(r.nam in REPARENT) || REPARENT[r.nam] === node.name);
        for (const [child, trueParent] of Object.entries(REPARENT)) {
          if (trueParent === node.name && !recs.some((r) => r.nam === child)) {
            const extra = await fetchRecord(child);
            if (extra) recs = [...recs, extra];
          }
        }
        return recs
          .map((r) => ({ name: r.nam, id: r.oid, rank: RANK_NUM[+r.rnk] || "", noc: +r.noc || 0 }))
          .filter((c) => c.noc > 0)
          .sort((a, b) => b.noc - a.noc)
          .slice(0, 60);
      }).catch(() => []);
    }

    async function search(q) {
      const d = await getJson(`${PBDB}/taxa/auto.json?name=${encodeURIComponent(q)}&limit=12`);
      const recs = d.records || [];
      // Collapse PBDB's duplicate entries for one clade, keyed on name+count so
      // cross-code homonyms survive; prefer the capitalised (formal) spelling.
      const byKey = new Map();
      for (const r of recs) {
        const k = `${r.nam}|${r.noc}`, cur = byKey.get(k);
        if (!cur || (/^[A-Z]/.test(r.nam) && !/^[A-Z]/.test(cur.nam))) byKey.set(k, r);
      }
      return [...byKey.values()].map((r) => ({
        name: r.nam, id: r.oid, rank: RANK_NUM[+r.rnk] || "", common: "", noc: +r.noc || 0,
      }));
    }

    function lineage(name) {
      return lineageCache(name, () =>
        getJson(`${PBDB}/taxa/list.json?name=${encodeURIComponent(name)}&rel=all_parents&status=accepted`)
          .then((d) => (d.records || []).map((r) => r.nam).filter(Boolean).join(" › "))
      ).catch(() => "");
    }

    function info(name) {
      return infoCache(name, async () => {
        const d = await getJson(`${PBDB}/taxa/single.json?name=${encodeURIComponent(name)}&show=app,size,img,common`);
        const r = (d.records || [])[0];
        if (!r) return null;
        const txNo = String(r.oid || "").replace(/\D/g, "");
        const imgId = r.img ? String(r.img).replace(/\D/g, "") : null;
        const oldest = +r.fea, youngest = +r.lla;
        return {
          name: r.nam || name,
          id: r.oid,
          rank: RANK_NUM[r.rnk] || "",
          common: r.nm2 || "",
          authority: r.att || "",
          extinct: r.ext == null ? null : String(r.ext) === "0",
          imageUrl: imgId ? `${PBDB}/taxa/thumb.png?id=${imgId}` : null,
          wikispeciesUrl: null,
          wikipediaUrl: null,
          pbdbUrl: txNo ? `https://paleobiodb.org/classic/basicTaxonInfo?taxon_no=${txNo}` : null,
          subtaxaCount: r.siz != null ? Math.max(0, +r.siz - 1) : 0,
          occCount: r.noc != null ? +r.noc : null,
          range: (!isNaN(oldest) && !isNaN(youngest) && oldest > 0)
            ? { oldest, youngest, earlyInterval: r.tei || "", lateInterval: r.tli || "" } : null,
          source: "pbdb",
          pbdbName: r.nam || name,
          pbdbId: txNo || null,
        };
      }).catch(() => null);
    }

    async function subtaxa(node) {
      const txNo = String(node.id || "").replace(/\D/g, "");
      const sel = txNo ? `id=${txNo}` : `name=${encodeURIComponent(node.name)}`;
      const d = await getJson(`${PBDB}/taxa/list.json?${sel}&rel=children&status=accepted&show=size`);
      return (d.records || [])
        .map((r) => ({ name: r.nam, rank: RANK_NUM[+r.rnk] || "", noc: +r.noc || 0 }))
        .sort((a, b) => b.noc - a.noc || a.name.localeCompare(b.name));
    }

    // PBDB names come from PBDB — always valid for base_name.
    const pbdbQueryName = (name) => name;

    return { search, children, lineage, info, subtaxa, pbdbQueryName, source: "pbdb" };
  })();

  /* ======================================================================= *
   * Prebuilt merged index (vendor/taxonomy-index.json). Loaded lazily and
   * once; the Wikidata provider reads it first and only hits live upstream on
   * a miss. Shape (see build script):
   *   { generated, nodes: { "<Name>": { qid, rank, common, pbdbName, pbdbId,
   *       noc, image, wikispecies, wikipedia, children: [ "<Name>", … ] } },
   *     overrides: { "<Name>": "<PBDBName>" } }
   * ======================================================================= */
  let indexPromise = null;
  const EMPTY_INDEX = { nodes: {}, overrides: {}, byQid: {} };
  function loadIndex() {
    if (indexPromise) return indexPromise;
    indexPromise = fetch("vendor/taxonomy-index.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.nodes) return EMPTY_INDEX;
        d.overrides = d.overrides || {};
        d.byQid = {};
        for (const [name, n] of Object.entries(d.nodes)) if (n.qid) d.byQid[n.qid] = name;
        return d;
      })
      .catch(() => EMPTY_INDEX);
    return indexPromise;
  }

  /* ======================================================================= *
   * Wikidata provider — the structured backbone of Wikispecies. Hierarchy,
   * ranks, names, images and Wikispecies/Wikipedia sitelinks come from
   * Wikidata; PBDB occurrence counts are overlaid so the picker keeps its
   * "hide empty groups / most-collected first" behaviour, and PBDB supplies
   * the stratigraphic range + extinct flag on the info card.
   * ======================================================================= */
  const WikiProvider = (function () {
    const qidCache = memo(), childCache = memo(), lineageCache = memo(),
      infoCache = memo(), countCache = memo();
    const overrides = new Map(); // taxonName → pbdb base_name string

    /* Resolve a scientific name → best Wikidata QID (+ a little context). Index
     * first; otherwise search the Action API and keep only real taxa (those
     * carrying a taxon name, P225), preferring an exact name match. */
    function resolveQid(name) {
      return qidCache(name.toLowerCase(), async () => {
        const idx = await loadIndex();
        const hit = idx.nodes[name];
        if (hit && hit.qid) return { qid: hit.qid, name, fromIndex: true };
        const s = await wdApi({ action: "wbsearchentities", search: name, language: "en",
          type: "item", limit: "10" });
        const ids = (s.search || []).map((x) => x.id);
        if (!ids.length) return null;
        const g = await wdApi({ action: "wbgetentities", ids: ids.join("|"),
          props: "labels|claims", languages: "en" });
        let best = null;
        for (const id of ids) {
          const ent = g.entities && g.entities[id];
          const p225 = claimStr(ent, "P225");
          if (!p225) continue;
          const cand = { qid: id, name: p225 };
          if (p225.toLowerCase() === name.toLowerCase()) return cand; // exact wins
          if (!best) best = cand;
        }
        return best;
      }).catch(() => null);
    }

    const claim = (ent, prop) => ent && ent.claims && ent.claims[prop] && ent.claims[prop][0];
    function claimStr(ent, prop) {
      const v = claim(ent, prop);
      const dv = v && v.mainsnak && v.mainsnak.datavalue && v.mainsnak.datavalue.value;
      if (dv == null) return "";
      return typeof dv === "string" ? dv : (dv.id || dv.text || "");
    }
    /* Common name (P1843) is monolingual text in many languages; the API's
     * `languages` param only filters labels, not claim values — so pick the
     * English one explicitly and show nothing rather than a foreign string. */
    function commonName(ent) {
      const claims = (ent && ent.claims && ent.claims.P1843) || [];
      for (const c of claims) {
        const dv = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
        if (dv && dv.language === "en" && dv.text) return dv.text;
      }
      return "";
    }
    const rankLabel = (qid) => RANK_QID[qid] || "";
    const commonsUrl = (file) => file
      ? "https://commons.wikimedia.org/wiki/Special:FilePath/" +
        encodeURIComponent(file.replace(/ /g, "_")) + "?width=120"
      : null;

    /* PBDB occurrence counts for a parent's immediate children, keyed by name —
     * one PBDB call, reused to overlay counts onto the Wikidata child set and
     * to keep the picker's "hide empty / most-collected first" behaviour. */
    function pbdbChildCounts(parentName) {
      return countCache("kids:" + parentName, () =>
        getJson(`${PBDB}/taxa/list.json?name=${encodeURIComponent(parentName)}&rel=children&status=accepted&show=size`)
          .then((d) => {
            const m = new Map();
            for (const r of d.records || []) {
              m.set(r.nam, +r.noc || 0);
              overrides.set(r.nam, r.nam); // PBDB knows it by this exact name
            }
            return m;
          })
          .catch(() => new Map())
      );
    }

    async function children(node) {
      const key = node.id ? `id:${node.id}` : `nm:${node.name}`;
      return childCache(key, async () => {
        const idx = await loadIndex();
        const qid = node.id && /^Q\d+$/.test(node.id) ? node.id
          : (idx.nodes[node.name] && idx.nodes[node.name].qid)
          || ((await resolveQid(node.name)) || {}).qid;
        let kids = [];
        // 1. prebuilt index (instant, counts already baked in)
        const idxNode = idx.byQid[qid] && idx.nodes[idx.byQid[qid]];
        if (idxNode && idxNode.children && idxNode.children.length) {
          kids = idxNode.children.map((cn) => {
            const c = idx.nodes[cn] || {};
            return { name: cn, id: c.qid || null, rank: c.rank || "", noc: c.noc || 0 };
          });
        } else if (qid) {
          // 2. live Wikidata children (P171), overlaid with PBDB counts by name
          const rows = await sparql(
            `SELECT ?c ?name ?rankLabel WHERE {
               ?c wdt:P171 wd:${qid} . ?c wdt:P225 ?name .
               OPTIONAL { ?c wdt:P105 ?rank. }
               SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
             } LIMIT 400`);
          const counts = await pbdbChildCounts(node.name);
          const seen = new Set();
          for (const b of rows) {
            const name = b.name.value;
            if (seen.has(name)) continue; seen.add(name);
            kids.push({ name, id: qidOf(b.c.value),
              rank: b.rankLabel ? b.rankLabel.value : "", noc: counts.get(name) || 0 });
          }
        }
        // Same UX as PBDB: only groups that actually have fossils, most first.
        return kids
          .filter((c) => c.noc > 0)
          .sort((a, b) => b.noc - a.noc)
          .slice(0, 60);
      }).catch(() => []);
    }

    async function search(q) {
      const idx = await loadIndex();
      const local = Object.keys(idx.nodes)
        .filter((n) => n.toLowerCase().startsWith(q.toLowerCase()))
        .slice(0, 12)
        .map((n) => ({ name: n, id: idx.nodes[n].qid, rank: idx.nodes[n].rank || "",
          common: idx.nodes[n].common || "", noc: idx.nodes[n].noc || 0 }));
      if (local.length >= 8) return local;
      const s = await wdApi({ action: "wbsearchentities", search: q, language: "en",
        type: "item", limit: "15" });
      const ids = (s.search || []).map((x) => x.id);
      if (!ids.length) return local;
      const g = await wdApi({ action: "wbgetentities", ids: ids.join("|"),
        props: "labels|claims", languages: "en" });
      const seen = new Set(local.map((x) => x.name));
      const out = [...local];
      for (const id of ids) {
        const ent = g.entities && g.entities[id];
        const name = claimStr(ent, "P225");
        if (!name || seen.has(name)) continue; seen.add(name);
        const pbdb = claimStr(ent, "P5055");
        if (pbdb) overrides.set(name, name); // has a PBDB id → PBDB knows the name
        out.push({ name, id, rank: rankLabel(claimStr(ent, "P105")),
          common: commonName(ent), noc: idx.nodes[name] ? idx.nodes[name].noc || 0 : 0 });
      }
      return out.slice(0, 14);
    }

    function lineage(name) {
      return lineageCache(name, async () => {
        const idx = await loadIndex();
        const r = await resolveQid(name);
        if (!r) return name;
        // Ancestors ordered root→leaf by distance from the taxon.
        const rows = await sparql(
          `SELECT ?a ?name (COUNT(?mid) AS ?depth) WHERE {
             wd:${r.qid} wdt:P171* ?mid . ?mid wdt:P171* ?a . ?a wdt:P225 ?name .
           } GROUP BY ?a ?name ORDER BY DESC(?depth)`);
        const chain = rows.map((b) => b.name.value);
        return (chain.length ? chain : [name]).join(" › ");
      }).catch(() => name);
    }

    /* Taxonomy fields from Wikidata; extinct flag, occurrence count and
     * stratigraphic range from PBDB (Wikidata/Wikispecies have no fossil data). */
    function info(name) {
      return infoCache(name, async () => {
        const idx = await loadIndex();
        const r = await resolveQid(name);
        let wd = {};
        if (r && r.qid) {
          const g = await wdApi({ action: "wbgetentities", ids: r.qid,
            props: "labels|claims|sitelinks|descriptions", languages: "en" });
          const ent = g.entities && g.entities[r.qid];
          const sl = (ent && ent.sitelinks) || {};
          const idxNode = idx.nodes[name] || {};
          wd = {
            qid: r.qid,
            name: claimStr(ent, "P225") || name,
            rank: rankLabel(claimStr(ent, "P105")) || idxNode.rank || "",
            common: commonName(ent) ||
              (ent && ent.labels && ent.labels.en && ent.labels.en.value) || idxNode.common || "",
            authority: claimStr(ent, "P405") || "",
            imageUrl: commonsUrl(claimStr(ent, "P18")) || idxNode.image || null,
            wikispeciesUrl: sl.specieswiki
              ? WS_BASE + encodeURIComponent(sl.specieswiki.title.replace(/ /g, "_"))
              : (idxNode.wikispecies || null),
            wikipediaUrl: sl.enwiki
              ? WP_BASE + encodeURIComponent(sl.enwiki.title.replace(/ /g, "_"))
              : (idxNode.wikipedia || null),
            pbdbName: idxNode.pbdbName || (claimStr(ent, "P5055") ? name : name),
          };
          if (claimStr(ent, "P5055")) overrides.set(name, wd.pbdbName);
        }
        // Overlay PBDB: extinct, occurrence count, range, and validate the name.
        const pbdb = await PbdbProvider.info(wd.pbdbName || name).catch(() => null);
        const subtaxaCount = await childCount(r && r.qid).catch(() => 0);
        if (!r && !pbdb) return null;
        return {
          name: wd.name || name,
          id: wd.qid || null,
          rank: wd.rank || (pbdb && pbdb.rank) || "",
          common: wd.common || (pbdb && pbdb.common) || "",
          authority: wd.authority || (pbdb && pbdb.authority) || "",
          extinct: pbdb ? pbdb.extinct : null,
          imageUrl: wd.imageUrl || (pbdb && pbdb.imageUrl) || null,
          wikispeciesUrl: wd.wikispeciesUrl || null,
          wikipediaUrl: wd.wikipediaUrl || null,
          pbdbUrl: pbdb ? pbdb.pbdbUrl : null,
          subtaxaCount: subtaxaCount || (pbdb ? pbdb.subtaxaCount : 0),
          occCount: pbdb ? pbdb.occCount : null,
          range: pbdb ? pbdb.range : null,
          source: "wikispecies",
          pbdbName: (pbdb && pbdb.pbdbName) || wd.pbdbName || name,
          pbdbId: pbdb ? pbdb.pbdbId : null,
        };
      }).catch(() => null);
    }

    function childCount(qid) {
      if (!qid) return Promise.resolve(0);
      return countCache("n:" + qid, () =>
        sparql(`SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c wdt:P171 wd:${qid} . ?c wdt:P225 ?nm }`)
          .then((rows) => (rows[0] && +rows[0].n.value) || 0).catch(() => 0));
    }

    async function subtaxa(node) {
      const idx = await loadIndex();
      const qid = node.id && /^Q\d+$/.test(node.id) ? node.id
        : ((await resolveQid(node.name)) || {}).qid;
      const idxNode = qid && idx.byQid[qid] && idx.nodes[idx.byQid[qid]];
      let kids = [];
      if (idxNode && idxNode.children && idxNode.children.length) {
        kids = idxNode.children.map((cn) => {
          const c = idx.nodes[cn] || {};
          return { name: cn, rank: c.rank || "", noc: c.noc || 0 };
        });
      } else if (qid) {
        const rows = await sparql(
          `SELECT ?name ?rankLabel WHERE {
             ?c wdt:P171 wd:${qid} . ?c wdt:P225 ?name .
             OPTIONAL { ?c wdt:P105 ?rank. }
             SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
           } LIMIT 400`);
        const counts = await pbdbChildCounts(node.name);
        const seen = new Set();
        for (const b of rows) {
          const name = b.name.value;
          if (seen.has(name)) continue; seen.add(name);
          kids.push({ name, rank: b.rankLabel ? b.rankLabel.value : "", noc: counts.get(name) || 0 });
        }
      }
      return kids.sort((a, b) => b.noc - a.noc || a.name.localeCompare(b.name));
    }

    /* The bridge. A chosen Wikispecies/Wikidata taxon → a base_name string PBDB
     * accepts. Fast path: the name is identical in PBDB (true for most higher
     * taxa). Reconcile path: a known override (seeded from P5055 / PBDB's own
     * child listing). Synchronous so the synchronous filter-builder can call it;
     * overrides are warmed as taxa flow through search/children/info. */
    function pbdbQueryName(name) {
      return overrides.get(name) || name;
    }
    // Pre-warm the override map from the shipped index (so exports/searches get
    // the right PBDB name even before the taxon has been browsed live).
    loadIndex().then((idx) => {
      for (const [name, n] of Object.entries(idx.nodes || {})) {
        if (n.pbdbName && n.pbdbName !== name) overrides.set(name, n.pbdbName);
        else if (n.pbdbId || n.noc) overrides.set(name, name);
      }
      for (const [name, pb] of Object.entries(idx.overrides || {})) overrides.set(name, pb);
    });

    return { search, children, lineage, info, subtaxa, pbdbQueryName, source: "wikispecies" };
  })();

  /* --------------------------------------------------- flag & dispatch ---- */
  function resolveSource() {
    let src;
    try {
      const p = new URLSearchParams(location.search);
      if (p.has("taxonomy")) {
        src = p.get("taxonomy");
        localStorage.setItem("paleoscope.taxonomy", src);
      } else {
        src = localStorage.getItem("paleoscope.taxonomy");
      }
    } catch (e) { /* URL/localStorage unavailable — fall through to default */ }
    return src === "wikispecies" ? "wikispecies" : "pbdb";
  }

  const active = resolveSource() === "wikispecies" ? WikiProvider : PbdbProvider;

  // Public interface. Kept minimal and stable; swapping the backend (or dropping
  // in an edge service later) is a one-line change here.
  window.TaxonProvider = {
    search: (q) => active.search(q),
    children: (node) => active.children(node),
    lineage: (name) => active.lineage(name),
    info: (name) => active.info(name),
    subtaxa: (node) => active.subtaxa(node),
    pbdbQueryName: (name) => active.pbdbQueryName(name),
    source: active.source,
    // exposed for tests / a future settings toggle
    _impls: { pbdb: PbdbProvider, wikispecies: WikiProvider },
  };
})();
