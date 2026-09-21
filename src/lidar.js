/* ---------- Environment Agency lidar, straight from their Web Coverage Service ----------
   Two stages: a coarse overview of a wide area to pick from, then the chosen box at full resolution.
   England only. Data © Environment Agency copyright and/or database right, Open Government Licence. */
const EA = {
  ds: { 1: 'lidar-composite-digital-terrain-model-dtm-1m', 2: 'lidar-composite-digital-terrain-model-dtm-2m' },
  cov: {}, // coverage ids, discovered from the service
  attrib: '© Environment Agency copyright and/or database right, Open Government Licence.',
  maxFineM: 4000,        // biggest box we'll fetch at full resolution, metres a side
  fineAt1mM2: 4e6        // above this area, use the 2 m data instead of 1 m
};
const eaUrlBase = res => `https://environment.data.gov.uk/spatialdata/${EA.ds[res]}/wcs`;

async function eaCoverageId(res) {
  if (EA.cov[res]) return EA.cov[res];
  const r = await fetch(`${eaUrlBase(res)}?service=WCS&version=2.0.1&request=GetCapabilities`);
  if (!r.ok) throw new Error(`The lidar service didn't answer (${r.status}).`);
  const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
  for (const s of xml.getElementsByTagNameNS('*', 'CoverageSummary')) {
    const title = s.getElementsByTagNameNS('*', 'Title')[0], id = s.getElementsByTagNameNS('*', 'CoverageId')[0];
    if (id && title && /elevation/i.test(title.textContent)) return (EA.cov[res] = id.textContent);
  }
  throw new Error('Couldn’t find the elevation layer in the lidar service.');
}

function eaCoverageUrl(res, id, e0, n0, e1, n1, factor) {
  const q = `service=WCS&version=2.0.1&request=GetCoverage&coverageId=${encodeURIComponent(id)}&format=image/tiff` +
    `&subset=E(${Math.round(e0)},${Math.round(e1)})&subset=N(${Math.round(n0)},${Math.round(n1)})` +
    (factor && factor < 1 ? `&scaleFactor=${factor}` : '');
  return `${eaUrlBase(res)}?${q}`;
}

/* downloaded lidar is kept in this browser (IndexedDB) so the same box never costs a second API call */
const TileCache = {
  db: null, max: 40,
  open() {
    if (this.db) return this.db;
    return (this.db = new Promise(res => {
      try {
        const rq = indexedDB.open('runoff-cache', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('tiff');
        rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
      } catch (e) { res(null); }
    }));
  },
  async get(key) {
    const db = await this.open(); if (!db) return null;
    return new Promise(res => { try { const g = db.transaction('tiff').objectStore('tiff').get(key); g.onsuccess = () => res(g.result ? g.result.buf : null); g.onerror = () => res(null); } catch (e) { res(null); } });
  },
  async put(key, buf) {
    const db = await this.open(); if (!db) return;
    try {
      const st = db.transaction('tiff', 'readwrite').objectStore('tiff');
      st.put({ buf, t: Date.now() }, key);
      const keys = st.getAllKeys();
      keys.onsuccess = () => { if (keys.result.length > this.max) { const all = st.getAll(); all.onsuccess = () => {
        const rows = keys.result.map((k, i) => [k, all.result[i].t]).sort((a, b) => a[1] - b[1]);
        rows.slice(0, rows.length - this.max).forEach(([k]) => st.delete(k)); }; } };
    } catch (e) {}
  }
};

async function eaFetchTiff(url, onProgress) {
  const cached = await TileCache.get(url);
  if (cached) { if (onProgress) onProgress(1); return cached; }
  const buf = await eaFetchTiffNet(url, onProgress);
  TileCache.put(url, buf);
  return buf;
}

async function eaFetchTiffNet(url, onProgress) {
  let r;
  try { r = await fetch(url); }
  catch (e) { throw new Error('Couldn’t reach the lidar service. This copy of Runoff may not be allowed to fetch from other sites: the downloadable version can.'); }
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !/tiff/i.test(type)) {
    let msg = `The lidar service returned ${r.status}.`;
    try { const t = await r.text(); const m = t.match(/<[^>]*ExceptionText[^>]*>([^<]+)</); if (m) msg = `The lidar service said: ${m[1].trim()}`; } catch (e) {}
    throw new Error(msg);
  }
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !r.body.getReader) return await r.arrayBuffer();
  const reader = r.body.getReader(), chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length;
    if (onProgress) onProgress(total ? got / total : Math.min(0.9, got / 6e6));
  }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf.buffer;
}

