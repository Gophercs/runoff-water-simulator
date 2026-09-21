/* scenarios are available from the start, so a saved setup can be reopened without picking terrain first */
$('#p-save').hidden = false;

/* ---------- foldable panels ---------- */
for (const id of ['p-load', 'p-sim', 'p-tools', 'p-env']) {
  const sec = $('#' + id), h2 = sec.querySelector('h2');
  h2.classList.add('foldable'); h2.tabIndex = 0; h2.setAttribute('role', 'button'); h2.setAttribute('aria-expanded', 'true');
  h2.insertAdjacentHTML('beforeend', '<span class="caret" aria-hidden="true">▾</span>');
  const toggle = () => { const folded = sec.classList.toggle('fold'); h2.setAttribute('aria-expanded', String(!folded)); fitCanvas(); };
  h2.addEventListener('click', toggle);
  h2.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
}

// fold a panel; the slide is used once, when a place is picked, as a gentle hint that panels fold
function foldPanel(sec, animate) {
  return new Promise(done => foldPanelNow(sec, animate, done));
}
function foldPanelNow(sec, animate, done) {
  if (sec.classList.contains('fold')) return done();
  const h2 = sec.querySelector('h2'), caret = h2.querySelector('.caret');
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!animate || still || !sec.animate) { h2.click(); return done(); }
  const from = sec.offsetHeight;
  sec.classList.add('fold'); const to = sec.offsetHeight; sec.classList.remove('fold');
  sec.style.overflow = 'hidden';
  const opts = { duration: 1500, easing: 'cubic-bezier(.45,0,.2,1)' };
  const a = sec.animate([{ height: from + 'px' }, { height: to + 'px' }], opts);
  if (caret) caret.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-90deg)' }], opts);
  a.onfinish = () => { sec.style.overflow = ''; h2.click(); done(); };
}

/* attribution shown on the map whenever that data is on screen */
function updateAttrib() {
  const el = $('#attrib'); if (!el) return;
  const lines = [];
  const d = dem, eaOn = d && (d.remote || d.ea || d.parent);
  const osOn = (+$('#mapMix').value || 0) > 0 && ((mode === 'select' && d && d.mapCv) || (mode === 'sim' && region && region.mapPix));
  if (eaOn) lines.push('Lidar © Environment Agency, OGL');
  if (osOn) lines.push('Contains OS data © Crown copyright and database rights ' + new Date().getFullYear());
  el.textContent = lines.join(' · '); el.hidden = !lines.length;
}
setInterval(updateAttrib, 700);

// show a button is working: disabled, with animated dots, until the job's done (label null restores it)
function busyBtn(btn, label) {
  if (!btn) return;
  if (label) { if (!btn.dataset.label) btn.dataset.label = btn.textContent; btn.disabled = true; btn.classList.add('busy'); btn.textContent = label; }
  else { if (btn.dataset.label) btn.textContent = btn.dataset.label; delete btn.dataset.label; btn.disabled = false; btn.classList.remove('busy'); }
}

/* ---------- logo ---------- */
['#logoHead', '#logoFs'].forEach(s => makeLogo($(s)));

/* ---------- engines ---------- */
// three engines, same physics: one core (reference, exact), all cores (identical results), graphics card (32-bit)
const engines = { gpu: null, pool: null };
let pendingEdits = [], enginesReady = false, userPickedEngine = false, benchBusy = false, benchFor = null;
const busyOn = () => [engines.gpu, engines.pool].some(e => e && e.busy && e.grid && e.grid.S === S);
function mutate(fn) { if (busyOn()) pendingEdits.push(fn); else { fn(); if (S) S.dirty = true; } }
function flushEdits() { const q = pendingEdits; pendingEdits = []; for (const fn of q) { fn(); if (S) S.dirty = true; } }
function activeEng() {
  const v = $('#engine').value, e = v === 'gpu' ? engines.gpu : v === 'pool' ? engines.pool : null;
  return e && !e.lost && (!e.fits || e.fits(S)) ? e : null;
}
function engineNote(msg) { $('#engineNote').textContent = msg; }
const ENGINE_NAME = { gpu: 'graphics card', pool: 'all cores', cpu: 'one core' };
(async () => {
  const [g, p] = await Promise.all([
    (async () => { try { return typeof createGPUEngine === 'function' ? await createGPUEngine() : null; } catch (e) { return null; } })(),
    (async () => { try { return typeof createPoolEngine === 'function' ? await createPoolEngine() : null; } catch (e) { return null; } })()
  ]);
  engines.gpu = g; engines.pool = p;
  const sel = $('#engine');
  sel.querySelector('option[value=gpu]').disabled = !g;
  sel.querySelector('option[value=pool]').disabled = !p;
  if (p) sel.querySelector('option[value=pool]').textContent = `Processor, all cores (${p.threads} threads)`;
  sel.value = p ? 'pool' : g ? 'gpu' : 'cpu';
  if (g || p) MAX_AUTO_CELLS = 600000;
  enginesReady = true;
  const missing = [!g && 'WebGPU', !p && 'worker threads'].filter(Boolean);
  engineNote(missing.length ? `This browser doesn’t offer ${missing.join(' or ')} here.` : 'Ready.');
  if (mode === 'select') updateSelection();
  if (mode === 'sim') benchEngines();
})();
$('#engine').addEventListener('change', () => {
  userPickedEngine = true; if (S) S.dirty = true;
  const v = $('#engine').value;
  engineNote(v === 'cpu' ? 'One core: the reference engine, exact to the last digit.' :
    v === 'pool' ? 'All cores: identical results to one core, split across threads.' : 'Graphics card: 32-bit arithmetic, so the water balance shows a tiny rounding error.');
});

// time each engine on this area and pick the fastest, unless the user has chosen
async function benchEngines() {
  if (!enginesReady || !S || benchBusy || benchFor === region) return;
  benchBusy = true; benchFor = region;
  const Sx = S, res = {};
  const mk = () => {
    const C = createSim(Float64Array.from(region.z), region.w, region.h, region.dx, Uint8Array.from(Sx.sink));
    for (let i = 0; i < C.d.length; i++) if (!C.sink[i]) C.d[i] = 0.05;
    C.n2.set(Sx.n2); C.Ks.set(Sx.Ks); C.P.set(Sx.P); C.rain = 1e-5; return C;
  };
  engineNote('Timing the engines on this area…');
  await new Promise(r => setTimeout(r, 50));
  { const C = mk(); step(C); const t0 = performance.now(); let k = 0;
    while (k < 3 || performance.now() - t0 < 200) { step(C); k++; } res.cpu = (performance.now() - t0) / k; }
  for (const name of ['pool', 'gpu']) {
    const e = engines[name]; if (!e || e.lost || (e.fits && !e.fits(Sx))) continue;
    while (e.busy) await new Promise(r => setTimeout(r, 20));
    e.busy = true;
    try {
      const C = mk(); await e.run(C, 4);
      const n = Math.max(8, Math.min(1000, Math.round(300 / Math.max(e.lastMsPerStep, 0.01))));
      const t0 = performance.now(); await e.run(C, n); res[name] = (performance.now() - t0) / n;
    } catch (err) { } finally { e.busy = false; }
  }
  benchBusy = false;
  if (Sx !== S) return;
  const order = Object.entries(res).sort((a, b) => a[1] - b[1]);
  const best = order[0][0], sps = ms => Math.round(1000 / ms).toLocaleString();
  if (!userPickedEngine) $('#engine').value = best;
  if (S) S.dirty = true;
  engineNote(`Timed on this area: ${order.map(([k, v]) => `${ENGINE_NAME[k]} ${sps(v)} steps/s`).join(', ')}. ` +
    (userPickedEngine ? `You chose ${ENGINE_NAME[$('#engine').value]}.` : `Using ${ENGINE_NAME[best]}.`));
}

/* ---------- region + sim ---------- */
function buildRegion(k) {
  const { x0, y0, x1, y1 } = sel;
  const w = Math.floor((x1 - x0) / k), h = Math.floor((y1 - y0) / k);
  const z = new Float64Array(w * h), nodata = new Uint8Array(w * h);
  let zmin = Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    for (let b = 0; b < k; b++) { const row = (y0 + y * k + b) * dem.w + x0 + x * k;
      for (let a = 0; a < k; a++) { const v = dem.z[row + a]; if (v === v) { sum += v; n++; } } }
    const i = y * w + x;
    if (n) { z[i] = sum / n; if (z[i] < zmin) zmin = z[i]; } else { z[i] = NaN; nodata[i] = 1; }
  }
  for (let i = 0; i < w * h; i++) if (nodata[i]) z[i] = zmin - 0.5;
  region = { w, h, k, dx: dem.cell * k, x0, y0, z, z0: Float64Array.from(z), nodata, zmin, img: new ImageData(w, h), base: null,
    ops: [], zone: new Uint16Array(w * h), zones: [], soilOps: [] };
  reshade();
}
function reshade() {
  const { w, h, z, nodata } = region;
  const sz = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) sz[i] = nodata[i] ? NaN : z[i];
  shade(sz, w, h, region.dx, region.img.data, region.mapPix);
  if ($('#contours').checked) {
    const px = region.img.data, ci = +$('#cint').value, L = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) L[i] = Math.floor(z[i] / ci);
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (nodata[i] || (L[i] === L[i + 1] && L[i] === L[i + w])) continue;
      const major = Math.floor(Math.max(z[i], z[i + 1], z[i + w]) / (ci * 5)) !== Math.floor(Math.min(z[i], z[i + 1], z[i + w]) / (ci * 5));
      const k = major ? 0.45 : 0.68, j = i * 4;
      px[j] *= k; px[j + 1] *= k; px[j + 2] *= k;
    }
  }
  if (shadingMode() === 'soil' && S) {
    const px = region.img.data, cache = new Map();
    for (let i = 0; i < w * h; i++) {
      if (nodata[i]) continue;
      const mm = S.Ks[i] * 3.6e6; let c = cache.get(mm); if (!c) { c = rateColour(mm); cache.set(mm, c); }
      const j = i * 4; px[j] = px[j] * 0.45 + c[0] * 0.55; px[j + 1] = px[j + 1] * 0.45 + c[1] * 0.55; px[j + 2] = px[j + 2] * 0.45 + c[2] * 0.55;
    }
  }
  region.base = Uint8ClampedArray.from(region.img.data);
}
function niceIntervals() {
  const vals = []; for (let i = 0; i < region.z.length; i += 7) if (!region.nodata[i]) vals.push(region.z[i]);
  vals.sort((a, b) => a - b);
  const relief = (vals[Math.floor(vals.length * 0.98)] - vals[Math.floor(vals.length * 0.02)]) || 1;
  const opts = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20], sel = $('#cint'); sel.innerHTML = '';
  let best = opts[0]; for (const o of opts) if (relief / o >= 12) best = o;
  for (const o of opts) { const el = document.createElement('option'); el.value = o; el.textContent = o + ' m'; if (o === best) el.selected = true; sel.appendChild(el); }
}
function contoursChanged() {
  if (!region) return;
  reshade();
  if (scene3) { const u = scene3.cUni; u.cOn.value = $('#contours').checked ? 1 : 0; u.cInt.value = +$('#cint').value; }
}
$('#contours').addEventListener('change', contoursChanged);
$('#cint').addEventListener('change', contoursChanged);

