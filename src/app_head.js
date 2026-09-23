(() => {
const $ = s => document.querySelector(s);
const view = $('#view'), ctx = view.getContext('2d');
const well = $('#well'), probe = $('#probe'), glCanvas = $('#gl');
let MAX_AUTO_CELLS = 160000;

let mode = 'empty';      // empty | select | sim
let dem = null;          // {w,h,z:Float32Array,cell,ox,oy,name}
let ov = null;           // overview {w,h,f,img}
let sel = null;          // {x0,y0,x1,y1} in dem cells
let region = null;       // {w,h,dx,k,x0,y0,z,nodata,base,img}
let S = null, running = false;

/* ---------- loading ---------- */
function setInfo(msg, isErr) {
  const el = $('#fileinfo'); el.textContent = msg; el.classList.toggle('err', !!isErr);
}

// read a file in chunks so the page keeps animating (and shows progress) instead of freezing
async function readFile(f, asText, onProgress) {
  if (!f.stream) return asText ? await f.text() : await f.arrayBuffer();
  const reader = f.stream().getReader(), total = f.size || 1;
  const chunks = []; const dec = asText ? new TextDecoder() : null;
  let got = 0, text = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    got += value.length;
    if (asText) text += dec.decode(value, { stream: true }); else chunks.push(value);
    onProgress(got / total);
  }
  if (asText) return text + dec.decode();
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf.buffer;
}

async function parseASC(text, onProgress) {
  const hdr = {}; let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const line = text.slice(pos, nl < 0 ? text.length : nl).trim();
    if (line && !/^[A-Za-z]/.test(line)) break;
    if (line) { const p = line.split(/\s+/); hdr[p[0].toLowerCase()] = parseFloat(p[1]); }
    if (nl < 0) break; pos = nl + 1;
  }
  const w = hdr.ncols, h = hdr.nrows, cell = hdr.cellsize;
  if (!w || !h || !cell) throw new Error('This file has no ncols, nrows or cellsize header, so it doesn’t look like an ASCII grid.');
  const z = new Float32Array(w * h); const L = text.length; let n = 0, i = pos;
  let nextYield = 300000;
  while (n < w * h && i < L) {
    if (text.charCodeAt(i) <= 32) { i++; continue; }
    let j = i; while (j < L && text.charCodeAt(j) > 32) j++;
    z[n++] = parseFloat(text.slice(i, j)); i = j;
    if (n >= nextYield) { nextYield += 300000; if (onProgress) onProgress(n / (w * h)); await new Promise(r => setTimeout(r, 0)); }
  }
  if (n < w * h) throw new Error(`The file ended after ${n} values; the header promised ${w * h}.`);
  let xll = hdr.xllcorner, yll = hdr.yllcorner;
  if (xll === undefined && hdr.xllcenter !== undefined) { xll = hdr.xllcenter - cell / 2; yll = hdr.yllcenter - cell / 2; }
  return { w, h, z, cell, nodata: hdr.nodata_value, ox: xll ?? 0, oy: (yll ?? 0) + h * cell };
}

async function parseTIFF(buf) {
  const G = window.GeoTIFF;
  if (!G) throw new Error('The GeoTIFF reader didn’t load. Check your connection and reload the page.');
  const tiff = await G.fromArrayBuffer(buf); const im = await tiff.getImage();
  const w = im.getWidth(), h = im.getHeight();
  let cell = 1, ox = 0, oy = 0, geo = true;
  try { const r = im.getResolution(); cell = Math.abs(r[0]); const o = im.getOrigin(); ox = o[0]; oy = o[1]; }
  catch (e) { geo = false; }
  const ras = await im.readRasters({ samples: [0], interleave: true });
  const z = ras instanceof Float32Array ? ras : Float32Array.from(ras);
  return { w, h, z, cell, nodata: im.getGDALNoData(), ox, oy, geo, spp: im.getSamplesPerPixel(), bits: (b => typeof b === 'number' ? b : 32)(im.getBitsPerSample(0)) };
}

