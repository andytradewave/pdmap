# Plan: Replacing PBDB taxonomy with Wikispecies

## Goal

Paleoscope's taxonomy layer (the tree-of-life picker, autocomplete, "About this
taxon" card, lineage tooltips, classification grouping in Compare) currently
comes entirely from the **Paleobiology Database (PBDB)** taxonomic service. That
taxonomy is often broken — stale opinions, missing or duplicate homonyms,
questionable parent/child placement (we already hand-patch a couple of cases via
`TAXON_REPARENT`), and inconsistent ranks. This document plans how to move the
taxonomy layer onto **Wikispecies** instead.

## Decisions confirmed

- **Use Wikidata as the structured backbone.** Wikidata carries the taxonomy as
  first-class properties and links back to the Wikispecies page, so we badge/link
  "Wikispecies" while consuming machine-readable data. Raw-wikitext parsing of
  Wikispecies is a fallback only.
- **Overlay PBDB occurrence counts.** The counts are useful, so we keep them in
  the picker (hide-empty-groups + most-collected-first) and info card, merged onto
  the Wikidata hierarchy rather than dropped.
- **No live backend — merge at build time instead.** A separate always-on
  taxonomy service would end the app's "pure static, no backend" property. We get
  the same cache/merge benefit from a build-time script that emits a static merged
  index (see *Build-time merge, not a live service* below), with a live edge
  service kept as a later drop-in upgrade.

## The core constraint you must design around

PBDB in this app plays **two different roles**, and only one of them can move to
Wikispecies:

1. **Taxonomy** — names, ranks, parent/child hierarchy, lineage, common names,
   silhouettes. *(This can move.)*
2. **Fossil occurrences** — the actual dots on the globe. Every map point,
   locality card, CSV/GeoJSON export and Compare tally is a PBDB **occurrence /
   collection** record. Wikispecies has **no occurrence data whatsoever**.
   *(This cannot move — it stays PBDB, plus Neotoma for the Quaternary.)*

The two roles are welded together by one load-bearing feature:
**`base_name` server-side expansion**. When the user searches `Dinosauria`,
we send `base_name=Dinosauria` to PBDB and *PBDB itself* expands that into every
descendant taxon and returns the matching occurrences (see `buildFilters()` at
[app.js:937](../app.js) and the `^` exclusion syntax around
[app.js:998](../app.js)). We never enumerate the descendants ourselves.

So "replace the taxonomy with Wikispecies" really means:

> Drive the **UI taxonomy** (picker, autocomplete, info card, lineage,
> classification labels) from Wikispecies, while continuing to query PBDB for
> occurrences — and build a **name-reconciliation bridge** so a name chosen from
> Wikispecies still resolves to PBDB occurrences.

Getting that bridge right is the whole game. The rest is mechanical.

## Wikispecies is not really an API — read this before choosing a source

Wikispecies is a **MediaWiki wiki**, not a structured data service. Its taxonomy
lives inside wikitext templates (`{{Taxonavigation}}`, `{{Taxobox}}`) on each
page. There are three realistic ways to consume it, in increasing order of
sanity:

| Source | What it gives you | Downsides |
|---|---|---|
| **Wikispecies MediaWiki API** (`species.wikimedia.org/w/api.php`) | Raw wikitext or parsed HTML per page | Must parse `{{Taxonavigation}}` wikitext by hand; brittle, inconsistent formatting; no ranks as data; no occurrence counts; heavy per-node fetching |
| **Wikidata** (`query.wikidata.org` SPARQL + `wikidata.org/wiki/Special:EntityData`) | Fully structured taxonomy: parent taxon (P171), taxon rank (P105), taxon name (P225), common name (P1843), images (P18), Wikispecies sitelink, Wikipedia sitelink, extinction (P576) | Not identical to Wikispecies content, though the two are tightly cross-linked; SPARQL endpoint has rate/etiquette limits |
| **GBIF / Catalogue of Life backbone** | Structured taxonomy with a real search + children + parents REST API, CORS-enabled, no parsing | Not Wikispecies at all — a different authority |

