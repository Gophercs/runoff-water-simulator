# Runoff

*By Gophercs and Claude.*

Load a lidar terrain model, pick an area, and see where the water goes. Rain on it, pour water on it, add springs and culverts, build barriers, swales and ponds, paint in different soils, and watch it run off, soak in and find its level.

It runs entirely in your web browser. There's no server, no account and no install: the whole thing is one HTML file.

## Using it

**Online:** open the hosted copy (see "Putting it online" below), or any copy of `dist/index.html` served from a website.

**Offline on a laptop:** download `dist/index.html` and double-click it. It works with no internet connection in Chrome, Edge and Firefox. Phones are fussy about opening local HTML files, so on a phone use a hosted copy instead.

### Terrain data

Runoff reads ASCII grids (`.asc`) and GeoTIFFs (`.tif`) with heights in metres. In England, the Environment Agency's National LIDAR Programme DTM tiles work as they come; download them free from the [Defra Survey Data Download](https://environment.data.gov.uk/survey) service (Open Government Licence) and unzip them first. A demo valley is built in if you just want to try it.

Use a **DTM** (bare ground). A DSM includes trees and buildings as solid lumps.

**Or skip the download.** Type a postcode, place name or grid reference into "Find an area" and Runoff pulls the lidar straight from the Environment Agency's Web Coverage Service: first an overview of the surrounding area (2 to 8 km across, 4 km by default), then just the box you choose at 1 m (2 m for larger boxes, up to 4 km across). England only, and it needs a browser that can reach the service, so it works in the hosted and offline copies but not inside a claude.ai artifact.