function finishDEM(d, name) {
  const N = d.w * d.h; let bad = 0, lo = Infinity, hi = -Infinity;
  const nd = d.nodata;
  for (let i = 0; i < N; i++) {
    const v = d.z[i];
    if (v === nd || !(v > -1000 && v < 10000)) { d.z[i] = NaN; bad++; }
    else { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (bad === N) throw new Error('Every cell in this file is marked as missing data.');
  d.name = name;
  dem = d;
  let msg = `${name}: ${d.w.toLocaleString()} × ${d.h.toLocaleString()} cells at ${+d.cell.toFixed(3)} m, heights ${lo.toFixed(1)} to ${hi.toFixed(1)} m`;
  if (bad) msg += `, ${(100 * bad / N).toFixed(1)}% missing`;
  msg += '.';
  if (d.cell < 0.01) msg += ' The cell size looks like degrees, not metres, so distances and flow speeds will be wrong. Reproject to British National Grid first.';
  else if (d.geo === false) msg += ' No georeferencing found, so 1 m cells are assumed.';
  setInfo(msg, d.cell < 0.01);
  buildOverview();
  sel = { x0: 0, y0: 0, x1: d.w, y1: d.h };
  enterSelect();
}

$('#file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  setInfo(`Reading ${f.name}…`);
  stopSim(); setLogo('loading', 0.01);
  await new Promise(r => setTimeout(r, 30));
  try {
    const isTiff = /\.tiff?$/i.test(f.name);
    const raw = await readFile(f, !isTiff, p => setLogo('loading', p * 0.45));
    setLogo('loading', 0.46);
    await new Promise(r => setTimeout(r, 20));
    const d = isTiff ? await parseTIFF(raw) : await parseASC(raw, p => setLogo('loading', 0.46 + p * 0.5));
    setLogo('loading', 1); await new Promise(r => setTimeout(r, 30));
    finishDEM(d, f.name); setLogo('calm');
  } catch (err) {
    setInfo(err.message || String(err), true); setLogo(dem ? 'calm' : 'idle');
  }
  e.target.value = '';
});

$('#demo').addEventListener('click', async () => {
  stopSim(); setLogo('loading'); await new Promise(r => setTimeout(r, 350));
  const w = 420, h = 320, cell = 2, z = new Float32Array(w * h);
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bumps = []; for (let k = 0; k < 40; k++) bumps.push([rnd() * w, rnd() * h, 6 + rnd() * 18, (rnd() - 0.5) * 1.6]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx = 90 + x * 0.55 + Math.sin(x / 38) * 22;                // meandering valley line
    const dv = y - cx;
    let v = 60 - x * 0.035 + Math.min(Math.abs(dv) * 0.09, 14) + dv * dv * 0.00015;
    v -= Math.max(0, 1.2 - Math.abs(dv) * 0.35);                      // stream channel
    const px = x - 300, py = y - 70; v -= 3.2 * Math.exp(-(px * px + py * py) / 900); // hollow
    if (Math.abs(x - 250) < 3) v = Math.max(v, 57.2);                  // embankment, no culvert
    for (const b of bumps) { const dx = x - b[0], dy = y - b[1]; v += b[3] * Math.exp(-(dx * dx + dy * dy) / (b[2] * b[2])); }
    z[y * w + x] = v + (rnd() - 0.5) * 0.06;
  }
  finishDEM({ w, h, z, cell, nodata: undefined, ox: 0, oy: h * cell }, 'Demo valley'); setLogo('calm');
  setInfo('Demo valley: 840 × 640 m at 2 m cells. There’s a road embankment across it with no culvert, and a hollow on the far slope.');
});

/* ---------- shading ---------- */
function shade(z, w, h, dx, out, mapPix) {
  const vals = [], stp = Math.max(1, Math.floor(w * h / 20000));
  for (let i = 0; i < w * h; i += stp) { const v = z[i]; if (v === v) vals.push(v); }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)] ?? 0, hi = vals[Math.floor(vals.length * 0.98)] ?? 1;
  const span = Math.max(hi - lo, 0.01);
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  const Lx = Math.sin(az) * Math.cos(alt), Ly = Math.cos(az) * Math.cos(alt), Lz = Math.sin(alt);
  const ex = 2;
  const pal = paletteFn(), rel = reliefFn();
  const mix = mapPix ? (+document.getElementById('mapMix').value || 0) / 100 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i * 4, v = z[i];
    if (v !== v) { out[j] = 88; out[j + 1] = 98; out[j + 2] = 106; out[j + 3] = 255; continue; }
    const g = (k) => { const q = z[k]; return q === q ? q : v; };
    const l = x > 0 ? g(i - 1) : v, r = x < w - 1 ? g(i + 1) : v;
    const u = y > 0 ? g(i - w) : v, d = y < h - 1 ? g(i + w) : v;
    const nx = -(r - l) / (2 * dx) * ex, ny = -(u - d) / (2 * dx) * ex;
    const len = Math.sqrt(nx * nx + ny * ny + 1);
    const hs = Math.max(0, (nx * Lx + ny * Ly + Lz) / len);
    let t = (v - lo) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const c = pal(t), k = rel(hs);
    let R = c[0] * k, G = c[1] * k, B = c[2] * k;
    if (mix) { const q = 0.55 + 0.45 * k;    // keep a hint of relief through the map
      R += (mapPix[j] * q - R) * mix; G += (mapPix[j + 1] * q - G) * mix; B += (mapPix[j + 2] * q - B) * mix; }
    out[j] = R; out[j + 1] = G; out[j + 2] = B;
    out[j + 3] = 255;
  }
}