**Recommendation:** treat **Wikidata as the structured backbone of Wikispecies**.
Wikidata items carry the taxonomy as first-class properties *and* link out to the
Wikispecies page (sitelink `specieswiki`) and the Wikipedia article. This gives
us machine-readable ranks/parents/images while still letting us badge the source
as "Wikispecies" and link to the Wikispecies page. Pure-wikitext parsing of
Wikispecies pages should be a fallback for the handful of fields Wikidata lacks,
not the primary path.

The rest of the plan is written against a `TaxonProvider` abstraction so the
underlying source (Wikidata-backed, raw-Wikispecies, or GBIF) can be swapped
without touching the UI.

## What breaks when PBDB taxonomy leaves — the honest list

- **Occurrence counts (`noc`)** — the picker tree only shows groups that "actually
  have fossils" (`.filter((c) => c.noc > 0)`) and sorts "most-collected first"
  ([app.js:2829](../app.js)). Wikispecies/Wikidata have no fossil counts. These
  counts are intrinsically PBDB. Either drop the filter/sort, or fetch counts from
  PBDB separately per node (expensive), or accept a hybrid where counts are a
  best-effort PBDB overlay.
- **`base_name` still needs a PBDB-recognised name.** If Wikispecies uses a name
  PBDB doesn't know (or spells differently), the map comes back empty. The bridge
  must map the chosen Wikispecies taxon → a PBDB-valid query string.
- **Silhouettes** — currently PBDB `taxa/thumb.png` (PhyloPic-sourced). Wikidata
  has images (P18) and PhyloPic IDs (P6857); different assets, needs rework.
- **Stratigraphic range (first→last appearance, the `app` field)** — PBDB-only,
  derived from occurrences. Keep pulling this from PBDB for the info card's ⏳
  time-machine jump.
- **Classification labels on occurrences** (phylum/class/order/family via
  `show=class`, used in Compare grouping and CSV) — these are stamped on each PBDB
  *occurrence* by PBDB. They stay PBDB unless we re-derive family/order from
  Wikispecies per identified taxon (a lot of extra lookups).

## Inventory: every taxonomy touchpoint to migrate

All in `app.js`. Grouped by concern.

### A. Taxon search & picker (the tree of life)
- `fetchTaxonChildren()` [app.js:2808](../app.js) — `taxa/list.json?rel=children`.
  → Wikispecies children of a taxon.
- `liveSearch()` [app.js:2919](../app.js) — `taxa/auto.json` autocomplete.
  → Wikispecies/Wikidata name search.
- `taxonLineage()` [app.js:2780](../app.js) — `taxa/list.json?rel=all_parents`.
  → Wikispecies parent chain (P171 walk).
- `fetchTaxonRecord()` [app.js:2799](../app.js) — single record for reparenting.
- `TAXON_REPARENT` [app.js:2795](../app.js) — hand-patches (Avialae→Paraves,
  Aves→Avialae). **Likely deletable** once the source has correct placement.
- `POPULAR` seed list [app.js:2741](../app.js) — names are fine, but each must
  resolve in the new source.

### B. "About this taxon" info card
- `updateTaxonInfo()` [app.js:1062](../app.js) — `taxa/single.json?show=app,size,img,common`.
- `renderTaxonInfo()` [app.js:1082](../app.js) — rank, common name, authority,
  subtaxa count (`siz`), silhouette, extinct/living, PBDB link, stratigraphic range.
- `fetchTaxonSubtaxa()` [app.js:1207](../app.js) — immediate children list.
- `RANK` map [app.js:2093](../app.js) — PBDB numeric rank → label; Wikidata uses
  rank Q-items, so this needs a new mapping table.

### C. Enrichment / secondary cards
- `enrichTaxa()` [app.js:2066](../app.js) — silhouette + external links block.
- `fetchWiki()` [app.js:2054](../app.js) — already hits Wikipedia REST; keep.

### D. Compare & "similar formations" classification
- Compare grouping "by family, falling back to order/class/phylum"
  [app.js:2483](../app.js) — reads occurrence `show=class` fields. Stays PBDB
  unless re-derived.
- `findSimilarFormations()` [app.js:2555](../app.js) — pools genus/species taxa,
  queries PBDB. Occurrence-driven; stays PBDB.

### E. Occurrence queries that carry a taxon name (the bridge boundary)
- `buildFilters()` `base_name` [app.js:937](../app.js).
- Occurrence export [app.js:1291](../app.js), locality detail
  [app.js:1873](../app.js), Compare occ fetch [app.js:2296](../app.js).
  All send a taxon **string** to PBDB — the bridge must guarantee it's a
  PBDB-valid string.