function applySinks() { mutate(applySinksNow); }
function applySinksNow() {
  const { w, h } = region, sink = S.sink;
  sink.set(region.nodata);
  if ($('#edges').value === 'drain') {
    for (let x = 0; x < w; x++) { sink[x] = 1; sink[(h - 1) * w + x] = 1; }
    for (let y = 0; y < h; y++) { sink[y * w] = 1; sink[y * w + w - 1] = 1; }
  }
  let dr = 0; for (let i = 0; i < w * h; i++) if (sink[i] && S.d[i] > 0) { dr += S.d[i]; S.d[i] = 0; }
  S.vol.drained += dr * region.dx * region.dx;
}

// Rawls, Brakensiek & Miller (1983): saturated conductivity (mm/hr), wetting-front suction (cm), effective porosity
const SOILS = {
  sand: ['Sand', 117.8, 4.95, 0.417], lsand: ['Loamy sand', 29.9, 6.13, 0.401], sloam: ['Sandy loam', 10.9, 11.01, 0.412],
  loam: ['Loam', 3.4, 8.89, 0.434], siloam: ['Silt loam', 6.5, 16.68, 0.486], scloam: ['Sandy clay loam', 1.5, 21.85, 0.330],
  cloam: ['Clay loam', 1.0, 20.88, 0.309], sicloam: ['Silty clay loam', 1.0, 27.30, 0.432], sclay: ['Sandy clay', 0.6, 23.90, 0.321],
  siclay: ['Silty clay', 0.5, 29.22, 0.423], clay: ['Clay', 0.3, 31.63, 0.385]
};
// land cover: Manning's n, and a rough multiplier on the soil's conductivity
const COVER = {
  urban: ['tarmac and roofs', 0.015, 0], bare: ['crusted bare soil', 0.025, 0.5], arable: ['arable crops', 0.05, 0.8],
  grazed: ['grazed pasture', 0.035, 0.4], grass: ['ungrazed grass', 0.05, 1], rough: ['rough grassland', 0.08, 1.5], wood: ['woodland', 0.12, 3]
};
function soilParams(soil, cover, se) {
  const cov = COVER[cover] || COVER.grass, n2 = cov[1] * cov[1];
  if (soil === 'none' || cov[2] === 0) return { n2, Ks: 0, P: 0, ksMm: 0, f5: 0, label: soil === 'none' ? 'Sealed' : `Sealed (${cov[0]})` };
  if (soil === 'custom') { const f = (+$('#infil').value || 0) * cov[2]; return { n2, Ks: f / 3.6e6, P: 0, ksMm: f, f5: f, label: `Custom rate under ${cov[0]}` }; }
  const [name, ks, psi, por] = SOILS[soil], K = ks * cov[2], P = psi / 100 * por * (1 - se);
  return { n2, Ks: K / 3.6e6, P, ksMm: K, f5: K * (1 + P / 0.005), label: `${name} under ${cov[0]}` };
}
// fill the per-cell roughness and soil arrays from the base settings and any painted zones
function computeSoil() {
  if (!S || !region) return;
  const se = +$('#wet').value, base = soilParams($('#soil').value, $('#cover').value, se);
  const on = $('#zonesOn').checked, zp = new Map(region.zones.map(z => [z.id, soilParams(z.soil, z.cover, se)]));
  const N = region.w * region.h; let sK = 0, sF = 0, n = 0;
  for (let i = 0; i < N; i++) {
    const p = on && region.zone[i] ? (zp.get(region.zone[i]) || base) : base;
    S.n2[i] = p.n2; S.Ks[i] = p.Ks; S.P[i] = p.P;
    if (!region.nodata[i]) { sK += p.ksMm; sF += p.f5; n++; }
  }
  S.dirty = true;
  const soil = $('#soil').value;
  $('#infWrap').hidden = soil !== 'custom'; $('#wetWrap').hidden = soil === 'none' || soil === 'custom';
  if (soil === 'custom') $('#infOut').textContent = (+$('#infil').value) + ' mm/hr';
  const note = $('#soakNote'), fmt = v => v < 10 ? (+v.toFixed(v < 1 ? 2 : 1)).toString() : Math.round(v).toString();
  if (base.ksMm === 0) note.textContent = soil === 'none' ? 'Nothing soaks in: the worst case.' : 'Sealed surface: nothing soaks in.';
  else if (base.P === 0) note.textContent = `${base.label}: a steady ${fmt(base.ksMm)} mm/hr, no matter how wet the soil gets.`;
  else note.textContent = `${base.label}: around ${fmt(base.f5)} mm/hr after the first 5 mm, settling towards ${fmt(base.ksMm)} mm/hr as it wets up.`;
  $('#zoneNote').textContent = on && n ? `Averaged over the whole area: around ${fmt(sF / n)} mm/hr early on, settling towards ${fmt(sK / n)} mm/hr.` : '';
}
function readRain() {
  if (!S) return;
  const r = +$('#rain').value;
  if (r > 0 && !(S.rain > 0)) rainStart = S.t;
  $('#rainOut').textContent = r + ' mm/hr';
  S.rain = r / 1000 / 3600;
}
function readConditions() { readRain(); computeSoil(); }
$('#rain').addEventListener('input', readRain);
$('#infil').addEventListener('input', () => { computeSoil(); if (shadingMode() === 'soil') reshade(); renderZoneList(); });
['#soil', '#wet', '#cover'].forEach(s => $(s).addEventListener('change', () => { computeSoil(); if (shadingMode() === 'soil') { reshade(); if (scene3) updateTerrain3D(); } renderZoneList(); }));
$('#edges').addEventListener('change', () => { if (S) applySinks(); });

$('#backOv').addEventListener('click', () => {
  if (!dem || !dem.parent) return;
  dem = dem.parent; buildOverview();
  sel = { x0: 0, y0: 0, x1: dem.w, y1: dem.h };
  enterSelect(); setInfo(`Overview around ${dem.remote.place}. Drag a box, then press “Simulate this area”. ${EA.attrib}`);
});
$('#go').addEventListener('click', () => {
  if (dem && dem.remote) { eaLoadDetail(); return; }   // fetch the chosen box at full detail first
  buildRegion(+$('#cellsize').value);
  niceIntervals(); reshade();
  S = createSim(region.z, region.w, region.h, region.dx, new Uint8Array(region.w * region.h));
  region.peak = new Float32Array(region.w * region.h);
  ponds = []; $('#pondList').innerHTML = ''; $('#labels').innerHTML = '';
  applySinks(); readConditions();
  mode = 'sim'; running = false;
  view.width = region.w; view.height = region.h;
  $('#viewbar').hidden = false; $('#viewbar').classList.remove('selectmode');
  dispose3D();                         // rebuilt on demand for the new region
  fitCanvas(true);
  showPanels(['p-sim', 'p-tools', 'p-env', 'p-balance', 'p-ponds', 'p-save']);
  refreshScenarios();
  renderFeatureList(); renderZoneList();
  setRunLabel(); render2D(S.d); updateStats(true);
  loadMapFor(region, () => { reshade(); if (scene3) updateTerrain3D(); });
  for (const id of ['p-load', 'p-tools']) { const sec = $('#' + id); if (!sec.classList.contains('fold')) sec.querySelector('h2').click(); }
  if (viewMode === '3d') setView('3d');
  benchEngines();
});

function stopSim() { running = false; setRunLabel(); }
function setRunLabel() { $('#run').textContent = $('#fsRun').textContent = running ? 'Pause' : 'Run'; setLogo(running ? 'running' : dem ? 'calm' : 'idle'); }
$('#run').addEventListener('click', () => { running = !running; simTarget = S.t; rateMark = null; rateShown = ''; setRunLabel(); });
$('#back').addEventListener('click', () => {
  stopSim(); S = null;
  if (dem && dem.parent && dem.ea) {
    const p = dem.parent, b = dem.ea, cx = e => Math.round((e - p.ox) / p.cell), cy = n => Math.round((p.oy - n) / p.cell);
    dem = p; buildOverview();
    sel = { x0: Math.max(0, cx(b.e0)), y0: Math.max(0, cy(b.n1)), x1: Math.min(p.w, cx(b.e1)), y1: Math.min(p.h, cy(b.n0)) };
  }
  enterSelect();
});
$('#reset').addEventListener('click', () => { if (S) mutate(resetWater); });
function resetWater() {
  S.d.fill(0); S.qx.fill(0); S.qy.fill(0); S.qx0.fill(0); S.qy0.fill(0);
  S.t = 0; S.vol = { rain: 0, added: 0, source: 0, drained: 0, infil: 0 }; simTarget = 0;
  for (const c of S.culverts) c.Q = 0;
  region.peak.fill(0); S.F.fill(0); rainStart = 0; computePonds();
  updateStats(true);
}
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && mode === 'sim' && !/INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) {
    e.preventDefault(); $('#run').click();
  }
});

/* ---------- tools ---------- */
let pouring = false, lastPour = 0, lineStart = null, lineEnd = null, hoverCell = null, stroke = null;
function tool() { return document.querySelector('input[name=tool]:checked').value; }
const TOOL_OPTS = ['look', 'pour', 'source', 'culvert', 'barrier', 'ditch', 'swale', 'dig', 'paint'];
document.querySelectorAll('input[name=tool]').forEach(r => r.addEventListener('change', () => {
  for (const t of TOOL_OPTS) { const el = $('#opt-' + t); if (el) el.hidden = tool() !== t; }
  cancelTool();
}));
function cancelTool() { lineStart = lineEnd = null; pouring = false; if (stroke) strokeEnd(); markersDirty = true; }
const isLineTool = t => t === 'culvert' || t === 'barrier' || t === 'ditch' || t === 'swale';
const inGrid = c => c && c[0] >= 0 && c[1] >= 0 && c[0] < region.w && c[1] < region.h;