// terrain shading: colour by height (0..1 across the area's height range) times relief from the hillshade
const PALETTES = {
  earth: [[150, 168, 138], [196, 188, 152], [168, 138, 108]],
  meadow: [[118, 156, 104], [196, 200, 128], [214, 186, 128]],
  slate: [[112, 92, 128], [126, 146, 172], [196, 204, 212]],
  grey: [[186, 186, 186], [186, 186, 186], [186, 186, 186]]
};
function shadingMode() { const el = document.getElementById('shading'); return el ? el.value : 'earth'; }
function hslRgb(hh, s, l) {
  const f = n => { const k = (n + hh / 30) % 12, a = s * Math.min(l, 1 - l); return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return [f(0), f(8), f(4)];
}
function paletteFn() {
  const m = shadingMode();
  // rainbow runs green, yellow, orange, red, magenta: blue is left for water
  if (m === 'rainbow') return t => hslRgb(((120 - 180 * t) + 360) % 360, 0.72, 0.52);
  const st = PALETTES[m] || PALETTES.earth;
  return t => { const a = t < 0.5 ? st[0] : st[1], b = t < 0.5 ? st[1] : st[2], f = t < 0.5 ? t * 2 : t * 2 - 1;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };
}
function reliefFn() {
  const m = shadingMode();
  if (m === 'rainbow') return hs => 0.55 + 0.5 * hs;
  if (m === 'grey') return hs => 0.22 + 0.98 * hs;
  return hs => 0.3 + 0.85 * hs;
}
function buildOverview() {
  const f = Math.max(1, Math.ceil(Math.max(dem.w, dem.h) / 1000));
  const w = Math.ceil(dem.w / f), h = Math.ceil(dem.h / f);
  const z = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) z[y * w + x] = dem.z[Math.min(dem.h - 1, y * f) * dem.w + Math.min(dem.w - 1, x * f)];
  const mix = (+document.getElementById('mapMix').value || 0) / 100;
  const useMap = dem.mapCv && mix > 0;
  const img = new ImageData(w, h); shade(z, w, h, dem.cell * f, img.data, null);
  const up = useMap ? Math.max(1, Math.round(1600 / Math.max(w, h))) : 1;
  if (!useMap) { ov = { w, h, f, img }; return; }
  // draw the preview at map resolution: relief shading scaled up smoothly underneath, the OS map crisp on top
  const W = w * up, H = h * up, cv = document.createElement('canvas'), small = document.createElement('canvas');
  small.width = w; small.height = h; small.getContext('2d').putImageData(img, 0, 0);
  cv.width = W; cv.height = H; const c = cv.getContext('2d'); c.imageSmoothingEnabled = true; c.drawImage(small, 0, 0, W, H);
  const base = c.getImageData(0, 0, W, H), map = samplePix(dem.mapCv, W, H), px = base.data;
  for (let j = 0; j < px.length; j += 4) {
    const lum = (px[j] + px[j + 1] + px[j + 2]) / 540, q = 0.6 + 0.4 * Math.min(1.2, lum);   // a hint of relief through the map
    px[j] += (map[j] * q - px[j]) * mix; px[j + 1] += (map[j + 1] * q - px[j + 1]) * mix; px[j + 2] += (map[j + 2] * q - px[j + 2]) * mix;
  }
  ov = { w: W, h: H, f: f / up, img: base };
}