/* ---------- finding a place ---------- */
const GRID_LETTERS = ['SV','SW','SX','SY','SZ','TV','TW','SQ','SR','SS','ST','SU','TQ','TR','SL','SM','SN','SO','SP','TL','TM','SF','SG','SH','SJ','SK','TF','TG','SA','SB','SC','SD','SE','TA','TB','NV','NW','NX','NY','NZ','OV','OW','NQ','NR','NS','NT','NU','OQ','OR','NL','NM','NN','NO','NP','OL','OM','NF','NG','NH','NJ','NK','OF','OG','NA','NB','NC','ND','NE','OA','OB','HV','HW','HX','HY','HZ','JV','JW','HQ','HR','HS','HT','HU','JQ','JR','HL','HM','HN','HO','HP','JL','JM'];
function parseGridRef(s) {
  const t = s.replace(/\s+/g, '').toUpperCase();
  const m = t.match(/^([A-Z]{2})(\d{2,10})$/); if (!m) return null;
  const idx = GRID_LETTERS.indexOf(m[1]); if (idx < 0 || m[2].length % 2) return null;
  const e100 = (idx % 7) * 100000, n100 = Math.floor(idx / 7) * 100000;
  const half = m[2].length / 2, scale = Math.pow(10, 5 - half);
  return [e100 + +m[2].slice(0, half) * scale, n100 + +m[2].slice(half) * scale];
}
async function eaSearch(q) {
  const gr = parseGridRef(q);
  if (gr) return [{ name: `Grid reference ${q.toUpperCase().replace(/\s+/g, ' ')}`, e: gr[0], n: gr[1] }];
  const en = q.match(/^\s*(\d{5,6})\s*[,\s]\s*(\d{5,6})\s*$/);
  if (en) return [{ name: `E ${en[1]} N ${en[2]}`, e: +en[1], n: +en[2] }];
  const out = [], seen = new Set();
  const looksPostcode = /^[a-z]{1,2}\d[a-z\d]?\s*\d?[a-z]{0,2}$/i.test(q.trim());
  const calls = looksPostcode
    ? [`https://api.postcodes.io/postcodes/${encodeURIComponent(q.trim())}/autocomplete`, `https://api.postcodes.io/places?q=${encodeURIComponent(q)}&limit=5`]
    : [`https://api.postcodes.io/places?q=${encodeURIComponent(q)}&limit=8`];
  for (const url of calls) {
    let j; try { const r = await fetch(url); j = await r.json(); } catch (e) { continue; }
    const rows = j && j.result ? (Array.isArray(j.result) ? j.result : [j.result]) : [];
    for (const row of rows) {
      if (typeof row === 'string') { // autocomplete gives postcodes as plain strings; look each one up
        try { const r2 = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(row)}`); const j2 = await r2.json();
          if (j2.result && j2.result.eastings) out.push({ name: `${j2.result.postcode}, ${j2.result.admin_district || ''}`.replace(/, $/, ''), e: j2.result.eastings, n: j2.result.northings }); } catch (e) {}
        continue;
      }
      const e = row.eastings, n = row.northings;
      if (!e || !n) continue;
      const name = [row.name_1 || row.postcode, row.county_unitary || row.admin_district || row.region].filter(Boolean).join(', ');
      if (seen.has(name)) continue; seen.add(name);
      out.push({ name, e, n });
    }
    if (out.length >= 5) break;
  }
  return out.slice(0, 8);
}

/* ---------- the two stages ---------- */
async function eaLoadOverview(e, n, name, sizeM) {
  // ask for a shrunken wide view of the chosen size; if the service won't shrink, fall back to 2 km at full resolution
  const want = sizeM || +$('#eaSize').value || 4000;
  const shrunk = { size: want, factor: +Math.min(1, 800 / (want / 2)).toFixed(3) };
  const plain = { size: 2000, factor: 1 };
  const ladder = EA.noShrink ? [plain] : [shrunk, plain];
  setInfo(`Fetching an overview around ${name}…`);
  setLogo('loading', 0.02);
  try {
    const res = 2, id = await eaCoverageId(res);
    let buf = null, S = 0, last = null;
    for (const stepDef of ladder) {
      const size = stepDef.size, e0 = Math.round(e - size / 2), n0 = Math.round(n - size / 2);
      try {
        buf = await eaFetchTiff(eaCoverageUrl(res, id, e0, n0, e0 + size, n0 + size, stepDef.factor), p => setLogo('loading', 0.05 + p * 0.85));
        S = size; break;
      } catch (err) { last = err; if (stepDef.factor < 1) EA.noShrink = true; setInfo(`The service turned down a ${size / 1000} km view, trying another way…`); }
    }
    if (!buf) throw last || new Error('The lidar service refused the overview.');
    const e0 = Math.round(e - S / 2), n0 = Math.round(n - S / 2);
    const d = await parseTIFF(buf);
    d.remote = { e: e0 + S / 2, n: n0 + S / 2, size: S, place: name };
    finishDEM(d, `Lidar around ${name}`);
    setInfo(`${name}: ${(S / 1000)} km overview at about ${+(dem.cell).toFixed(1)} m. Drag a box, then press “Simulate this area” to download that part at full detail. ${EA.attrib}`);
    setLogo('calm');
    await loadMapFor(dem, () => { buildOverview(); if (mode === 'select') drawOverview(); });
    return true;
  } catch (err) { setInfo(err.message || String(err), true); setLogo(dem ? 'calm' : 'idle'); return false; }
}

// called when the user presses Simulate on a remote overview: fetch just that box at full resolution
async function eaLoadDetail() {
  const e0 = dem.ox + sel.x0 * dem.cell, e1 = dem.ox + sel.x1 * dem.cell;
  const n1 = dem.oy - sel.y0 * dem.cell, n0 = dem.oy - sel.y1 * dem.cell;
  const wM = e1 - e0, hM = n1 - n0;
  if (Math.max(wM, hM) > EA.maxFineM) { setInfo(`That box is ${(Math.max(wM, hM) / 1000).toFixed(1)} km across. Pick one up to ${EA.maxFineM / 1000} km for a full-detail download.`, true); return; }
  const res = wM * hM > EA.fineAt1mM2 ? 2 : 1;
  const parent = dem, wantM = +$('#cellsize').value || res;
  setInfo(`Downloading ${(wM / 1000).toFixed(2)} × ${(hM / 1000).toFixed(2)} km at ${res} m…`);
  busyBtn($('#go'), 'Downloading');
  setLogo('loading', 0.02);
  try {
    const id = await eaCoverageId(res);
    const buf = await eaFetchTiff(eaCoverageUrl(res, id, e0, n0, e1, n1), p => setLogo('loading', 0.05 + p * 0.85));
    const d = await parseTIFF(buf);
    d.parent = parent;
    d.ea = { e0: Math.round(e0), n0: Math.round(n0), e1: Math.round(e1), n1: Math.round(n1), res, place: parent.remote.place };
    finishDEM(d, `${parent.remote.place} at ${res} m`);
    loadMapFor(dem, () => { buildOverview(); if (mode === 'select') drawOverview(); });
    setLogo('calm');
    setInfo(`${parent.remote.place}: ${dem.w} × ${dem.h} cells at ${res} m. ${EA.attrib}`);
    const k = Math.max(1, Math.round(wantM / dem.cell));
    if ([...$('#cellsize').options].some(o => +o.value === k)) $('#cellsize').value = k;
    busyBtn($('#go'), null);
    $('#go').click();
  } catch (err) { busyBtn($('#go'), null); setInfo(err.message || String(err), true); setLogo('calm'); }
}

// re-download (or pull from the cache) the exact box a saved scenario was built on
async function eaLoadBox(ea) {
  setInfo(`Fetching the lidar for ${ea.place}…`); setLogo('loading', 0.02);
  const id = await eaCoverageId(ea.res);
  const buf = await eaFetchTiff(eaCoverageUrl(ea.res, id, ea.e0, ea.n0, ea.e1, ea.n1), p => setLogo('loading', 0.05 + p * 0.85));
  const d = await parseTIFF(buf); d.ea = { ...ea };
  finishDEM(d, `${ea.place} at ${ea.res} m`); setLogo('calm');
  setInfo(`${ea.place}: ${dem.w} × ${dem.h} cells at ${ea.res} m. ${EA.attrib}`);
}

/* ---------- search box ---------- */
async function eaDoSearch() {
  const q = $('#eaQ').value.trim(), box = $('#eaResults');
  if (!q) return;
  box.innerHTML = '<div class="empty">Looking…</div>';
  let rows = [];
  try { rows = await eaSearch(q); } catch (e) { box.innerHTML = `<div class="empty err">${e.message || 'Search failed.'}</div>`; return; }
  if (!rows.length) { box.innerHTML = '<div class="empty">Nothing found. Try a postcode, a place name, or a grid reference like ST 587 728.</div>'; return; }
  box.innerHTML = '';
  for (const r of rows) {
    const el = document.createElement('div'); el.className = 'feat';
    el.innerHTML = `<span class="ft" style="grid-column:1/3">${r.name}</span><span></span><button>Use</button><span class="fi">E ${Math.round(r.e)} N ${Math.round(r.n)}</span>`;
    el.querySelector('button').onclick = async () => {
      const btn = el.querySelector('button'); stopSim(); busyBtn(btn, 'Loading');
      const ok = await eaLoadOverview(r.e, r.n, r.name);
      busyBtn(btn, null); if (!ok) return;
      box.innerHTML = '';
      await foldPanel($('#p-load'), true);   // everything's loaded, so the slide has the page to itself
      $('#p-select').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    box.appendChild(el);
  }
}
$('#eaGo').addEventListener('click', eaDoSearch);
$('#eaQ').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); eaDoSearch(); } });


/* ---------- Ordnance Survey backdrop (same grid as the lidar, so no warping) ----------
   Needs a free OS Data Hub key. Contains OS data © Crown copyright and database rights. */
const OS = {
  origin: [-238375, 1376256], tile: 256,
  res: [896, 448, 224, 112, 56, 28, 14, 7, 3.5, 1.75, 0.875, 0.4375, 0.21875, 0.109375],
  maxZoom: () => $('#osPremium').checked ? 13 : 9,   // closer levels are Premium on the free OpenData plan, and get refused
  shared: '__RUNOFF_OS_KEY__',
  own: () => { try { return localStorage.getItem('runoff-os-key') || ''; } catch (e) { return ''; } },
  key: () => OS.own() || OS.shared,
  attrib: 'Contains OS data © Crown copyright and database rights.'
};
const looksBNG = d => d && d.geo !== false && d.ox > -10000 && d.ox < 700000 && d.oy > 0 && d.oy < 1300000;

// stitch OS tiles covering a British National Grid box into a canvas
async function osImage(e0, n0, e1, n1, wantPx) {
  const key = OS.key(); if (!key) throw new Error('no key');
  const want = (e1 - e0) / wantPx;
  const zmax = OS.maxZoom(); let z = zmax; for (let i = 0; i <= zmax; i++) if (OS.res[i] <= want * 1.3) { z = i; break; }
  const r = OS.res[z], span = OS.tile * r;
  const x0 = Math.floor((e0 - OS.origin[0]) / span), x1 = Math.floor((e1 - OS.origin[0]) / span);
  const y0 = Math.floor((OS.origin[1] - n1) / span), y1 = Math.floor((OS.origin[1] - n0) / span);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 100) throw new Error('too many tiles');
  const cv = document.createElement('canvas'); cv.width = cv.height = wantPx;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, wantPx, wantPx);
  const sx = wantPx / (e1 - e0), sy = wantPx / (n1 - n0), style = $('#osStyle').value;
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push(new Promise(done => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      const te = OS.origin[0] + tx * span, tn = OS.origin[1] - ty * span;   // tile top-left in grid metres
      ctx.drawImage(img, (te - e0) * sx, (n1 - tn) * sy, span * sx, span * sy); done(true);
    };
    img.onerror = () => done(false);
    img.src = `https://api.os.uk/maps/raster/v1/zxy/${style}/${z}/${tx}/${ty}.png?key=${encodeURIComponent(key)}`;
  }));
  const ok = await Promise.all(jobs);
  if (!ok.some(Boolean)) throw new Error('no tiles came back');
  return cv;
}