function toolDown(c) {
  if (!S || !inGrid(c)) return;
  const t = tool(), [cx, cy] = c, i = cy * region.w + cx;
  if (t === 'pour') { pouring = true; lastPour = 0; pourAt(cx, cy); }
  else if (t === 'dig' || t === 'paint') strokeStart(t, cx, cy);
  else if (t === 'source') {
    if (S.sink[i]) return;
    S.sources.push({ i, x: cx, y: cy, Q: Math.max(0, +$('#srcFlow').value || 0) / 1000, id: ++opSeq });
    markersDirty = true; renderFeatureList();
  } else if (isLineTool(t)) { lineStart = c; lineEnd = c; }
}
function toolMove(c) {
  if (!S || !inGrid(c)) return;
  hoverCell = c;
  if (pouring) pourAt(c[0], c[1]);
  if (stroke) strokeTo(c[0], c[1]);
  if (lineStart) { lineEnd = c; markersDirty = true; }
}
function toolUp(c) {
  if (pouring) { pouring = false; computePonds(); }
  if (stroke) { strokeEnd(); return; }
  if (!lineStart) return;
  if (inGrid(c)) lineEnd = c;
  const a = lineStart, b = lineEnd; lineStart = lineEnd = null; markersDirty = true;
  const t = tool();
  if (t === 'culvert') {
    const ia = a[1] * region.w + a[0], ib = b[1] * region.w + b[0];
    if (ia === ib) return;
    S.culverts.push({ a: ia, b: ib, ax: a[0], ay: a[1], bx: b[0], by: b[1], D: Math.max(0.05, +$('#culD').value || 0.6), Q: 0, id: ++opSeq });
    renderFeatureList();
  } else if (t === 'barrier') addOp({ type: 'barrier', a, b, mode: $('#barMode').value, H: Math.max(0.01, +$('#barH').value || 1), W: +$('#barW').value || region.dx });
  else if (t === 'ditch') addOp({ type: 'ditch', a, b, D: Math.max(0.01, +$('#ditD').value || 0.5) });
  else if (t === 'swale') addOp({ type: 'swale', a, b, L: +$('#swL').value || 50, D: Math.max(0.01, +$('#swD').value || 0.4), W: +$('#swW').value || region.dx, B: Math.max(0, +$('#swB').value || 0) });
}

/* ---------- earthworks: a recipe replayed onto the original ground ----------
   Each barrier, ditch, swale and pond is stored as its settings, not as edited cells. Changing or deleting
   any of them replays the whole list onto the untouched terrain, so later ones build on earlier ones. */
let opSeq = 0;
function addOp(op) {
  op.id = ++opSeq;
  const info = applyOp(op); if (info === null) return;
  op.info = info; region.ops.push(op); terrainChanged();
}
function rebuildTerrain() {
  region.z.set(region.z0);
  region.ops = region.ops.filter(op => (op.info = applyOp(op)) !== null);
  terrainChanged();
}
function applyOp(op) {
  if (op.type === 'barrier') return applyBarrier(op);
  if (op.type === 'ditch') return applyDitch(op);
  if (op.type === 'swale') return applySwale(op);
  if (op.type === 'dig') return applyDig(op);
  if (op.type === 'raw') { op.cells.forEach((i, k) => { region.z[i] = op.z[k]; }); return `${op.cells.length} cells changed`; }
  return null;
}
function applyBarrier(op) {
  const { w, h, z, nodata } = region, line = line4(op.a[0], op.a[1], op.b[0], op.b[1]);
  const level = op.mode === 'level', rad = Math.max(0, op.W / region.dx / 2 - 0.5), ri = Math.ceil(rad);
  let zlo = Infinity; for (const [x, y] of line) { const i = y * w + x; if (!nodata[i]) zlo = Math.min(zlo, z[i]); }
  if (zlo === Infinity) return null;
  const crest = zlo + op.H, seen = new Set(), ends = [z[op.a[1] * w + op.a[0]], z[op.b[1] * w + op.b[0]]];
  for (const [x, y] of line) for (let oy = -ri; oy <= ri; oy++) for (let ox = -ri; ox <= ri; ox++) {
    if (ox * ox + oy * oy > rad * rad + 0.3) continue;
    const xx = x + ox, yy = y + oy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const i = yy * w + xx; if (seen.has(i) || nodata[i]) continue;
    seen.add(i); z[i] = level ? Math.max(z[i], crest) : z[i] + op.H;
  }
  if (!level) return `${Math.round(line.length * region.dx)} m long, follows the ground`;
  let note = `crest ${crest.toFixed(2)} m, ${Math.round(line.length * region.dx)} m long`;
  const low = [['start', crest - ends[0]], ['end', crest - ends[1]]].filter(([, g]) => g > 0.01);
  if (low.length) note += `. The ground at its ${low.map(([n, g]) => `${n} is ${g.toFixed(2)} m`).join(' and ')} below the crest, so water can walk round`;
  return note;
}
function applyDitch(op) {
  const { w, z, nodata } = region, seen = new Set();
  const line = line4(op.a[0], op.a[1], op.b[0], op.b[1]);
  for (const [x, y] of line) { const i = y * w + x; if (seen.has(i) || nodata[i]) continue; seen.add(i); z[i] -= op.D; }
  return seen.size ? `${Math.round(line.length * region.dx)} m long` : null;
}
// Walk along the contour from a, heading roughly towards b, one cell at a time (edge-to-edge so the
// channel is watertight), always choosing the neighbour whose ground is closest to the start height.
function traceContour(a, b, lengthM) {
  const { w, h, z, nodata } = region;
  let hx = b[0] - a[0], hy = b[1] - a[1], hl = Math.hypot(hx, hy);
  if (hl < 1) return null;
  hx /= hl; hy /= hl;
  const z0 = z[a[1] * w + a[0]], maxLen = Math.max(1, (lengthM || 50) / region.dx);
  let x = a[0], y = a[1], len = 0, px = x, py = y;
  const path = [[x, y]], seen = new Set([y * w + x]);
  while (len < maxLen) {
    let best = null, bs = Infinity;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox, ny = y + oy;
      if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
      const k = ny * w + nx; if (seen.has(k) || nodata[k]) continue;
      const dot = ox * hx + oy * hy; if (dot < -0.3) continue;
      const sc = Math.abs(z[k] - z0) - 0.03 * dot;
      if (sc < bs) { bs = sc; best = [nx, ny, ox, oy]; }
    }
    if (!best) break;
    [x, y] = best; seen.add(y * w + x); path.push([x, y]);
    hx = 0.85 * hx + 0.15 * best[2]; hy = 0.85 * hy + 0.15 * best[3]; hl = Math.hypot(hx, hy); hx /= hl; hy /= hl;
    if (path.length % 2 === 0) { len += Math.hypot(x - px, y - py); px = x; py = y; }
  }
  return { path, z0 };
}
function applySwale(op) {
  const tr = traceContour(op.a, op.b, op.L); if (!tr || tr.path.length < 3) return null;
  const { w, h, z, nodata } = region, z0 = tr.z0, bottom = z0 - op.D, crest = z0 + op.B;
  const rad = Math.max(0, op.W / region.dx / 2 - 0.5), ri = Math.ceil(rad), ditch = new Set(), orig = new Map();
  for (const [x, y] of tr.path) for (let oy = -ri; oy <= ri; oy++) for (let ox = -ri; ox <= ri; ox++) {
    if (ox * ox + oy * oy > rad * rad + 0.3) continue;
    const xx = x + ox, yy = y + oy; if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
    const i = yy * w + xx; if (!nodata[i]) ditch.add(i);
  }
  let cap = 0;
  for (const i of ditch) { orig.set(i, z[i]); if (z[i] > bottom) z[i] = bottom; cap += Math.max(0, z0 - z[i]); }
  if (op.B > 0) for (const i of ditch) {
    const x = i % w, y = (i - x) / w;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const k = (y + oy) * w + x + ox;
      if (ditch.has(k) || nodata[k]) continue;
      const g = orig.has(k) ? orig.get(k) : z[k];
      if (g < z0) { if (!orig.has(k)) orig.set(k, z[k]); z[k] = Math.max(z[k], crest); }
    }
  }
  return `bottom ${bottom.toFixed(2)} m, about ${Math.round(tr.path.length * region.dx * 0.85)} m long, holds roughly ${Math.round(cap * region.dx * region.dx)} m³`;
}
function digBottom(op) {
  const [x, y] = op.path[0], i = y * region.w + x;
  return op.mode === 'level' ? op.val : region.z[i] - Math.max(0.01, op.val);
}
function digStamp(op, bottom, cx, cy, old) {
  const R = Math.max(0.5, op.R / region.dx), r = Math.ceil(R), { w, h, z, nodata } = region;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= w || y >= h || (x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
    const i = y * w + x; if (nodata[i] || z[i] <= bottom) continue;
    if (!old.has(i)) old.set(i, z[i]);
    z[i] = bottom;
  }
}
function digInfo(bottom, old) {
  if (!old.size) return null;
  let vol = 0; for (const [i, z0] of old) vol += z0 - region.z[i];
  const A = region.dx * region.dx;
  return `bottom ${bottom.toFixed(2)} m, ${Math.round(old.size * A).toLocaleString()} m², ${Math.round(vol * A).toLocaleString()} m³ dug out`;
}
function applyDig(op) {
  const bottom = digBottom(op), old = new Map();
  for (const [x, y] of op.path) digStamp(op, bottom, x, y, old);
  return digInfo(bottom, old);
}

/* ---------- brush strokes: pond digging and soil painting ---------- */
function strokeStart(kind, cx, cy) {
  if (region.nodata[cy * region.w + cx]) return;
  if (kind === 'dig') {
    const op = { type: 'dig', mode: $('#digMode').value, val: +$('#digVal').value || 1, R: +$('#digR').value || 4, path: [[cx, cy]] };
    stroke = { kind, op, bottom: digBottom(op), old: new Map(), last: [cx, cy], lastDraw: 0 };
    digStamp(op, stroke.bottom, cx, cy, stroke.old);
  } else {
    const zid = $('#zErase').checked ? 0 : zoneFor($('#zSoil').value, $('#zCover').value);
    const sop = { zid, R: +$('#zR').value || 10, path: [[cx, cy]] };
    stroke = { kind, sop, last: [cx, cy], lastDraw: 0 };
    zoneStamp(sop, cx, cy);
  }
  strokeRefresh(true);
}
function strokeTo(cx, cy) {
  const pts = line4(stroke.last[0], stroke.last[1], cx, cy).slice(1);
  for (const [x, y] of pts) {
    if (stroke.kind === 'dig') { stroke.op.path.push([x, y]); digStamp(stroke.op, stroke.bottom, x, y, stroke.old); }
    else { stroke.sop.path.push([x, y]); zoneStamp(stroke.sop, x, y); }
  }
  stroke.last = [cx, cy]; strokeRefresh(false);
}
function strokeRefresh(force) {
  const now = performance.now(); if (!force && now - stroke.lastDraw < 150) return; stroke.lastDraw = now;
  if (stroke.kind === 'dig') { if (S) S.dirty = true; reshade(); if (scene3) updateTerrain3D(); }
  else { computeSoil(); reshade(); if (scene3) updateTerrain3D(); }
}
function strokeEnd() {
  const st = stroke; stroke = null;
  if (st.kind === 'dig') {
    const info = digInfo(st.bottom, st.old); if (info === null) return;
    st.op.id = ++opSeq; st.op.info = info; region.ops.push(st.op); terrainChanged();
  } else {
    region.soilOps.push(st.sop); pruneZones(); soilChanged();
  }
}

