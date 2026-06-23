# PDMap — Fossil Globe

A "Google Earth" style 3-D globe for exploring fossil localities from the
[Paleobiology Database](https://paleobiodb.org/) (PBDB).

Search by **taxon**, **geological period / age**, and **depositional environment**,
optionally limited to the part of the globe you're looking at. Click any locality
to see the fossils found there, each with a Phylopic silhouette and external links
to Wikipedia, fossil photos, life reconstructions, and the PBDB taxon page.

You can also flip the whole map onto the **ancient Earth** using PBDB
paleo-coordinates, with the continents reconstructed at the relevant age, to see
where each site sat when the rock was laid down — and use the **time machine** to
sweep through deep time and watch the continents (and the fossils on them) move.

![globe](docs/preview.png)

## Features

- **Filters** — taxon (with a tree-of-life picker + live autocomplete), exclude
  sub-groups, geological interval (full ICS tree), custom age range (Ma / ka / yr),
  named formation, depositional environment, and the current viewport.
- **Time machine** — a deep-time slider with a ▶ play button that sweeps the age
  window through geological time; in ancient-Earth mode the continents drift with it.
- **Ancient Earth** — true paleogeographic continents from GPlates (PALEOMAP),
  with fossils plotted on their paleo-coordinates.
- **Diversity panel** — a live breakdown of the current results by period, country
  and formation, plus total localities and occurrences.
- **Density view** — aggregates localities into weighted hexbins so fossil-rich
  regions and sampling hot-spots stand out when zoomed out.
- **Interactive legend** — click a period to isolate points of that age.
- **Bedrock context** — clicking a locality looks up the rock unit and lithology
  at that spot from [Macrostrat](https://macrostrat.org/).
- **Jump to place** — fly the globe to any named place (OpenStreetMap search).
- **Shareable permalinks** — the full query (filters + toggles) lives in the URL;
  copy a link to reproduce any view exactly.
- **Saved searches** — name and reload any filter combination (stored locally).
- **Export** — download the plotted localities as **CSV**, **GeoJSON** or **KML**
  (opens in Google Earth / QGIS), each carrying the PBDB CC-BY citation.
- **Accessibility** — a colour-blind-safe (viridis) age palette toggle, and a
  mobile bottom-sheet layout for phones.

## How it works

It's a **pure static web app** — just `index.html`, `style.css`, `app.js`.
There is no backend and no database. The PBDB data service is CORS-enabled, so the
browser queries it directly:

- `GET /data1.2/colls/list.json` — fossil localities (plotted as points)
- `GET /data1.2/occs/list.json` — the taxa at a clicked locality
- `GET /data1.2/taxa/thumb.png` — Phylopic silhouettes

The 3-D globe is rendered with [globe.gl](https://globe.gl/) (Three.js), loaded
from a CDN. **An internet connection is required** — both for the PBDB API and for
the globe library / Earth textures.

## Running it

Because it's static, any web server works. The only requirement is to serve it over
HTTP (opening `index.html` as a `file://` URL works in most browsers too, but a
local server is more reliable). Python 3 is on both macOS and Oracle Linux 9 out of
the box.

### macOS

```bash
cd PDMap
python3 -m http.server 8000
# then open http://localhost:8000
```

### Oracle Linux 9 (server)

```bash
cd /path/to/PDMap
python3 -m http.server 8000
# open http://<server-ip>:8000 from your browser
```

Open port 8000 if a firewall is in the way:

```bash
sudo firewall-cmd --add-port=8000/tcp --permanent
sudo firewall-cmd --reload
```

For a long-running deployment behind nginx, just point a `location` block at this
folder (`root /path/to/PDMap;`) — there is nothing to build or compile.

A convenience script is included:

```bash
./serve.sh            # serves on :8000
./serve.sh 9000       # custom port
```

## Filters

| Filter | PBDB parameter | Notes |
|---|---|---|
| Taxon name | `base_name` | Any rank; includes all sub-groups. Has a live picker — focus the box for popular groups, or type for autocomplete suggestions (via PBDB's `taxa/auto` endpoint) showing each match's rank and occurrence count. |
| Geological period | `interval` | Dropdown of ICS periods. |
| Custom age range | `max_ma` / `min_ma` | Overrides the period dropdown. Ages in millions of years. |
| Environment | `envtype` | Terrestrial / Marine / Lacustrine / Fluvial. |
| Only current view | `latmin/latmax/lngmin/lngmax` | Bounding box estimated from the globe camera. |
| Max results | `limit` | Caps how many localities are fetched. |

## Sending it to other people (the kit)

`PDMap-kit.zip` is a self-contained bundle you can send to anyone on Windows,
macOS or Linux. It includes the app plus the globe library and Earth textures
vendored locally, so the only things fetched at runtime are the live fossil data
and photos.

The recipient unzips it and either:

- **double-clicks `index.html`** (works in Chrome, Edge and Safari), or
- runs the launcher for their OS — `Start-PDMap-Windows.bat`,
  `Start-PDMap-Mac.command`, or `Start-PDMap-Linux.sh` — which starts a tiny local
  server (used as a fallback for browsers that are strict about `file://`).

`START-HERE.txt` inside the zip explains this in plain language for non-technical
users. To rebuild the kit after changes, re-run the staging/zip steps (the kit is
just the app files + `vendor/` + the launchers).

## Install it on a phone (PWA)

PDMap is a Progressive Web App, so it can be installed on an iPhone or Android
home screen and run full-screen like a native app — no app store, no build.

Installing on a phone requires the app to be **served over the network** (a phone
can't open the desktop's `file://`). Two easy ways:

1. **Same Wi-Fi:** run a launcher on a computer (`Start-PDMap-*`), find that
   computer's IP, and on the phone visit `http://<computer-ip>:8000/`.
2. **Host it:** drop this folder on any static host (GitHub Pages, Netlify, an
   nginx server, etc.) and open the URL on the phone. **HTTPS is required** for
   installation when it isn't `localhost`.

Then:

- **iPhone (Safari):** Share → *Add to Home Screen*.
- **Android (Chrome):** menu → *Install app* / *Add to Home screen*.

The app shell (globe library, Earth textures, icons) is cached by a service
worker so it loads instantly after the first visit; the fossil data and photos
are always fetched live, so they stay current (and need a connection).

Turning this into true App Store / Play Store apps is a separate step
([Capacitor](https://capacitorjs.com/) wraps this same code) — see the notes you
were given; the code here is already PWA-ready.

## Data sources

| Source | Used for | Licence |
|---|---|---|
| [Paleobiology Database](https://paleobiodb.org/) | Fossil localities & occurrences | CC-BY |
| [PhyloPic](https://www.phylopic.org/) (via PBDB) | Taxon silhouettes | Public domain / CC |
| [Wikipedia REST API](https://en.wikipedia.org/api/rest_v1/) | Real photos + descriptions per taxon | CC-BY-SA |
| [GPlates Web Service](https://gws.gplates.org/) | Reconstructed coastlines (PALEOMAP) for ancient-Earth view | CC-BY |
| [Macrostrat](https://macrostrat.org/) | Bedrock map unit + lithology at a clicked locality | CC-BY |
| [Nominatim / OpenStreetMap](https://nominatim.openstreetmap.org/) | "Jump to place" geocoding | ODbL |

All of these are public, CORS-enabled, and need no API key.

**Other open datasets that could still be layered in later** (all have public APIs):

- **[GBIF](https://www.gbif.org/)** — hundreds of millions of occurrence records,
  including fossils and the modern relatives of extinct groups, often with photos.
- **[Encyclopedia of Life](https://eol.org/)** — additional imagery and trait data.

## Notes & limitations

- The "only current view" box is an approximation derived from the camera position,
  not a precise selection rectangle.
- On the ancient-Earth (paleo) view, points are placed at their paleo-coordinates
  and the continents are reconstructed from GPlates (PALEOMAP) coastlines for the
  chosen age. Reconstructions are model estimates, and only the largest landmasses
  are drawn (tiny islets are dropped for performance), so treat it as a close
  approximation rather than an exact map. Reconstructions span 0–750 Ma.
- Bedrock context comes from Macrostrat, whose coverage is strongest in North
  America; many localities elsewhere will show no rock-unit details.
- Silhouettes come from [PhyloPic](https://www.phylopic.org/) via PBDB and aren't
  available for every taxon; a 🦴 placeholder is shown when missing.
