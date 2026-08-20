# Fawn's Mark Plotter

A static web app for Massachusetts Bay racing, built for one-handed use on a
phone at the helm: pick your yacht club and tonight's course, and it plots
the marks on a full-screen map and gives you the compass heading and
distance for every leg.

## How it works

1. Pick your **Yacht Club** (BYC, EYC, CYC, JYC) in the bottom sheet.
2. BYC and JYC run their own club-specific mark list for weeknight racing
   (BYC Wednesday Night, JYC Thursday Night); pick that or "weekend /
   regatta" to use the shared **MBSA Standard Rounding Marks** (Lists A, B,
   C) that all four clubs use for regattas.
3. Build the course by typing or picking marks in order (repeats allowed,
   e.g. a windward mark sailed twice) — each one becomes a chip.
4. Tap **📍** to show your live GPS position on the map, and **🚩 Set Start**
   to pin tonight's actual start-line position from your GPS fix (applied to
   every occurrence of that mark, so a shared start/finish pin gets both).
5. Tap **Set Course** to plot it: the sheet collapses to a full-screen map
   with a swipeable strip of leg cards (heading + distance) above the handle.
   Tap the handle any time to reopen and edit the course.

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