/* ---------- soil zones ---------- */
function zoneFor(soil, cover) {
  let z = region.zones.find(q => q.soil === soil && q.cover === cover);
  if (!z) { z = { id: region.zones.reduce((m, q) => Math.max(m, q.id), 0) + 1, soil, cover }; region.zones.push(z); }
  return z.id;
}
function zoneStamp(sop, cx, cy) {
  const R = Math.max(0.5, sop.R / region.dx), r = Math.ceil(R), { w, h, nodata, zone } = region;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= w || y >= h || (x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
    const i = y * w + x; if (!nodata[i]) zone[i] = sop.zid;
  }
}
function rebuildZones() {
  region.zone.fill(0);
  for (const sop of region.soilOps) for (const [x, y] of sop.path) zoneStamp(sop, x, y);
}
function pruneZones() {
  // drop zones that no longer cover any cell (e.g. entirely painted over or rubbed out)
  const used = new Set(region.zone); region.zones = region.zones.filter(z => used.has(z.id));
  const keep = new Set(region.zones.map(z => z.id)); keep.add(0);
  region.soilOps = region.soilOps.filter(s => keep.has(s.zid));
}
function soilChanged() { computeSoil(); reshade(); if (scene3) updateTerrain3D(); renderZoneList(); }
$('#zonesOn').addEventListener('change', () => {
  const on = $('#zonesOn').checked;
  $('#zoneBox').hidden = !on; $('#tgSoil').hidden = !on;
  if (!on && tool() === 'paint') { document.querySelector('input[name=tool][value=look]').checked = true; document.querySelector('input[name=tool][value=look]').dispatchEvent(new Event('change')); }
  if (region) soilChanged();
});
$('#shading').addEventListener('change', () => {
  if (mode === 'select' && dem) { buildOverview(); drawOverview(); }
  if (region) { reshade(); if (scene3) updateTerrain3D(); }
});
function fillSoilSelects() {
  const ss = Object.entries(SOILS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('');
  $('#zSoil').innerHTML = '<option value="none">None (sealed)</option>' + ss; $('#zSoil').value = 'clay';
  $('#zCover').innerHTML = Object.entries(COVER).map(([k, v]) => `<option value="${k}">${v[0][0].toUpperCase() + v[0].slice(1)}</option>`).join(''); $('#zCover').value = 'wood';
}
fillSoilSelects();
// steady rate (mm/hr) to a colour: grey = nothing soaks in, purple slow, amber middling, teal fast
function rateColour(mmhr) {
  if (!(mmhr > 0)) return [128, 128, 128];
  let t = (Math.log10(mmhr) + 1) / 3; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const A = [118, 72, 160], B = [214, 164, 58], C = [34, 150, 140];
  const [p, q, f] = t < 0.5 ? [A, B, t * 2] : [B, C, t * 2 - 1];
  return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f];
}
function renderZoneList() {
  const box = $('#zoneList'); if (!region) return;
  const A = region.dx * region.dx, counts = new Map();
  for (let i = 0; i < region.zone.length; i++) if (!region.nodata[i]) counts.set(region.zone[i], (counts.get(region.zone[i]) || 0) + 1);
  const fmtA = n => { const a = n * A; return a >= 10000 ? (a / 10000).toFixed(2) + ' ha' : Math.round(a).toLocaleString() + ' m²'; };
  const base = soilParams($('#soil').value, $('#cover').value, +$('#wet').value);
  const row = (sw, name, info, del) => `<div class="feat"><span class="ft"><span class="sw" style="background:rgb(${sw.map(Math.round).join(',')})"></span>${name}</span><span></span><span></span>${del || '<span></span>'}<span class="fi">${info}</span></div>`;
  let html = row(rateColour(base.ksMm), 'Everywhere else', `${base.label}, ${fmtA(counts.get(0) || 0)}, steady ${+base.ksMm.toFixed(2)} mm/hr`);
  for (const z of region.zones) {
    const p = soilParams(z.soil, z.cover, +$('#wet').value);
    html += row(rateColour(p.ksMm), p.label, `${fmtA(counts.get(z.id) || 0)}, steady ${+p.ksMm.toFixed(2)} mm/hr`, `<button data-zone="${z.id}" aria-label="Delete this zone">Delete</button>`);
  }
  if (!region.zones.length) html += '<div class="empty">No zones yet. Pick “Paint a soil zone” in Tools.</div>';
  box.innerHTML = html;
  box.querySelectorAll('button[data-zone]').forEach(b => b.onclick = () => {
    const id = +b.dataset.zone;
    region.soilOps = region.soilOps.filter(s => s.zid !== id); region.zones = region.zones.filter(z => z.id !== id);
    rebuildZones(); soilChanged();
  });
}

/* ---------- things on the map: list with delete and a main setting ---------- */
const OP_LABEL = { barrier: 'Barrier', ditch: 'Ditch', swale: 'Swale', dig: 'Pond', raw: 'Earthwork' };
function renderFeatureList() {
  if (!S) return;
  const rows = [];
  S.sources.forEach(s => rows.push({ kind: 'spring', ref: s, name: 'Spring', val: +(s.Q * 1000).toFixed(1), unit: 'L/s', step: 10 }));
  S.culverts.forEach(c => rows.push({ kind: 'culvert', ref: c, name: 'Culvert', val: c.D, unit: 'm pipe', step: 0.1, info: `carrying ${Math.round(Math.abs(c.Q) * 1000)} L/s` }));
  region.ops.forEach(op => {
    const r = { kind: 'op', ref: op, name: OP_LABEL[op.type] || 'Earthwork', info: op.info };
    if (op.type === 'barrier') Object.assign(r, { val: op.H, unit: op.mode === 'level' ? 'm crest' : 'm high', step: 0.1 });
    if (op.type === 'ditch') Object.assign(r, { val: op.D, unit: 'm deep', step: 0.1 });
    if (op.type === 'swale') Object.assign(r, { val: op.D, unit: 'm deep', step: 0.1 });
    if (op.type === 'dig') Object.assign(r, { val: op.val, unit: op.mode === 'level' ? 'm level' : 'm deep', step: op.mode === 'level' ? 0.1 : 0.1 });
    rows.push(r);
  });
  const box = $('#featList');
  if (!rows.length) { box.innerHTML = '<div class="empty">Nothing added yet.</div>'; $('#undo').disabled = true; return; }
  box.innerHTML = rows.map((r, k) => `<div class="feat" data-k="${k}"><span class="ft">${r.name}</span>` +
    (r.val !== undefined ? `<input type="number" step="${r.step}" min="0" value="${r.val}" aria-label="${r.name} ${r.unit}"><span class="unit">${r.unit}</span>` : '<span></span><span></span>') +
    `<button aria-label="Delete ${r.name}">Delete</button>` + (r.info ? `<span class="fi" data-info="${k}">${r.info}</span>` : '') + '</div>').join('');
  box.querySelectorAll('.feat').forEach(el => {
    const r = rows[+el.dataset.k], inp = el.querySelector('input');
    el.querySelector('button').onclick = () => {
      if (r.kind === 'spring') S.sources.splice(S.sources.indexOf(r.ref), 1);
      else if (r.kind === 'culvert') S.culverts.splice(S.culverts.indexOf(r.ref), 1);
      else { region.ops.splice(region.ops.indexOf(r.ref), 1); rebuildTerrain(); }
      markersDirty = true; renderFeatureList();
    };
    if (inp) inp.onchange = () => {
      const v = Math.max(0, +inp.value || 0);
      if (r.kind === 'spring') r.ref.Q = v / 1000;
      else if (r.kind === 'culvert') r.ref.D = Math.max(0.05, v);
      else {
        const op = r.ref;
        if (op.type === 'barrier') op.H = Math.max(0.01, v); else if (op.type === 'ditch' || op.type === 'swale') op.D = Math.max(0.01, v); else if (op.type === 'dig') op.val = v;
        rebuildTerrain();
      }
    };
  });
  $('#undo').disabled = !region.ops.length;
  featRows = rows;
}
let featRows = [];
function updateFeatureLive() {
  // refresh culvert flows without rebuilding the list (so an input being edited keeps focus)
  featRows.forEach((r, k) => { if (r.kind === 'culvert') { const el = document.querySelector(`[data-info="${k}"]`); if (el) el.textContent = `carrying ${Math.round(Math.abs(r.ref.Q) * 1000)} L/s`; } });
}
$('#undo').addEventListener('click', () => { if (region && region.ops.length) { region.ops.pop(); rebuildTerrain(); } });
function terrainChanged() {
  if (S) S.dirty = true;
  reshade(); computePonds();
  if (scene3) updateTerrain3D();
  renderFeatureList();
}

function pourAt(cx, cy) {
  const now = performance.now(); if (now - lastPour < 120) return; lastPour = now;
  mutate(() => pourNow(cx, cy));
}
function pourNow(cx, cy) {
  const D = Math.max(0, +$('#pourDepth').value || 0), R = Math.max(0.5, (+$('#pourRadius').value || 1) / region.dx);
  let n = 0; const r = Math.ceil(R);
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= region.w || y >= region.h) continue;
    if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
    const k = y * region.w + x; if (S.sink[k]) continue;
    S.d[k] += D; n++;
  }
  S.vol.added += D * n * region.dx * region.dx;
  updateStats(true);
}

// 4-connected line: every step moves in x or y, never both, so water can't slip through diagonal gaps
function line4(x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x1 > x0 ? 1 : -1, sy = y1 > y0 ? 1 : -1;
  const out = [[x0, y0]]; let x = x0, y = y0, ix = 0, iy = 0;
  for (let n = 0; n < dx + dy; n++) {
    if ((0.5 + ix) / dx < (0.5 + iy) / dy) { x += sx; ix++; } else { y += sy; iy++; }
    out.push([x, y]);
  }
  return out;
}
$('#digMode').addEventListener('change', () => {
  const lvl = $('#digMode').value === 'level';
  $('#digValLabel').firstChild.textContent = lvl ? 'Bottom level (m) ' : 'Depth (m) ';
  $('#digVal').value = lvl && hoverCell ? (region.z[hoverCell[1] * region.w + hoverCell[0]] - 1).toFixed(2) : 1;
});
$('#barMode').addEventListener('change', () => {
  $('#barHLabel').firstChild.textContent = $('#barMode').value === 'level' ? 'Crest above lowest point (m) ' : 'Height above ground (m) ';
});