/* ---------- canvas sizing ---------- */
// 2D view: the canvas sits inside the well at a fit scale times a zoom factor, positioned by left/top
const Z2 = { k: 1, left: 0, top: 0, base: 1 };
const isFull = () => !!document.fullscreenElement || document.body.classList.contains('maxi');
function wellMaxH() {
  if (isFull()) return Math.max(150, well.clientHeight - 2);   // full screen: the well is sized by the layout
  return Math.max(320, window.innerHeight * 0.78);
}
function fitCanvas(reset) {
  if (typeof fitGL === 'function' && !glCanvas.hidden) fitGL();
  if (view.hidden) return;
  const maxW = well.clientWidth - 2, maxH = wellMaxH();
  Z2.base = Math.min(maxW / view.width, maxH / view.height);
  const hgt = isFull() ? maxH : Math.floor(view.height * Z2.base);
  if (!isFull() && Math.abs(well.clientHeight - hgt) > 1) well.style.height = hgt + 'px';
  if (reset === true || Z2.k === 1) { Z2.k = 1; Z2.left = (well.clientWidth - view.width * Z2.base) / 2; Z2.top = (well.clientHeight - view.height * Z2.base) / 2; }
  applyZoom();
}
function applyZoom() {
  const s = Z2.base * Z2.k, W = view.width * s, H = view.height * s, cw = well.clientWidth, ch = well.clientHeight;
  // keep at least a third of the map on screen
  Z2.left = Math.min(cw - Math.min(W, cw) / 3, Math.max(Z2.left, Math.min(W, cw) / 3 - W));
  Z2.top = Math.min(ch - Math.min(H, ch) / 3, Math.max(Z2.top, Math.min(H, ch) / 3 - H));
  view.style.width = W + 'px'; view.style.height = H + 'px';
  view.style.left = Z2.left + 'px'; view.style.top = Z2.top + 'px';
  view.classList.toggle('pix', mode === 'sim' || s > 2.5);
  if (typeof placeLabels === 'function') placeLabels();
}
function zoomAt(clientX, clientY, f) {
  const r = well.getBoundingClientRect(), px = clientX - r.left, py = clientY - r.top;
  const k2 = Math.min(60, Math.max(1, Z2.k * f)); f = k2 / Z2.k; Z2.k = k2;
  Z2.left = px - (px - Z2.left) * f; Z2.top = py - (py - Z2.top) * f;
  applyZoom();
}
view.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
view.addEventListener('contextmenu', e => e.preventDefault());
// pan and pinch: right or middle drag, shift-drag, two fingers, or the Look tool
const P2 = new Map(); let pan2 = null;
function pan2Down(e) {
  P2.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (P2.size >= 2) {
    const [a, b] = [...P2.values()];
    pan2 = { pinch: true, d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    if (typeof cancelTool === 'function') cancelTool(); drag = null; return true;
  }
  const look = mode === 'sim' && typeof tool === 'function' && tool() === 'look';
  if (e.button === 1 || e.button === 2 || e.shiftKey || look) { pan2 = { x: e.clientX, y: e.clientY }; view.setPointerCapture(e.pointerId); return true; }
  return false;
}
function pan2Move(e) {
  const p = P2.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; }
  if (!pan2) return false;
  if (pan2.pinch) {
    if (P2.size < 2) return true;
    const [a, b] = [...P2.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    Z2.left += mx - pan2.mx; Z2.top += my - pan2.my;
    zoomAt(mx, my, d / Math.max(pan2.d, 1));
    pan2.d = d; pan2.mx = mx; pan2.my = my; return true;
  }
  Z2.left += e.clientX - pan2.x; Z2.top += e.clientY - pan2.y; pan2.x = e.clientX; pan2.y = e.clientY;
  if (Z2.k === 1) Z2.k = 1.0001; // stop a resize from snapping it back to centre
  applyZoom(); return true;
}
function pan2Up(e) { P2.delete(e.pointerId); if (!pan2) return false; if (!P2.size) pan2 = null; return true; }

new ResizeObserver(() => fitCanvas()).observe(well);
window.addEventListener('resize', () => fitCanvas());

function canvasCell(e) {
  const r = view.getBoundingClientRect();
  return [Math.floor((e.clientX - r.left) / r.width * view.width), Math.floor((e.clientY - r.top) / r.height * view.height)];
}

function showPanels(names) {
  for (const id of ['p-select', 'p-sim', 'p-tools', 'p-env', 'p-balance', 'p-ponds', 'p-save']) $('#' + id).hidden = !names.includes(id);
}

/* ---------- selection ---------- */
function enterSelect() {
  mode = 'select';
  if (typeof setView === 'function') setView('2d');
  $('#viewbar').hidden = false; $('#viewbar').classList.add('selectmode'); $('#labels').innerHTML = '';
  view.hidden = false; $('#empty').hidden = true;
  view.width = ov.w; view.height = ov.h;
  $('#backOv').hidden = !(dem && dem.parent);
  fitCanvas(true); showPanels(['p-select', 'p-save']); if (typeof refreshScenarios === 'function') refreshScenarios();
  updateSelection(); drawOverview();
}

function drawOverview() {
  // the preview can change size (it's drawn larger once a map arrives), so match the canvas before drawing
  if (view.width !== ov.w || view.height !== ov.h) {
    const sx = ov.w / view.width;
    view.width = ov.w; view.height = ov.h;
    if (Z2.k !== 1) { Z2.base /= sx; }   // keep the same zoom and position on screen
    fitCanvas();
  }
  ctx.putImageData(ov.img, 0, 0);
  if (!sel) return;
  const f = ov.f, x = sel.x0 / f, y = sel.y0 / f, w = (sel.x1 - sel.x0) / f, h = (sel.y1 - sel.y0) / f;
  ctx.fillStyle = 'rgba(20,26,25,0.45)';
  ctx.fillRect(0, 0, ov.w, y); ctx.fillRect(0, y + h, ov.w, ov.h - y - h);
  ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, ov.w - x - w, h);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--earth').trim() || '#7A5230';
  ctx.lineWidth = Math.max(1.5, ov.w / 400);
  ctx.strokeRect(x, y, w, h);
}