Data fetched this way is © Environment Agency copyright and/or database right, under the Open Government Licence. Place search uses [postcodes.io](https://postcodes.io).

**Where things are kept.** Everything stays in the user's own browser; the host (Cloudflare or anywhere else) only serves the app file. Saved scenarios hold settings and recipes, not terrain. Scenarios built on Environment Agency lidar remember their box and fetch it again when loaded, and downloaded lidar is cached in the browser (IndexedDB, the most recent 40 downloads), so reopening a scenario usually costs no API call at all. Scenarios built on your own files need that file opened first.

**Ordnance Survey backdrop (optional).** Paste a free [OS Data Hub](https://osdatahub.os.uk) API key into the Terrain panel and Runoff draws an OS map under the terrain, in the map view and draped over the 3D view. Fade it in with the Map slider above the view. OS tiles come in British National Grid, the same grid as the lidar, so they line up without any reprojection. The key is kept in your browser and sent only to OS. On the free OpenData plan the closest British National Grid zoom levels are Premium, so Runoff uses the most detailed free level (1.75 m per pixel) and scales it up. If your key includes Premium, tick the option to unlock closer zoom and the Leisure map. Contains OS data © Crown copyright and database rights.

### What you can do

| | |
|---|---|
| **Water** | Pour water anywhere, add springs with a set flow, rain at a set rate for a set time |
| **Earthworks** | Barriers (level crest or following the ground), ditches, swales that follow the contour, ponds dug to a flat bottom (tiers welcome) |
| **Drainage** | Culverts: pipes of a set size through roads and banks, which lidar can't see |
| **Soil** | Eleven soil textures and seven land covers, set once for the whole area or painted in zones |
| **Look** | 2D map or 3D view, zoom and pan, full screen, contours, six shading styles (including greyscale, rainbow height and soil type), depth now or deepest so far, pond volumes, a running water balance |
| **Keep** | Save and load setups, export and import them as files |
| **Find** | Search for a place and download Environment Agency lidar for it, no manual download needed |
| **Backdrop** | Optional Ordnance Survey map under the terrain, in 2D and 3D |

Everything you add appears in a list under the tools, where you can change its main setting or delete it.

The logo doubles as a status light: it fills with water as terrain loads, sits calm when paused and sloshes while the simulation runs.

## How the water moves

Each cell of the map holds a water depth. Every step, the flow across each cell edge speeds up or slows down according to the difference in water surface height either side, and is held back by ground roughness (Manning's n). This is the **local inertial** form of the shallow water equations used by the LISFLOOD-FP flood model (Bates et al. 2010), with the smoothing of de Almeida et al. (2012) that stops it wobbling on flat water. The step length shrinks automatically when water gets deep, which keeps it stable. A limiter stops any cell sending out more water than it holds.

**Soaking in** uses the Green-Ampt method with the soil parameters of Rawls, Brakensiek & Miller (1983). Dry soil takes water fast at first, slowing towards a steady rate as it wets. Land cover scales the soil's rate and sets the roughness.

**Culverts** use the orifice equation with the inlet in control: flow depends on the level difference and the pipe size.

**Nothing is created or lost:** every drop is accounted for as rain, poured, from springs, on the ground, gone off the edges, or soaked in. The panel shows the running total and anything unaccounted for.

## Checks it passes

Run `node tests/core.test.js` for the physics checks:

- A pool in a bowl settles flat to within a ten-thousandth of a millimetre, with water conserved to rounding error.
- Rain on a uniform slope reaches the textbook Manning depth to within 1.5%.
- A dam holds with the valley below it bone dry until the pond reaches its crest, then spills.
- A culvert levels two basins and conserves water.
- Loam under 30 mm/hr rain starts ponding at 5.0 minutes; the Green-Ampt formula says 4.9.

Open `tests/engines.html` in a browser to check that the engines agree on your machine (see below).

## Engines

The same physics runs three ways. The app times each one on your area and picks the fastest.

- **One core:** the reference. Exact to the last digit.
- **All cores:** the map is cut into strips, one per processor core, which swap edge rows every step. It gives bit-for-bit identical results to one core.
- **Graphics card (WebGPU):** the whole step runs on the graphics card. It uses 32-bit numbers, so results agree with the others to a small fraction of a percent, and the water balance shows a tiny rounding error. Fast on a proper graphics card; integrated laptop graphics may be slower than the processor.

## Not for flood-risk decisions

Runoff is a well-behaved model, not a validated one. Use it to think about where water goes; check anything that matters against what actually happens on the ground and against official flood maps. It comes with no warranty (see the licence).

## Privacy

There's no tracking and no account. Terrain files, saved setups and results stay in your browser. The only things sent anywhere are place searches (to postcodes.io), lidar requests (to the Environment Agency) and map tiles (to Ordnance Survey).

## Known limits

- **Soil is treated as deep.** Shallow soils or a rising water table filling up (common on UK hillsides in winter) aren't modelled; "Soil starts: Saturated" is the stand-in.
- **Land cover multipliers are rough guides.** Woodland in particular varies a lot in the field.
- **Bridges and culverts are often missing or solid in a DTM.** Roads can act as dams until you add culverts.
- **Culverts ignore pipe length and friction,** so long narrow pipes are over-generous.
- **Very shallow sheets of water on steep ground** are this method's weakest case.
- **Treat results as a well-behaved model, not a validated one,** until you've compared them with what actually happens on your ground.

## Putting it online

It's one static file, so any static host works. Two free options:

- **Cloudflare Pages** or **Netlify:** connect this repository, set the build command to `python3 build.py` and the output directory to `dist`.
- **GitHub Pages:** in the repository settings, publish from the branch and folder containing `index.html` (you may want to copy `dist/index.html` to a `docs/` folder and publish that).

### A shared map key for your visitors (optional)

So people get the OS map without signing up, a hosted build can include a shared OS Maps API key. The key is read at build time from the `RUNOFF_OS_KEY` environment variable (in Cloudflare Pages: Settings, then Environment variables), or from a local `os_key.txt`, which git ignores. It never goes in the repository: `os_key.txt` and the built `dist/` folder are both git-ignored, and Cloudflare builds `dist/` itself.

A key in a web page is visible to anyone who looks, so use one from **its own OS Data Hub project with only the OS Maps API on the free OpenData plan**. Then there's nothing on it that costs money. OS limits how many requests a project can make per minute, so if it gets busy, visitors can add their own key in the app, and anyone with a Premium key can tick the Premium option there.

## Working on it

```
src/
  shell.html     page layout and styles
  sim_core.js    the physics (reference engine)
  gpu.js         WebGPU engine
  pool.js        multi-core engine (worker threads)
  app_head.js    loading terrain, choosing an area, 2D view
  app_tail.js    everything else: tools, 3D, ponds, soils, scenarios
  logo.js        the animated water-filled logo
vendor/          three.js, geotiff.js, fonts, favicon, and their licences
tests/           physics checks (Node) and engine checks (browser)
tools/           make_logo.py
build.py         inlines everything into dist/index.html
```

Edit files in `src/`, then run `python3 build.py`. To change the tab icon, replace `vendor/favicon.png`. The version number lives at the top of `build.py`. The logo lettering is stored as outlines in `src/logo.js`; `tools/make_logo.py` regenerates them from a font.

If you change the physics, change it in all three engines and run both sets of checks: all cores must still match one core exactly.

## References

- Bates, P.D., Horritt, M.S. & Fewtrell, T.J. (2010). A simple inertial formulation of the shallow water equations for efficient two-dimensional flood inundation modelling. *Journal of Hydrology* 387, 33–45.
- de Almeida, G.A.M., Bates, P., Freer, J.E. & Souvignet, M. (2012). Improving the stability of a simple formulation of the shallow water equations for 2-D flood modeling. *Water Resources Research* 48, W05528.
- Rawls, W.J., Brakensiek, D.L. & Miller, N. (1983). Green-Ampt infiltration parameters from soils data. *Journal of Hydraulic Engineering* 109(1), 62–70.

## Licence

Copyright (C) 2026 Gophercs. Written by Gophercs and Claude.

Runoff is free software under the **GNU General Public License v3.0 or later** (see `LICENSE`). You can use, change and share it; anything you distribute that's built on it must stay open under the same terms.

It bundles [three.js](https://threejs.org) (MIT), [geotiff.js](https://geotiffjs.github.io) (MIT) and the [Atkinson Hyperlegible](https://www.brailleinstitute.org/freefont/) typeface (SIL Open Font License 1.1). The logo is drawn from the Ubuntu Condensed typeface (Ubuntu Font Licence 1.0). Their licences are in `vendor/`.