function probeSim(cx, cy) {
  if (!inGrid([cx, cy])) return;
  const i = cy * region.w + cx, w = region.w;
  const dx0 = region.x0 + (cx + 0.5) * region.k - 0.5, dy0 = region.y0 + (cy + 0.5) * region.k - 0.5;
  const [E, N] = en(dx0, dy0);
  if (region.nodata[i]) { probe.textContent = `E ${Math.round(E)}   N ${Math.round(N)}   no data (treated as an outlet)`; return; }
  const d = S.d[i];
  let txt = `E ${Math.round(E)}   N ${Math.round(N)}   ground ${region.z[i].toFixed(2)} m   water `;
  txt += d < 0.001 ? 'none' : d < 0.1 ? (d * 1000).toFixed(0) + ' mm' : d.toFixed(2) + ' m';
  if (d > 0.005) {
    const qx = ((cx > 0 ? S.qx[i - 1] : 0) + (cx < w - 1 ? S.qx[i] : 0)) / 2;
    const qy = ((cy > 0 ? S.qy[i - w] : 0) + (cy < region.h - 1 ? S.qy[i] : 0)) / 2;
    txt += `   flowing ${(Math.hypot(qx, qy) / d).toFixed(2)} m/s`;
  }
  probe.textContent = txt;
}

/* ---------- 2D render ---------- */
const DMIN = 0.004, LG = Math.log(1 / DMIN);
function cssVar(n, fb) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb; }
function render2D(d) {
  const base = region.base, px = region.img.data, N = region.w * region.h;
  for (let i = 0; i < N; i++) {
    const j = i * 4, dd = d[i];
    if (dd > DMIN) {
      let t = Math.log(dd / DMIN) / LG; if (t > 1) t = 1;
      let f = (dd - DMIN) / (0.025 - DMIN); f = f > 1 ? 1 : f * f * (3 - 2 * f);
      const a = f * (0.25 + 0.7 * Math.sqrt(t)), b = 1 - a;
      px[j] = base[j] * b + (150 - 138 * t) * a;
      px[j + 1] = base[j + 1] * b + (205 - 150 * t) * a;
      px[j + 2] = base[j + 2] * b + (235 - 100 * t) * a;
    } else { px[j] = base[j]; px[j + 1] = base[j + 1]; px[j + 2] = base[j + 2]; }
  }
  ctx.putImageData(region.img, 0, 0);
  const r = Math.max(2.5, region.w / 110), earth = '#7A5230';
  ctx.lineWidth = Math.max(1, r / 2.5);
  for (const c of S.culverts) {
    ctx.strokeStyle = earth; ctx.setLineDash([r, r * 0.7]);
    ctx.beginPath(); ctx.moveTo(c.ax + 0.5, c.ay + 0.5); ctx.lineTo(c.bx + 0.5, c.by + 0.5); ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of [[c.ax, c.ay], [c.bx, c.by]]) { ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, r * 0.6, 0, 7); ctx.fillStyle = earth; ctx.fill(); }
  }
  for (const s of S.sources) {
    ctx.beginPath(); ctx.arc(s.x + 0.5, s.y + 0.5, r, 0, Math.PI * 2);
    ctx.fillStyle = '#F2F4EF'; ctx.fill(); ctx.strokeStyle = '#1B67A6'; ctx.stroke();
  }
  if (hoverCell && (tool() === 'dig' || tool() === 'paint')) {
    const R = Math.max(0.5, (+$(tool() === 'dig' ? '#digR' : '#zR').value || 4) / region.dx);
    ctx.strokeStyle = earth; ctx.lineWidth = Math.max(1, r / 3); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(hoverCell[0] + 0.5, hoverCell[1] + 0.5, R, 0, Math.PI * 2); ctx.stroke();
  }
  if (lineStart && lineEnd && tool() === 'swale') {
    const tr = traceContour(lineStart, lineEnd);
    if (tr) { ctx.strokeStyle = '#1B67A6'; ctx.lineWidth = Math.max(1, r / 2); ctx.beginPath();
      tr.path.forEach(([x, y], k) => k ? ctx.lineTo(x + 0.5, y + 0.5) : ctx.moveTo(x + 0.5, y + 0.5)); ctx.stroke(); }
  } else if (lineStart && lineEnd) {
    ctx.strokeStyle = tool() === 'ditch' ? '#1B67A6' : earth; ctx.setLineDash([r, r]);
    ctx.beginPath(); ctx.moveTo(lineStart[0] + 0.5, lineStart[1] + 0.5); ctx.lineTo(lineEnd[0] + 0.5, lineEnd[1] + 0.5); ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* ---------- 3D view ---------- */
let viewMode = '2d', scene3 = null, renderer3 = null, markersDirty = true;
function dispose3D() {
  const g = scene3; if (!g) return;
  g.tGeo.dispose(); g.wGeo.dispose(); g.wMat.dispose(); g.terrain.material.dispose();
  g.markers.children.forEach(c => { if (c.geometry !== g.mk.sGeo) c.geometry.dispose(); });
  g.mk.sGeo.dispose(); ['blue', 'brown', 'line', 'dash'].forEach(k => g.mk[k].dispose());
  scene3 = null;
}
function setView(v) {
  if (v === '3d' && !window.THREE) { $('#hint3d').hidden = false; $('#hint3d').textContent = 'The 3D library didn’t load. Check your connection and reload.'; return; }
  viewMode = v;
  $('#v2d').setAttribute('aria-pressed', v === '2d'); $('#v3d').setAttribute('aria-pressed', v === '3d');
  const three = v === '3d' && mode === 'sim';
  glCanvas.hidden = !three; view.hidden = three || mode === 'empty';
  $('#exagWrap').hidden = !three; $('#hint3d').hidden = !three;
  if (three) {
    if (!scene3) build3D();
    fitGL(); markersDirty = true;
  } else fitCanvas();
}
$('#v2d').addEventListener('click', () => setView('2d'));
$('#v3d').addEventListener('click', () => setView('3d'));
$('#exag').addEventListener('input', () => {
  $('#exagOut').textContent = $('#exag').value;
  if (scene3) { scene3.group.scale.z = +$('#exag').value; markersDirty = true; }
});

function tint(v, lo, span, pal) {
  let t = (v - lo) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const c = pal(t); return [c[0] / 255 * 1.05, c[1] / 255 * 1.05, c[2] / 255 * 1.05];
}

function build3D() {
  const T = THREE, { w, h, dx } = region, N = w * h;
  if (scene3) dispose3D();
  const renderer = renderer3 || (renderer3 = new T.WebGLRenderer({ canvas: glCanvas, antialias: true }));
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(40, 1.5, 1, 1e6);
  camera.up.set(0, 0, 1);
  const hemi = new T.HemisphereLight(0xf4f1e8, 0x55605a, 0.55); hemi.position.set(0, 0, 1); scene.add(hemi);
  const sun = new T.DirectionalLight(0xffffff, 0.75); sun.position.set(-1, 1, 1.2); scene.add(sun);

  const group = new T.Group(); group.scale.z = +$('#exag').value; scene.add(group);
  const index = new (N > 65535 ? Uint32Array : Uint16Array)((w - 1) * (h - 1) * 6);
  let k = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
    index[k++] = a; index[k++] = c; index[k++] = b; index[k++] = b; index[k++] = c; index[k++] = d;
  }
  const idx = new T.BufferAttribute(index, 1);
  const xy = new Float32Array(N * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; xy[i * 3] = (x - (w - 1) / 2) * dx; xy[i * 3 + 1] = ((h - 1) / 2 - y) * dx;
  }
  const tGeo = new T.BufferGeometry();
  tGeo.setAttribute('position', new T.BufferAttribute(Float32Array.from(xy), 3));
  tGeo.setAttribute('color', new T.BufferAttribute(new Float32Array(N * 3), 3));
  tGeo.setIndex(idx);
  const tMat = new T.MeshLambertMaterial({ vertexColors: true });
  const cUni = { cOn: { value: $('#contours').checked ? 1 : 0 }, cInt: { value: +$('#cint').value || 1 }, cRef: { value: region.zmin } };
  tMat.extensions = { derivatives: true };
  tMat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, cUni);
    sh.vertexShader = 'varying float vElev;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vElev = position.z;');
    sh.fragmentShader = 'uniform float cOn; uniform float cInt; uniform float cRef; varying float vElev;\n' +
      sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        if (cOn > 0.5) {
          float e = vElev + cRef, f = e / cInt, fw = fwidth(f);
          float d = min(fract(f), 1.0 - fract(f));
          float line = 1.0 - smoothstep(0.0, fw * 1.2, d);
          float f5 = e / (cInt * 5.0), fw5 = fwidth(f5), d5 = min(fract(f5), 1.0 - fract(f5));
          float major = 1.0 - smoothstep(0.0, fw5 * 1.6, d5);
          diffuseColor.rgb *= 1.0 - 0.35 * max(line, major * 1.5);
        }`);
  };
  const terrain = new T.Mesh(tGeo, tMat);
  group.add(terrain);

  const wGeo = new T.BufferGeometry();
  const wPos = new T.BufferAttribute(Float32Array.from(xy), 3); wPos.setUsage(T.DynamicDrawUsage);
  const wDep = new T.BufferAttribute(new Float32Array(N), 1); wDep.setUsage(T.DynamicDrawUsage);
  wGeo.setAttribute('position', wPos); wGeo.setAttribute('depth', wDep); wGeo.setIndex(idx);
  const wMat = new T.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    extensions: { derivatives: true },
    uniforms: { sun: { value: new T.Vector3(-1, 1, 1.2).normalize() } },
    vertexShader: `attribute float depth; varying float vD; varying vec3 vW;
      void main(){ vD = depth; vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: `uniform vec3 sun; varying float vD; varying vec3 vW;
      void main(){
        if (vD < ${DMIN.toFixed(4)}) discard;
        float t = clamp(log(vD / ${DMIN.toFixed(4)}) / ${LG.toFixed(4)}, 0.0, 1.0);
        vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
        if (n.z < 0.0) n = -n;
        if (n.z < 0.2) discard;
        vec3 col = mix(vec3(0.59,0.80,0.92), vec3(0.05,0.22,0.53), t);
        vec3 v = normalize(cameraPosition - vW);
        float spec = pow(max(dot(reflect(-sun, n), v), 0.0), 40.0) * 0.5;
        float dif = 0.65 + 0.35 * max(dot(n, sun), 0.0);
        float fade = smoothstep(${DMIN.toFixed(4)}, 0.025, vD);
        gl_FragColor = vec4(col * dif + spec * fade, fade * (0.3 + 0.6 * sqrt(t)));
      }`
  });
  const water = new T.Mesh(wGeo, wMat); water.renderOrder = 1; group.add(water);

  const markers = new T.Group(); scene.add(markers);
  const span = Math.max(w, h) * dx;
  const mr = Math.max(dx * 1.5, span / 160);
  const mk = { sGeo: new T.SphereGeometry(mr, 16, 12), blue: new T.MeshLambertMaterial({ color: 0x1b67a6 }),
    brown: new T.MeshLambertMaterial({ color: 0x7a5230 }), line: new T.LineBasicMaterial({ color: 0x7a5230 }),
    dash: new T.LineDashedMaterial({ color: 0x3b2410, dashSize: mr, gapSize: mr * 0.6 }), r: mr };
  scene3 = { renderer, scene, camera, group, terrain, tGeo, wGeo, wMat, wPos, wDep, markers, mk, span, lastMk: 0, cUni,
    zref: region.zmin, cam: { target: new T.Vector3(0, 0, 0), r: span * 1.1, theta: 0.35, phi: 0.95 } };
  updateTerrain3D();
  const bg = cssVar('--well', '#D3DBD0'); renderer.setClearColor(new T.Color(bg));
  updateCamera();
}

