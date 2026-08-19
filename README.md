# Fawn's Mark Plotter

A static web app for Massachusetts Bay racing: pick your yacht club and
tonight's course, and it plots the marks on a chart and gives you the
compass heading and distance for every leg.

## How it works

1. Pick your **Yacht Club** (BYC, EYC, CYC, JYC).
2. BYC and JYC run their own club-specific mark list for weeknight racing
   (BYC Wednesday Night, JYC Thursday Night); pick that or "weekend /
   regatta" to use the shared **MBSA Standard Rounding Marks** (Lists A, B,
   C) that all four clubs use for regattas.
3. Build the course by adding marks in order (repeats allowed, e.g. a
   windward mark sailed twice). Portable marks (start/finish pins, windward
   marks set by the Race Committee) have no fixed position — you can
   optionally type in tonight's RC-set lat/lon to include that leg.
4. The app plots the course on a map and lists the distance and true
   (and optionally magnetic) heading for every leg.

**Always confirm marks and the course against the official Sailing
Instructions and Race Committee signals before racing.**

## Data

Mark positions live in [`data/marks.json`](data/marks.json), built from the
raw club mark lists in [`data/sources/`](data/sources/) by
[`scripts/build_data.py`](scripts/build_data.py). To update the data after a
club publishes a new mark list, replace the relevant CSV/JSON in
`data/sources/` and re-run:

```
python3 scripts/build_data.py
```

## Running locally

This is a plain static site — no build step, no dependencies. Serve the
folder with any static file server, e.g.:

```
python3 -m http.server 8000
```

then open <http://localhost:8000>.

## Deploying (GitHub Pages)

A workflow at [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
deploys the site to GitHub Pages on every push to `main`. One-time setup: in
the repo's **Settings → Pages**, set **Source** to **GitHub Actions**. After
that, every push to `main` republishes the site automatically.