function kOptions() {
  const W = sel.x1 - sel.x0, H = sel.y1 - sel.y0, out = [];
  for (const k of [1, 2, 3, 4, 5, 8, 10, 15, 20, 25, 40, 50]) {
    const w = Math.floor(W / k), h = Math.floor(H / k);
    if (w >= 20 && h >= 20) out.push({ k, w, h });
  }
  return out;
}

// on an Environment Agency overview the preview is coarse, but the box is downloaded at 1 m (2 m for big boxes),
// so the choices are real metre sizes for the simulation, not multiples of the preview's cells
function remoteOptions() {
  const Wm = (sel.x1 - sel.x0) * dem.cell, Hm = (sel.y1 - sel.y0) * dem.cell, base = Wm * Hm > 4e6 ? 2 : 1, out = [];
  for (const m of [1, 2, 3, 4, 5, 8, 10, 15, 20, 25]) {
    if (m < base) continue;
    const w = Math.floor(Wm / m), h = Math.floor(Hm / m);
    if (w >= 20 && h >= 20) out.push({ k: m, w, h, base });
  }
  return out;
}
function updateSelection() {
  const W = sel.x1 - sel.x0, H = sel.y1 - sel.y0;
  $('#selinfo').textContent = `${Math.round(W * dem.cell).toLocaleString()} × ${Math.round(H * dem.cell).toLocaleString()} m`;
  if (dem.remote) {
    const opts = remoteOptions(), s = $('#cellsize'); s.innerHTML = '';
    const auto = opts.find(o => o.w * o.h <= MAX_AUTO_CELLS) || opts[opts.length - 1];
    for (const o of opts) { const el = document.createElement('option'); el.value = o.k; el.textContent = `${o.k} m (${o.w} × ${o.h} cells)`; if (o === auto) el.selected = true; s.appendChild(el); }
    const tooBig = Math.max(W, H) * dem.cell > 4000;
    $('#go').disabled = !opts.length || tooBig;
    $('#cellnote').textContent = tooBig ? 'Pick a box up to 4 km across for a full-detail download.'
      : opts.length ? `Downloads this box at ${opts[0].base} m lidar, then simulates at the size you pick.` : 'Area too small. Drag a bigger box.';
    return;
  }
  const opts = kOptions(), s = $('#cellsize');
  s.innerHTML = '';
  let auto = opts.find(o => o.w * o.h <= MAX_AUTO_CELLS) || opts[opts.length - 1];
  for (const o of opts) {
    const el = document.createElement('option');
    el.value = o.k; el.textContent = `${+(o.k * dem.cell).toFixed(2)} m (${o.w} × ${o.h} cells)`;
    if (o === auto) el.selected = true;
    s.appendChild(el);
  }
  $('#go').disabled = !opts.length;
  updateCellNote();
}
function updateCellNote() {
  if (dem && dem.remote) return;   // the overview's note is written by updateSelection and doesn't change with the choice
  const o = kOptions().find(o => o.k == $('#cellsize').value);
  const n = $('#cellnote');
  if (!o) { n.textContent = 'Area too small. Drag a bigger box.'; return; }
  const cells = o.w * o.h;
  const slowAt = MAX_AUTO_CELLS > 160000 ? 1500000 : 250000;
  n.textContent = cells > slowAt ? `${cells.toLocaleString()} cells. This will run slowly; a coarser cell size is kinder.`
    : o.k === 1 ? 'Full lidar resolution.' : `Each cell averages ${o.k} × ${o.k} lidar cells.`;
}
$('#cellsize').addEventListener('change', updateCellNote);