function updateTerrain3D() {
  const { w, h, z, nodata } = region, N = w * h, g = scene3;
  const pos = g.tGeo.attributes.position.array, col = g.tGeo.attributes.color.array, soilTint = shadingMode() === 'soil' && S, pal = paletteFn();
  const mix2 = (+$('#mapMix').value || 0) / 100, mp = mix2 && region.mapPix && region.mapPix.length === N * 4 ? region.mapPix : null;
  const vals = []; for (let i = 0; i < N; i += Math.max(1, N >> 14)) if (!nodata[i]) vals.push(z[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)] ?? 0, hi = vals[Math.floor(vals.length * 0.98)] ?? 1, span = Math.max(hi - lo, 0.01);
  for (let i = 0; i < N; i++) {
    pos[i * 3 + 2] = z[i] - g.zref;
    let c = nodata[i] ? [0.35, 0.39, 0.42] : tint(z[i], lo, span, pal);
    if (mp) { const q = 0.5 + 0.5 * mix2; c = [c[0] + (mp[i * 4] / 255 - c[0]) * mix2, c[1] + (mp[i * 4 + 1] / 255 - c[1]) * mix2, c[2] + (mp[i * 4 + 2] / 255 - c[2]) * mix2]; }
    if (soilTint && !nodata[i]) { const r = rateColour(S.Ks[i] * 3.6e6); c = [c[0] * 0.45 + r[0] / 255 * 0.55, c[1] * 0.45 + r[1] / 255 * 0.55, c[2] * 0.45 + r[2] / 255 * 0.55]; }
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  g.tGeo.attributes.position.needsUpdate = true; g.tGeo.attributes.color.needsUpdate = true;
  g.tGeo.computeVertexNormals(); g.tGeo.computeBoundingBox(); g.tGeo.computeBoundingSphere();
  g.cam.target.z = ((lo + hi) / 2 - g.zref) * g.group.scale.z;
  markersDirty = true;
}

function updateWater3D(d) {
  // Wet points carry their own surface. A dry point next to water, or a thin film sitting on ground that is
  // higher than a neighbouring pond's surface (the top of a bank or wall), instead borrows that neighbour's
  // surface with a negative depth. The shader then cuts the flat water plane exactly where it meets the
  // ground rather than stretching a sheet up the face.
  const g = scene3, p = g.wPos.array, dep = g.wDep.array, z = region.z, zr = g.zref, w = region.w, h = region.h;
  const FILM = 0.03;
  let sBest, dd, zi, dry;
  // take the LOWEST neighbouring surface clearly below this point: that can only over-clip slightly, never drape a sheet down a face
  const look = k => { const dk = d[k]; if (dk > DMIN) { const sk = z[k] + dk; if (sk < sBest && sk < zi - 0.05 && (dry || dk > FILM)) sBest = sk; } };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; dd = d[i]; zi = z[i];
    if (dd > FILM) { p[i * 3 + 2] = zi - zr + dd; dep[i] = dd; continue; }
    // a film much thinner than the local step in the ground can't be drawn as a sheet across that step
    let rel = 0;
    if (x > 0) rel = Math.max(rel, Math.abs(zi - z[i - 1])); if (x < w - 1) rel = Math.max(rel, Math.abs(zi - z[i + 1]));
    if (y > 0) rel = Math.max(rel, Math.abs(zi - z[i - w])); if (y < h - 1) rel = Math.max(rel, Math.abs(zi - z[i + w]));
    dry = dd <= DMIN || dd < 0.1 * rel;
    sBest = Infinity;
    if (x > 0) look(i - 1); if (x < w - 1) look(i + 1);
    if (y > 0) { look(i - w); if (x < w - 1) look(i - w + 1); }
    if (y < h - 1) { look(i + w); if (x > 0) look(i + w - 1); }
    if (sBest < Infinity) { p[i * 3 + 2] = sBest - zr; dep[i] = sBest - zi; }
    else { p[i * 3 + 2] = zi - zr + dd; dep[i] = dry ? -0.01 : dd; }
  }
  g.wPos.needsUpdate = true; g.wDep.needsUpdate = true;
}

function gridToWorld(x, y, lift) {
  const g = scene3, { w, h, dx } = region, i = y * w + x;
  return new THREE.Vector3((x - (w - 1) / 2) * dx, ((h - 1) / 2 - y) * dx, (region.z[i] - g.zref + S.d[i] + (lift || 0)) * g.group.scale.z);
}
function rebuildMarkers() {
  const T = THREE, g = scene3, m = g.markers, mk = g.mk;
  while (m.children.length) { const c = m.children.pop(); if (c.geometry !== mk.sGeo) c.geometry.dispose(); }
  for (const s of S.sources) { const b = new T.Mesh(mk.sGeo, mk.blue); b.position.copy(gridToWorld(s.x, s.y, 0)); m.add(b); }
  for (const c of S.culverts) {
    const A = gridToWorld(c.ax, c.ay, 0), B = gridToWorld(c.bx, c.by, 0);
    for (const P of [A, B]) { const b = new T.Mesh(mk.sGeo, mk.brown); b.position.copy(P); b.scale.setScalar(0.7); m.add(b); }
    m.add(new T.Line(new T.BufferGeometry().setFromPoints([A, B]), mk.line));
  }
  if (lineStart && lineEnd) {
    const tr = tool() === 'swale' ? traceContour(lineStart, lineEnd) : null;
    const L = tr ? tr.path : line4(lineStart[0], lineStart[1], lineEnd[0], lineEnd[1]), H = +$('#barH').value || 0;
    let pts;
    if (tr) pts = L.map(([x, y]) => { const v = gridToWorld(x, y, 0); v.z = (tr.z0 - g.zref + 0.1) * g.group.scale.z; return v; });
    else if (tool() === 'barrier' && $('#barMode').value === 'level') {
      let zlo = Infinity; for (const [x, y] of L) zlo = Math.min(zlo, region.z[y * region.w + x]);
      const crest = zlo + H;
      pts = L.map(([x, y]) => { const v = gridToWorld(x, y, 0); v.z = (Math.max(region.z[y * region.w + x], crest) - g.zref + 0.05) * g.group.scale.z; return v; });
    } else pts = L.map(([x, y]) => gridToWorld(x, y, tool() === 'barrier' ? H : 0.05));
    const l = new T.Line(new T.BufferGeometry().setFromPoints(pts), mk.dash); l.computeLineDistances(); m.add(l);
  }
  markersDirty = false; g.lastMk = performance.now();
}

function updateCamera() {
  const c = scene3.cam, cam = scene3.camera, sp = Math.sin(c.phi);
  cam.position.set(c.target.x + c.r * sp * Math.sin(c.theta), c.target.y - c.r * sp * Math.cos(c.theta), c.target.z + c.r * Math.cos(c.phi));
  cam.near = c.r / 500; cam.far = c.r * 20 + scene3.span * 4; cam.updateProjectionMatrix();
  cam.lookAt(c.target);
}
function fitGL() {
  if (!scene3) return;
  const W = well.clientWidth - 2, H = isFull() ? Math.round(wellMaxH()) : Math.round(Math.min(Math.max(320, W * 0.66), window.innerHeight * 0.78));
  if (Math.abs(well.clientHeight - H) > 1) well.style.height = H + 'px';
  scene3.renderer.setSize(W, H);
  scene3.camera.aspect = W / H; updateCamera();
}

// ray-march the heightfield to find which cell the pointer is over
const ray3 = window.THREE ? new THREE.Raycaster() : null;
function pick3D(e) {
  if (!scene3) return null;
  const rect = glCanvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray3.setFromCamera(ndc, scene3.camera);
  const { w, h, dx, z } = region, g = scene3, ex = g.group.scale.z;
  const box = g.tGeo.boundingBox.clone(); box.min.z *= ex; box.max.z *= ex; box.min.z -= 1; box.max.z += 1;
  const o = ray3.ray.origin, dir = ray3.ray.direction;
  const hit = new THREE.Vector3();
  const entry = box.containsPoint(o) ? o.clone() : ray3.ray.intersectBox(box, hit);
  if (!entry) return null;
  const surf = (px, py) => {
    const cx = Math.round(px / dx + (w - 1) / 2), cy = Math.round((h - 1) / 2 - py / dx);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
    return [(z[cy * w + cx] - g.zref) * ex, cx, cy];
  };
  const stepLen = dx * 0.5; let t = 0, prevT = 0;
  const maxT = g.span * 4;
  for (; t < maxT; t += stepLen) {
    const px = entry.x + dir.x * t, py = entry.y + dir.y * t, pz = entry.z + dir.z * t;
    const s = surf(px, py);
    if (s && pz <= s[0]) {
      let a = prevT, b = t;
      for (let k = 0; k < 10; k++) { const m = (a + b) / 2, sm = surf(entry.x + dir.x * m, entry.y + dir.y * m); if (sm && entry.z + dir.z * m <= sm[0]) b = m; else a = m; }
      const f = surf(entry.x + dir.x * b, entry.y + dir.y * b);
      return f ? [f[1], f[2]] : [s[1], s[2]];
    }
    if (pz < box.min.z) break;
    prevT = t;
  }
  return null;
}