// sample the backdrop onto the grid of a DEM or region, ready for shading
function samplePix(cv, w, h) {
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const c = t.getContext('2d'); c.imageSmoothingEnabled = true; c.drawImage(cv, 0, 0, w, h);
  return c.getImageData(0, 0, w, h).data;
}
async function loadMapFor(target, after) {
  if (!OS.key() || !+$('#mapMix').value) return;
  const isRegion = !!target.dx;
  const e0 = isRegion ? dem.ox + target.x0 * dem.cell : target.ox;
  const n1 = isRegion ? dem.oy - target.y0 * dem.cell : target.oy;
  const e1 = e0 + (isRegion ? target.w * target.dx : target.w * target.cell);
  const n0 = n1 - (isRegion ? target.h * target.dx : target.h * target.cell);
  if (!looksBNG(isRegion ? dem : target)) return;
  try {
    const cv = await osImage(e0, n0, e1, n1, isRegion ? 1024 : 1600);
    target.mapCv = cv; target.mapPix = samplePix(cv, target.w, target.h);
    if (after) after();
  } catch (err) { if (err.message !== 'no key') setInfo(`Backdrop map: ${err.message}. ${OS.attrib}`, true); }
}
function osKeyUI(editing) {
  const own = OS.own(), shared = OS.shared;
  $('#osKeyRow').hidden = !editing && !!(own || shared);
  $('#osKeySet').hidden = !$('#osKeyRow').hidden;
  $('#osKeyState').textContent = own ? `Your key (ending ${own.slice(-4)}).` : shared ? 'Using the shared Runoff map key.' : '';
  $('#osKeyEdit').textContent = own ? 'Change' : 'Use my own';
  $('#osPremium').disabled = !own; if (!own) $('#osPremium').checked = false;
}
function osRefresh() {
  if (region) { region.mapPix = null; loadMapFor(region, () => { reshade(); if (scene3) updateTerrain3D(); }); }
  if (dem) { dem.mapPix = null; dem.mapCv = null; loadMapFor(dem, () => { buildOverview(); if (mode === 'select') drawOverview(); }); }
}
$('#osKeySave').addEventListener('click', () => {
  const k = $('#osKey').value.trim(); if (!k) return;
  try { localStorage.setItem('runoff-os-key', k); } catch (e) {}
  $('#osKey').value = '';
  if (!+$('#mapMix').value) { $('#mapMix').value = 60; $('#mapMixOut').textContent = '60%'; }
  osKeyUI();
if (OS.key() && !+$('#mapMix').value) { $('#mapMix').value = 50; $('#mapMixOut').textContent = '50%'; } osRefresh();
});
$('#osKey').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#osKeySave').click(); } });
$('#osKeyEdit').addEventListener('click', () => {
  try { localStorage.removeItem('runoff-os-key'); } catch (e) {}
  osKeyUI(true); $('#osKey').focus();
});
$('#osStyle').addEventListener('change', osRefresh);
$('#osPremium').addEventListener('change', () => {
  const p = $('#osPremium').checked; try { localStorage.setItem('runoff-os-premium', p ? '1' : ''); } catch (e) {}
  $('#osStyle').querySelector('option[value=Leisure_27700]').disabled = !p;
  if (!p && $('#osStyle').value === 'Leisure_27700') $('#osStyle').value = 'Outdoor_27700';
  osRefresh();
});
try { $('#osPremium').checked = localStorage.getItem('runoff-os-premium') === '1'; } catch (e) {}
$('#osStyle').querySelector('option[value=Leisure_27700]').disabled = !$('#osPremium').checked;
$('#mapMix').addEventListener('input', () => {
  $('#mapMixOut').textContent = $('#mapMix').value + '%';
  if (region && !region.mapPix) loadMapFor(region, () => { reshade(); if (scene3) updateTerrain3D(); });
  else { if (region) reshade(); if (scene3) updateTerrain3D(); }
  if (dem && !dem.mapCv) loadMapFor(dem, () => { buildOverview(); if (mode === 'select') drawOverview(); });
  else if (mode === 'select' && dem) { buildOverview(); drawOverview(); }
});
osKeyUI();
if (OS.key() && !+$('#mapMix').value) { $('#mapMix').value = 50; $('#mapMixOut').textContent = '50%'; }