let drag = null;
view.addEventListener('pointerdown', e => {
  if (pan2Down(e)) return;
  if (mode === 'select') {
    view.setPointerCapture(e.pointerId);
    const [cx, cy] = canvasCell(e); drag = [cx, cy];
  } else if (mode === 'sim') { view.setPointerCapture(e.pointerId); toolDown(canvasCell(e)); }
});
view.addEventListener('pointermove', e => {
  if (pan2Move(e)) return;
  const [cx, cy] = canvasCell(e);
  if (mode === 'select') {
    probeOverview(cx, cy);
    if (!drag) return;
    const f = ov.f;
    const x0 = Math.floor(Math.max(0, Math.min(drag[0], cx)) * f), x1 = Math.ceil(Math.min(ov.w, Math.max(drag[0], cx) + 1) * f);
    const y0 = Math.floor(Math.max(0, Math.min(drag[1], cy)) * f), y1 = Math.ceil(Math.min(ov.h, Math.max(drag[1], cy) + 1) * f);
    sel = { x0, y0, x1: Math.min(dem.w, x1), y1: Math.min(dem.h, y1) };
    drawOverview();
  } else if (mode === 'sim') { probeSim(cx, cy); toolMove([cx, cy]); }
});
view.addEventListener('pointerup', e => {
  if (pan2Up(e)) return;
  if (mode === 'sim') { toolUp(canvasCell(e)); return; }
  if (mode === 'select' && drag) {
    drag = null;
    if (!kOptions().length) sel = { x0: 0, y0: 0, x1: dem.w, y1: dem.h };
    updateSelection(); drawOverview();
  }
});
view.addEventListener('pointerleave', () => { probe.textContent = ''; });
view.addEventListener('pointercancel', e => { P2.delete(e.pointerId); pan2 = null; });

function en(x, y) { // dem cell -> easting/northing (cell centre)
  return [dem.ox + (x + 0.5) * dem.cell, dem.oy - (y + 0.5) * dem.cell];
}
function probeOverview(cx, cy) {
  const x = Math.min(dem.w - 1, Math.floor(cx * ov.f)), y = Math.min(dem.h - 1, Math.floor(cy * ov.f));
  if (cx < 0 || cy < 0 || cx >= ov.w || cy >= ov.h) return;
  const v = dem.z[y * dem.w + x], [E, N] = en(x, y);
  probe.textContent = `E ${Math.round(E)}   N ${Math.round(N)}   ground ${v === v ? v.toFixed(2) + ' m' : 'no data'}`;
}