// camera + tool gestures on the 3D canvas
const ptrs = new Map(); let gesture = null, pinch0 = null, lastProbe = 0;
glCanvas.addEventListener('contextmenu', e => e.preventDefault());
glCanvas.addEventListener('pointerdown', e => {
  glCanvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size >= 2) {
    pouring = false; lineStart = lineEnd = null; markersDirty = true;
    const [a, b] = [...ptrs.values()];
    gesture = 'pinch'; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    return;
  }
  if (e.button === 2 || e.shiftKey) gesture = 'pan';
  else if (tool() === 'look' || e.pointerType === 'mouse' && e.button === 1) gesture = 'orbit';
  else { gesture = 'tool'; toolDown(pick3D(e)); }
});
glCanvas.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId);
  if (!p) {
    const now = performance.now();
    if (now - lastProbe > 60) { lastProbe = now; const c = pick3D(e); if (c) probeSim(c[0], c[1]); }
    return;
  }
  const dxp = e.clientX - p.x, dyp = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  const c = scene3.cam;
  if (gesture === 'orbit') { c.theta -= dxp * 0.006; c.phi = Math.min(1.5, Math.max(0.05, c.phi - dyp * 0.006)); updateCamera(); }
  else if (gesture === 'pan') panBy(dxp, dyp);
  else if (gesture === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    c.r = Math.min(scene3.span * 6, Math.max(region.dx * 5, c.r * pinch0.d / Math.max(d, 1)));
    panBy(mx - pinch0.mx, my - pinch0.my);
    pinch0 = { d, mx, my }; updateCamera();
  } else if (gesture === 'tool') {
    const cc = pick3D(e); if (cc) { toolMove(cc); probeSim(cc[0], cc[1]); }
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (gesture === 'tool') toolUp(pick3D(e) || lineEnd);
  if (ptrs.size === 0) gesture = null;
}
glCanvas.addEventListener('pointerup', endPtr);
glCanvas.addEventListener('pointercancel', endPtr);
glCanvas.addEventListener('pointerleave', () => { if (!ptrs.size) probe.textContent = ''; });
glCanvas.addEventListener('wheel', e => {
  e.preventDefault(); const c = scene3.cam;
  c.r = Math.min(scene3.span * 6, Math.max(region.dx * 5, c.r * Math.exp(e.deltaY * 0.0012))); updateCamera();
}, { passive: false });
function panBy(dxp, dyp) {
  const c = scene3.cam, s = c.r * 0.0016;
  const cos = Math.cos(c.theta), sin = Math.sin(c.theta);
  c.target.x -= (dxp * cos + dyp * sin) * s;
  c.target.y -= (dxp * sin - dyp * cos) * s;
  updateCamera();
}

/* ---------- ponds ---------- */
let ponds = [];
function computePonds() {
  if (!S) return;
  const { w, h } = region, N = w * h, d = S.d, maxV = +$('#pV').value || 0.05, minD = +$('#pD').value || 0.05;
  const A = region.dx * region.dx, lab = new Int32Array(N), mask = new Uint8Array(N), stack = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, di = d[i]; if (di <= minD || S.sink[i]) continue;
    const qx = ((x > 0 ? S.qx[i - 1] : 0) + (x < w - 1 ? S.qx[i] : 0)) / 2, qy = ((y > 0 ? S.qy[i - w] : 0) + (y < h - 1 ? S.qy[i] : 0)) / 2;
    if (Math.hypot(qx, qy) / di < maxV) mask[i] = 1;
  }
  const out = []; let id = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (lab[s0] || !mask[s0]) continue;
    id++; lab[s0] = id; stack.push(s0);
    let vol = 0, n = 0, md = 0, mi = s0, surf = 0;
    while (stack.length) {
      const i = stack.pop(), x = i % w; vol += d[i]; n++; surf += region.z[i] + d[i];
      if (d[i] > md) { md = d[i]; mi = i; }
      if (x > 0 && mask[i - 1] && !lab[i - 1]) { lab[i - 1] = id; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !lab[i + 1]) { lab[i + 1] = id; stack.push(i + 1); }
      if (i >= w && mask[i - w] && !lab[i - w]) { lab[i - w] = id; stack.push(i - w); }
      if (i + w < N && mask[i + w] && !lab[i + w]) { lab[i + w] = id; stack.push(i + w); }
    }
    out.push({ vol: vol * A, area: n * A, md, x: mi % w, y: Math.floor(mi / w), level: surf / n });
  }
  const minVol = Math.max(0, +$('#pMin').value || 0);
  ponds = out.filter(p => p.vol >= Math.max(0.5, minVol)).sort((a, b) => b.vol - a.vol).slice(0, 8);
  const list = $('#pondList');
  list.innerHTML = ponds.map(p => `<li>${fmtVol(p.vol)} m³ <span>${p.area >= 10000 ? (p.area / 10000).toFixed(2) + ' ha' : Math.round(p.area).toLocaleString() + ' m²'}, deepest ${p.md.toFixed(2)} m, level ${p.level.toFixed(2)} m</span></li>`).join('');
  if (!ponds.length) list.innerHTML = '<li style="list-style:none;margin-left:-1.4rem;color:var(--muted)">No ponds yet.</li>';
  const lay = $('#labels'); lay.innerHTML = '';
  if ($('#pLabel').checked) ponds.forEach((p, k) => { const el = document.createElement('div'); el.className = 'plabel'; el.textContent = k + 1; lay.appendChild(el); });
  placeLabels();
}
['#pV', '#pD', '#pMin', '#pLabel'].forEach(s => $(s).addEventListener('change', computePonds));
function placeLabels() {
  const els = $('#labels').children; if (!els.length) return;
  const wr = well.getBoundingClientRect();
  ponds.forEach((p, k) => {
    const el = els[k]; if (!el) return;
    let X, Y, vis = true;
    if (viewMode === '3d' && scene3 && !glCanvas.hidden) {
      const v = gridToWorld(p.x, p.y, 0).project(scene3.camera), r = glCanvas.getBoundingClientRect();
      X = r.left - wr.left + (v.x + 1) / 2 * r.width; Y = r.top - wr.top + (1 - v.y) / 2 * r.height; vis = v.z < 1;
    } else {
      const r = view.getBoundingClientRect();
      X = r.left - wr.left + (p.x + 0.5) / region.w * r.width; Y = r.top - wr.top + (p.y + 0.5) / region.h * r.height;
    }
    el.style.left = X + 'px'; el.style.top = Y + 'px'; el.style.display = vis ? '' : 'none';
  });
}

/* ---------- scenarios ---------- */
// Saved to the viewer's private store (follows them between devices) when available, else this browser.
const LS_KEY = 'runoff-scenarios';
const browserStore = {
  kind: 'browser',
  async list() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; } },
  async save(sc) { const all = await this.list(); const i = all.findIndex(x => x.id === sc.id); if (i >= 0) all[i] = sc; else all.push(sc);
    localStorage.setItem(LS_KEY, JSON.stringify(all)); },
  async del(id) { localStorage.setItem(LS_KEY, JSON.stringify((await this.list()).filter(x => x.id !== id))); }
};
let store = null, downloadsApi = null;
function scNote(msg, err) { const n = $('#scNote'); n.textContent = msg; n.classList.toggle('err', !!err); }
(async () => {
  let s = browserStore;
  try {
    if (window.claude && typeof claude.use === 'function') {
      const [db, user, dl] = await Promise.all([claude.use('db'), claude.use('user'), claude.use('downloads')]);
      downloadsApi = dl;
      const uid = user ? await user.id() : null;
      if (db && uid) {
        const col = db.doc('data/users/' + uid + '/profile').collection('scenarios');
        s = { kind: 'account',
          async list() { const snap = await col.get(); return snap.docs.map(d => d.data()).filter(Boolean); },
          async save(sc) { await col.doc(sc.id).set(sc); },
          async del(id) { await col.doc(id).delete(); } };
      }
    }
  } catch (e) { s = browserStore; }
  // outside claude.ai there's no downloads capability, so hand the file over with an ordinary download link
  if (!downloadsApi && !(window.claude && typeof claude.use === 'function')) downloadsApi = {
    save: async ({ filename, data }) => {
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000); return { status: 'saved' };
    } };
  store = s; $('#scExport').hidden = !downloadsApi;
  refreshScenarios();
})();

const demSig = () => dem && { name: dem.name, w: dem.w, h: dem.h, cell: dem.cell, ox: dem.ox, oy: dem.oy, ea: dem.ea || null };
const sameDem = sc => dem && sc.dem && sc.dem.w === dem.w && sc.dem.h === dem.h && Math.abs(sc.dem.cell - dem.cell) < 1e-6;

// v2 saves earthworks and soil painting as recipes (small, and replayable); v1 files still load
function snapshotScenario(name, id) {
  const strip = op => { const o = { ...op }; delete o.info; return o; };
  return {
    v: 2, id: id || 's' + Date.now().toString(36), name, saved: new Date().toISOString(),
    dem: demSig(), sel: { ...sel }, k: region.k,
    ops: region.ops.map(strip),
    zones: region.zones.map(z => ({ ...z })), soilOps: region.soilOps.map(s => ({ ...s })),
    sources: S.sources.map(s => ({ x: s.x, y: s.y, Q: s.Q })),
    culverts: S.culverts.map(c => ({ ax: c.ax, ay: c.ay, bx: c.bx, by: c.by, D: c.D })),
    cond: { rain: $('#rain').value, rainDur: $('#rainDur').value, soil: $('#soil').value, wet: $('#wet').value,
      cover: $('#cover').value, infil: $('#infil').value, edges: $('#edges').value, zonesOn: $('#zonesOn').checked }
  };
}

async function applyScenario(sc) {
  // scenarios built on Environment Agency lidar carry their box, so fetch it (or pull it from the cache) first
  if (sc && sc.dem && sc.dem.ea && !sameDem(sc)) {
    const b = document.activeElement && document.activeElement.tagName === 'BUTTON' ? document.activeElement : null;
    busyBtn(b, 'Loading');
    try { stopSim(); await eaLoadBox(sc.dem.ea); } catch (err) { busyBtn(b, null); scNote(err.message || String(err), true); return; }
    busyBtn(b, null);
  }
  if (!sc || !(sc.v === 1 || sc.v === 2) || !sc.dem) { scNote('That doesn’t look like a Runoff scenario.', true); return; }
  if (!dem) { scNote(`Open the terrain file “${sc.dem.name}” first, then load this.`, true); return; }
  if (!sameDem(sc)) { scNote(`This was saved on “${sc.dem.name}” (${sc.dem.w} × ${sc.dem.h} cells), which doesn’t match the file that’s open.`, true); return; }
  stopSim();
  sel = { ...sc.sel }; updateSelection();
  const opt = [...$('#cellsize').options].find(o => +o.value === sc.k);
  if (!opt) { scNote('The saved cell size doesn’t fit this area.', true); return; }
  $('#cellsize').value = sc.k;
  const c = sc.cond || {};
  for (const [id, v] of Object.entries({ rain: c.rain, rainDur: c.rainDur, soil: c.soil, wet: c.wet, cover: c.cover, infil: c.infil, edges: c.edges }))
    if (v !== undefined) $('#' + id).value = v;
  $('#zonesOn').checked = !!c.zonesOn;
  $('#go').click();
  if (sc.v === 1) region.ops = (sc.edits || []).map(e => ({ type: 'raw', cells: e.cells, z: e.z, id: ++opSeq }));
  else region.ops = (sc.ops || []).map(o => ({ ...o, id: ++opSeq }));
  region.zones = (sc.zones || []).map(z => ({ ...z })); region.soilOps = (sc.soilOps || []).map(s => ({ ...s }));
  for (const s of sc.sources || []) S.sources.push({ i: s.y * region.w + s.x, x: s.x, y: s.y, Q: s.Q, id: ++opSeq });
  for (const k of sc.culverts || []) S.culverts.push({ a: k.ay * region.w + k.ax, b: k.by * region.w + k.bx, ax: k.ax, ay: k.ay, bx: k.bx, by: k.by, D: k.D, Q: 0, id: ++opSeq });
  $('#zonesOn').dispatchEvent(new Event('change'));
  rebuildZones(); computeSoil(); rebuildTerrain(); renderZoneList();
  markersDirty = true; render2D(S.d);
  $('#scName').value = sc.name; currentScenarioId = sc.id;
  scNote(sc.dem.name === dem.name ? `Loaded “${sc.name}”.` : `Loaded “${sc.name}”. It was saved on a file named “${sc.dem.name}”, which has the same size as this one.`);
}