## Proposed architecture

### 1. A `TaxonProvider` module (new file, e.g. `taxonomy.js`)

Define one interface, implement it against Wikispecies/Wikidata, keep PBDB as a
fallback implementation during migration:

```
TaxonProvider = {
  search(query)            → [{ name, rank, id, commonName }]        // autocomplete
  children(taxonId|name)   → [{ name, rank, id }]                    // picker drill-down
  parents(taxonId|name)    → [ ...lineage root→leaf ]                // tooltip + card
  info(taxonId|name)       → { name, rank, commonName, authority,
                               extinct, imageUrl, wikiSpeciesUrl,
                               wikipediaUrl, subtaxaCount }           // info card
}
```

- **Wikidata-backed impl:** one SPARQL query covers search/children/parents/info.
  Example child query: `?child wdt:P171 wd:<QID>` with `OPTIONAL` rank (P105),
  taxon name (P225), Wikispecies sitelink. Cache aggressively (`Map`, same pattern
  as the existing `taxChildCache`/`lineageCache`).
- Everything is `async` and returns plain objects — the existing picker/render
  code already awaits promises, so the call sites change but the control flow
  doesn't.

### 2. The name-reconciliation bridge (the critical piece)

A function `pbdbQueryName(taxon)` that turns a chosen Wikispecies/Wikidata taxon
into a string PBDB will accept for `base_name`:

- Fast path: the Wikispecies scientific name **is** valid in PBDB (most higher
  taxa — Dinosauria, Mammalia, Trilobita — are identical). Try it directly.
- Reconcile path: keep a `taxonName → pbdbName` override map for known
  mismatches, seeded from Wikidata's PBDB identifier property (**P5055**, "PBDB
  taxon ID") where present — Wikidata already stores the PBDB link for many taxa,
  so we can pre-resolve without guessing.
- Fallback: if PBDB returns zero occurrences for a name, surface a clear "no PBDB
  occurrences for this taxon" state rather than a silent empty globe, and offer
  the nearest PBDB-valid ancestor.

This bridge is also where occurrence **counts** get overlaid (confirmed: we keep
them). Counts come from PBDB `taxa/list.json?...&show=size`; to avoid hammering
PBDB per node, they are baked into the prebuilt index for common taxa and fetched
live only for the tail — see the next section.

### 3. Build-time merge, not a live service

We keep the app a **pure static front-end**. Rather than running an always-on
service that joins Wikidata + PBDB at request time, a Node build script does the
join once and emits a static artifact:

- **What it does:** walk the `POPULAR` seed taxa and their descendants; for each
  node pull Wikidata hierarchy/rank/name/image + Wikispecies sitelink, pull the
  PBDB occurrence count and P5055 name mapping, and write a merged
  `vendor/taxonomy-index.json` (keyed by name/QID).
- **Why:** the hierarchy is stable hour-to-hour and the useful set is bounded, so
  a prebuilt index covers the common paths with **zero runtime and zero hosting**.
  It also front-loads the slow, rate-limited Wikidata SPARQL work into CI instead
  of every visitor's browser.
- **The `TaxonProvider` reads the index first, live upstreams on miss.** Popular
  taxa (with counts) resolve instantly from the shipped JSON; the long tail falls
  through to direct client calls to Wikidata/PBDB. Same interface either way.
- **Refresh cadence:** re-run the build script in CI (e.g. weekly, or on demand)
  and commit the regenerated index — the same pattern already used for the
  PaleoDEM textures in `vendor/`.

**Upgrade path (only if the tail gets heavy):** because everything sits behind
`TaxonProvider`, the prebuilt-index reader can later be swapped for a small
edge-cached service (e.g. Cloudflare Worker + KV) exposing the identical merged
API — a drop-in change, no UI rework. Not needed on day one.

### 3. Keep PBDB for occurrences, ranges, and occurrence-level classification

No change to the occurrence/collection fetches, exports, Neotoma merge, Compare
tallies, or the stratigraphic-range calculation. Only the *name that goes in* is
now provided/validated by the bridge, and the info card's taxonomy fields come
from the provider (with the range still from PBDB).

## Phased rollout