let currentScenarioId = null;
async function refreshScenarios() {
  $('#saveRow').hidden = mode !== 'sim';
  const ul = $('#scList');
  if (!store) { ul.innerHTML = '<li><span class="note">Connecting…</span></li>'; return; }
  let all = [];
  try { all = await store.list(); } catch (e) { scNote('Couldn’t read saved scenarios.', true); }
  all.sort((a, b) => (sameDem(b) - sameDem(a)) || String(b.saved).localeCompare(String(a.saved)));
  ul.innerHTML = '';
  if (!all.length) { ul.innerHTML = `<li><span class="note">Nothing saved yet. Saves go to ${store.kind === 'account' ? 'your account, so they follow you between devices' : 'this browser'}.</span></li>`; return; }
  for (const sc of all) {
    const li = document.createElement('li'), sp = document.createElement('span'), nm = document.createElement('div'), sm = document.createElement('small');
    nm.textContent = sc.name || 'Untitled';
    const when = sc.saved ? new Date(sc.saved).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    sm.textContent = (sameDem(sc) ? '' : sc.dem && sc.dem.ea ? `Lidar for ${sc.dem.ea.place}, fetched when loaded. ` : `Needs ${sc.dem ? sc.dem.name : 'another file'} open. `) + when;
    sp.append(nm, sm);
    const load = document.createElement('button'); load.textContent = 'Load'; load.disabled = !sameDem(sc) && !(sc.dem && sc.dem.ea);
    load.onclick = () => applyScenario(sc);
    const del = document.createElement('button'); del.textContent = 'Delete';
    del.onclick = async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Sure?'; setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Delete'; }, 3000); return; }
      try { await store.del(sc.id); if (currentScenarioId === sc.id) currentScenarioId = null; refreshScenarios(); } catch (e) { scNote('Couldn’t delete that.', true); }
    };
    li.append(sp, load, del); ul.appendChild(li);
  }
}

$('#scSave').addEventListener('click', async () => {
  if (!S || !store) return;
  const name = $('#scName').value.trim() || `Setup ${new Date().toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  let id = null;
  try { const all = await store.list(); const same = all.find(x => x.name === name && sameDem(x)); if (same) id = same.id; } catch (e) {}
  const sc = snapshotScenario(name, id);
  const size = JSON.stringify(sc).length;
  if (size > 240000) { scNote('This setup is too big to save here (lots of earthworks). Export it as a file instead.', true); return; }
  try { await store.save(sc); currentScenarioId = sc.id; $('#scName').value = name;
    scNote(`${id ? 'Updated' : 'Saved'} “${name}”${store.kind === 'account' ? ' to your account' : ' in this browser'}.`); refreshScenarios(); }
  catch (e) { scNote('Saving failed' + (e && e.code ? ` (${e.code})` : '') + '. Try exporting a file instead.', true); }
});
$('#scExport').addEventListener('click', async () => {
  if (!S) { scNote('Set up an area first.', true); return; }
  if (!downloadsApi) { scNote('Saving files isn’t available here.', true); return; }
  const name = $('#scName').value.trim() || 'runoff-scenario';
  const sc = snapshotScenario(name, currentScenarioId);
  try { await downloadsApi.save({ filename: name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.json', data: JSON.stringify(sc) }); scNote('Exported.'); }
  catch (e) { if (e && e.code !== 'declined') scNote('Export didn’t work' + (e.code ? ` (${e.code})` : '') + '.', true); }
});
$('#scImport').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { applyScenario(JSON.parse(await f.text())); } catch (err) { scNote('Couldn’t read that file.', true); }
  e.target.value = '';
});

/* ---------- full screen and fit ---------- */
$('#fit').addEventListener('click', () => {
  if (viewMode === '3d' && scene3) { const c = scene3.cam; c.target.set(0, 0, c.target.z); c.r = scene3.span * 1.1; c.theta = 0.35; c.phi = 0.95; updateCamera(); }
  else fitCanvas(true);
});
async function toggleFull() {
  if (isFull()) {
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (e) {} }
    document.body.classList.remove('maxi');
  } else {
    let ok = false;
    try { if ($('#stage').requestFullscreen) { await $('#stage').requestFullscreen(); ok = true; } } catch (e) { ok = false; }
    if (!ok) document.body.classList.add('maxi');   // viewers that block real full screen get a page-filling view instead
  }
  $('#fs').textContent = isFull() ? 'Exit full screen' : 'Full screen';
  setTimeout(() => fitCanvas(true), 60);
}
$('#fs').addEventListener('click', toggleFull);
$('#fsExit').addEventListener('click', toggleFull);
$('#fsRun').addEventListener('click', () => $('#run').click());
document.addEventListener('fullscreenchange', () => { $('#fs').textContent = isFull() ? 'Exit full screen' : 'Full screen'; setTimeout(() => fitCanvas(true), 60); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('maxi')) toggleFull(); });

/* ---------- stats + loop ---------- */
function fmtVol(v) { return v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : Math.round(v).toLocaleString(); }
function fmtTime(t) {
  const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
let lastStats = 0, rateMark = null, rateShown = '';
function updateStats(force) {
  const now = performance.now();
  if (!force && now - lastStats < 250) return;
  lastStats = now;
  $('#clock').textContent = fmtTime(S.t);
  $('#rate').textContent = $('#fsRate').textContent = running ? rateShown || 'Running' : 'Paused';
  $('#fsClock').textContent = $('#clock').textContent;
  const V = S.vol, st = stored(S);
  const inn = V.rain + V.added + V.source, out = V.drained + V.infil, err = inn - st - out;
  $('#b-rain').textContent = fmtVol(V.rain); $('#b-pour').textContent = fmtVol(V.added);
  $('#b-src').textContent = fmtVol(V.source); $('#b-store').textContent = fmtVol(st);
  $('#b-out').textContent = fmtVol(V.drained); $('#b-inf').textContent = fmtVol(V.infil);
  $('#b-err').textContent = inn > 0 ? (100 * Math.abs(err) / inn < 1e-6 ? '0%' : (100 * err / inn).toExponential(1) + '%') : '0';
  if (S.culverts.length) updateFeatureLive();
}

let simTarget = 0, lastFrame = performance.now(), lastDraw = 0, lastPonds = 0, rainStart = 0;
const shownDepth = () => $('#showDepth').value === 'peak' ? region.peak : S.d;
$('#showDepth').addEventListener('change', () => { markersDirty = true; });
function afterSteps(now) {
  const pk = region.peak, dd = S.d;
  for (let i = 0; i < pk.length; i++) if (dd[i] > pk[i]) pk[i] = dd[i];
  if (now - lastPonds > 1000) { lastPonds = now; computePonds(); }
}
async function engBatch(eng, n) {
  const Sx = S; eng.busy = true;
  try { await eng.run(Sx, n); }
  catch (e) {
    eng.busy = false; eng.lost = true; $('#engine').value = 'cpu'; Sx.dirty = true;
    engineNote(`The ${ENGINE_NAME[eng.kind]} engine stopped working, so this switched to one core. Reload to try again.`);
    flushEdits(); return;
  }
  eng.busy = false;
  if (Sx !== S) return;
  const dur = (+$('#rainDur').value || 0) * 60;
  if (dur > 0 && S.rain > 0 && S.t - rainStart >= dur) { $('#rain').value = 0; readRain(); }
  afterSteps(performance.now());
  flushEdits();
}
function frame(now) {
  const realDt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  if (mode === 'sim' && S) {
    // while running, draw ~30 times a second and give the physics the rest of the frame
    const draw = !running || now - lastDraw > 32;
    if (running) {
      const speed = +$('#speed').value, simStart = S.t;
      if (speed > 0) { simTarget += speed * realDt; if (simTarget - S.t > speed) simTarget = S.t + speed; }
      const dur = (+$('#rainDur').value || 0) * 60;
      const eng = benchBusy ? null : activeEng();
      if (benchBusy) { /* engines are being timed; wait */ }
      else if (eng) {
        if (!eng.busy) {
          const est = Math.max(S.lastDt || 0.5, 0.02);
          let n = speed > 0 ? Math.ceil((simTarget - S.t) / est) : Math.round((eng.targetMs || 14) / Math.max(eng.lastMsPerStep, 0.005));
          if (dur > 0 && S.rain > 0) n = Math.min(n, Math.max(1, Math.ceil((rainStart + dur - S.t) / est)));
          if (speed === 0) n = Math.max(1, n);
          if (n > 0) engBatch(eng, Math.min(n, eng.kind === 'gpu' ? 1024 : 4096));
        }
      } else if (!busyOn()) {
        const t0 = performance.now(), budget = draw ? 10 : 14;
        while (performance.now() - t0 < budget && (speed === 0 || S.t < simTarget)) {
          step(S);
          if (dur > 0 && S.rain > 0 && S.t - rainStart >= dur) { $('#rain').value = 0; readRain(); }
        }
        afterSteps(now);
      }
      // speed from the sim clock over wall time, so batches landing from other threads count too
      if (rateMark === null || S.t < rateMark.s) rateMark = { t: now, s: S.t };
      else if (now - rateMark.t > 1000) {
        const x = (S.t - rateMark.s) / ((now - rateMark.t) / 1000);
        rateShown = x < 1.5 ? 'About real time' : `${x < 100 ? x.toFixed(x < 10 ? 1 : 0) : Math.round(x).toLocaleString()}× real time`;
        rateMark = { t: now, s: S.t };
      }
    }
    if (draw || markersDirty) {
      lastDraw = now;
      if (viewMode === '3d' && scene3 && !glCanvas.hidden) {
        updateWater3D(shownDepth());
        if (markersDirty || (running && S.sources.length + S.culverts.length && now - scene3.lastMk > 400)) rebuildMarkers();
        scene3.renderer.render(scene3.scene, scene3.camera);
      } else render2D(shownDepth());
      placeLabels();
    }
    updateStats();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