**Phase 0 — Spike & validate (½–1 day).** Prove Wikidata/Wikispecies can answer
the four provider methods for ~20 representative taxa across the `POPULAR` list
(a supraordinal clade, a genus, an invertebrate order, a plant group). Confirm
CORS works from a static page (Wikidata REST and `api.php` both send permissive
CORS; verify). Measure latency vs PBDB. Decide Wikidata-primary vs raw-Wikispecies.

**Phase 1 — Provider module + feature flag.** Build `taxonomy.js` with both a
PBDB impl (wrapping current calls) and a Wikispecies impl behind a
`?taxonomy=wikispecies` flag / localStorage toggle. No UI change yet; both must
satisfy the same interface.

**Phase 2 — Autocomplete + picker tree.** Route `liveSearch`, `fetchTaxonChildren`,
`taxonLineage` through the provider. Overlay PBDB `noc` counts from the prebuilt
index (live fetch for the tail) so hide-empty/most-collected sorting survives.
Retire `TAXON_REPARENT` if the new source places Avialae/Aves correctly.

**Phase 3 — Info card.** Route `updateTaxonInfo`/`renderTaxonInfo`/
`fetchTaxonSubtaxa` through the provider; keep the stratigraphic range from PBDB;
swap silhouette source; add a "Wikispecies" source badge + link alongside (or
instead of) the PBDB link.

**Phase 4 — The bridge, hardened.** Implement `pbdbQueryName` with the P5055
overrides + empty-result fallback UI. This is where broken-taxonomy pain either
disappears or reappears, so test the long tail hard.

**Phase 5 — Compare / classification (optional, biggest cost).** Decide whether
to re-derive family/order labels from the provider or leave occurrence-level
`show=class` as-is. Leaving it is far cheaper and probably fine.

**Phase 6 — Copy, attribution, cleanup.** Update README, the `PBDB` source badges
in the UI, and licensing/attribution: Wikispecies and Wikidata are **CC0**
(Wikidata) / **CC BY-SA** (Wikispecies text) — different from PBDB's CC-BY, so the
export citation line ([app.js:1254](../app.js)) and on-card credits must reflect
whichever data actually shipped in each field.

## Risks & open questions

- **Empty maps from name mismatch** — the top risk. Mitigated by the bridge +
  P5055 pre-resolution + explicit empty-state UI. Must be validated on the tail,
  not just the popular clades.
- **Occurrence-count freshness** — counts are overlaid (confirmed) but come from a
  periodically-rebuilt static index, so they lag PBDB slightly between rebuilds.
  Acceptable for a "most-collected-first" sort; document that they're indicative.
- **Fossil/extinct coverage** — Wikispecies/Wikidata skew toward extant taxa;
  some purely-fossil clades may be thinner or use different names than PBDB. Spot-
  check invertebrate and microfossil groups (Foraminifera, Conodonta) in Phase 0.
- **Rate limits & latency** — SPARQL is slower than PBDB's JSON endpoints and has
  usage etiquette. Mitigated by the build-time merge (SPARQL runs in CI, not the
  browser) plus the shipped `vendor/` index; only the tail hits SPARQL live.
- **Two sources of truth** — hierarchy from Wikispecies but occurrences (and their
  stamped classification) from PBDB can visibly disagree (a taxon nested one way
  in the picker, grouped another way in Compare). Document the boundary; pick one
  source per surface.
- **Wikitext-only fields** — a few things (some fossil-specific placements, certain
  authorities) may live in Wikispecies wikitext but not Wikidata. Confirmed we lead
  with Wikidata and parse Wikispecies wikitext only as a targeted fallback for
  those gaps, rather than for the whole hierarchy.

## Bottom line

The taxonomy **display and navigation** layer moves to a `TaxonProvider`
abstraction backed by **Wikidata's** structured taxon data (which links back to
Wikispecies pages). The fossil **occurrences** stay on PBDB, so the make-or-break
deliverable is the **name-reconciliation bridge** that keeps a Wikidata-chosen
taxon resolving to PBDB occurrences. **PBDB occurrence counts are overlaid** (not
dropped), sourced from a **build-time merged static index** in `vendor/` so the
app stays a pure static front-end with no live backend — with an edge service
kept as a later drop-in behind the same interface. Everything else is a staged,
low-risk swap behind a feature flag.
