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
// route lidar through the relay when one is set: it adds the cross-site header their servers omit,
// and gives the site owner a view of how the lidar services are behaving
const viaRelay = u => (RELAY && !u.startsWith(RELAY) && !u.startsWith('/')) ? `${RELAY}?url=${encodeURIComponent(u)}` : u;
// direct first (fast, no relay traffic); through the relay if the browser blocks reading the reply
async function fetchLidarUrl(url, init) {
  if (!RELAY || EA.relayOnly) return fetch(RELAY && EA.relayOnly ? viaRelay(url) : url, init);
  try { const r = await fetch(url, init); if (r.ok || r.status === 206) return r; EA.relayOnly = true; }
  catch (e) { EA.relayOnly = true; }
  return fetch(viaRelay(url), init);
}
async function getXml(url, who) {
  let last;
  for (let tryN = 0; tryN < 2; tryN++) {
    try {
      const r = await fetchLidarUrl(url);
      if (!r.ok) { last = new Error(`the ${who} service answered ${r.status}`); continue; }
      return new DOMParser().parseFromString(await r.text(), 'text/xml');
    } catch (e) { last = new Error(`couldn’t reach the ${who} service`); }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`${last.message[0].toUpperCase()}${last.message.slice(1)}. It may be down for a moment: try again shortly.`);
}

async function eaCoverageId(res) {
  if (EA.cov[res]) return EA.cov[res];
  const xml = await getXml(`${eaUrlBase(res)}?service=WCS&version=2.0.1&request=GetCapabilities`, 'Environment Agency lidar');
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
  try { r = await fetchLidarUrl(url); }
  catch (e) { throw new Error('Couldn’t reach the lidar service. It may be down for a moment, or this copy of Runoff may not be allowed to fetch from other sites.'); }
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

/* ---------- lidar providers: England (EA), Wales (DataMapWales), Scotland (Scottish Remote Sensing Portal) ----------
   Each gives: pick(e, n) -> a coverage for that spot {id, base, res}, and url(cov, box, factor).
   Wales and Scotland run GeoServer; their layers are discovered from the service rather than hard-coded. */
// British National Grid to rough lon/lat (Airy 1830 transverse Mercator, no datum shift: ~100 m out,
// plenty for deciding which survey covers a spot)
function bngToLonLat(E, N) {
  const a = 6377563.396, b = 6356256.909, F0 = 0.9996012717, lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180, N0 = -100000, E0 = 400000;
  const e2 = 1 - b * b / (a * a), n = (a - b) / (a + b);
  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const dl = lat - lat0, sl = lat + lat0;
    M = b * F0 * ((1 + n + 1.25 * n * n + 1.25 * n ** 3) * dl - (3 * n + 3 * n * n + 2.625 * n ** 3) * Math.sin(dl) * Math.cos(sl)
      + (1.875 * n * n + 1.875 * n ** 3) * Math.sin(2 * dl) * Math.cos(2 * sl) - (35 / 24) * n ** 3 * Math.sin(3 * dl) * Math.cos(3 * sl));
  } while (Math.abs(N - N0 - M) >= 0.01);
  const s = Math.sin(lat), c = Math.cos(lat), t = Math.tan(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * s * s), rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5), eta2 = nu / rho - 1, dE = E - E0;
  const VII = t / (2 * rho * nu), VIII = t / (24 * rho * nu ** 3) * (5 + 3 * t * t + eta2 - 9 * t * t * eta2), X = 1 / (c * nu), XI = 1 / (c * 6 * nu ** 3) * (nu / rho + 2 * t * t);
  return [(lon0 + X * dE - XI * dE ** 3) * 180 / Math.PI, (lat - VII * dE * dE + VIII * dE ** 4) * 180 / Math.PI];
}
function geoserverProvider(key, name, base, attrib, wanted, rank) {
  const P = { key, name, attrib, caps: null, res: {} };
  const get = q => getXml(`${base}?service=WCS&${q}`, `${name} lidar`);
  const txt = (el, tag) => ((el.getElementsByTagNameNS('*', tag)[0] || {}).textContent || '').trim();
  P.coverages = async () => {
    if (P.caps) return P.caps;
    const out = [];
    // WCS 2.0.1 first; some servers switch it off, so fall back to 1.0.0
    let xml = await get('version=2.0.1&request=GetCapabilities');
    const sums = xml.getElementsByTagNameNS('*', 'CoverageSummary');
    if (sums.length) {
      P.ver = '2.0.1';
      for (const s of sums) {
        const id = txt(s, 'CoverageId'), text = id + ' ' + txt(s, 'Title') + ' ' + txt(s, 'Abstract');
        const lc = txt(s, 'LowerCorner'), uc = txt(s, 'UpperCorner');
        out.push({ id, text, box: lc && uc ? [...lc.split(/\s+/).map(Number), ...uc.split(/\s+/).map(Number)] : null });
      }
    } else {
      xml = await get('version=1.0.0&request=GetCapabilities');
      P.ver = '1.0.0';
      for (const s of xml.getElementsByTagNameNS('*', 'CoverageOfferingBrief')) {
        const id = txt(s, 'name'), text = id + ' ' + txt(s, 'label') + ' ' + txt(s, 'description');
        const pos = [...s.getElementsByTagNameNS('*', 'pos')].map(p => p.textContent.trim().split(/\s+/).map(Number));
        out.push({ id, text, box: pos.length === 2 ? [pos[0][0], pos[0][1], pos[1][0], pos[1][1]] : null });
      }
    }
    const keep = out.filter(c => wanted(c.text)).map(c => ({ ...c, rank: rank(c.text) }));
    keep.sort((a, b) => b.rank - a.rank);
    console.info(`Runoff: ${name} (WCS ${P.ver}) offers:`, out.map(c => c.id), 'trying:', keep.map(c => c.id));
    if (!keep.length) throw new Error(`The ${name} lidar service has no terrain layers I recognise (it offers ${out.map(c => c.id).join(', ') || 'nothing'}).`);
    return (P.caps = keep);
  };
  P.nativeRes = async id => {
    if (P.res[id]) return P.res[id];
    let res = 1;
    try {
      const xml = await get(P.ver === '1.0.0' ? `version=1.0.0&request=DescribeCoverage&coverage=${encodeURIComponent(id)}` : `version=2.0.1&request=DescribeCoverage&coverageId=${encodeURIComponent(id)}`);
      let x0, x1;
      const lo = txt(xml, 'lowerCorner'), hi = txt(xml, 'upperCorner');
      if (lo && hi) { x0 = +lo.split(/\s+/)[0]; x1 = +hi.split(/\s+/)[0]; }
      else { const p = [...xml.getElementsByTagNameNS('*', 'Envelope')].map(e => [...e.getElementsByTagNameNS('*', 'pos')]).find(a => a.length === 2 && +a[0].textContent.split(/\s+/)[0] > 1000);
        if (p) { x0 = +p[0].textContent.trim().split(/\s+/)[0]; x1 = +p[1].textContent.trim().split(/\s+/)[0]; } }
      const g = +txt(xml, 'high').split(/\s+/)[0] + 1 - (+txt(xml, 'low').split(/\s+/)[0] || 0);
      if (x1 > x0 && g > 0) res = (x1 - x0) / g;
    } catch (e) {}
    return (P.res[id] = res);
  };
  P.candidates = async (e, n) => {
    const [lon, lat] = bngToLonLat(e, n);
    return (await P.coverages()).filter(c => !c.box || (lon >= c.box[0] && lon <= c.box[2] && lat >= c.box[1] && lat <= c.box[3]));
  };
  P.url = (cov, e0, n0, e1, n1, factor) => {
    if (P.ver === '1.0.0') {   // 1.0.0 asks for a box and a pixel size directly
      const cell = (cov.native || 1) / (factor || 1), W = Math.max(2, Math.round((e1 - e0) / cell)), H = Math.max(2, Math.round((n1 - n0) / cell));
      return `${base}?service=WCS&version=1.0.0&request=GetCoverage&coverage=${encodeURIComponent(cov.id)}&crs=EPSG:27700&bbox=${Math.round(e0)},${Math.round(n0)},${Math.round(e1)},${Math.round(n1)}&width=${W}&height=${H}&format=GeoTIFF`;
    }
    return `${base}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${encodeURIComponent(cov.id)}&format=image/tiff` +
      `&subset=E(${Math.round(e0)},${Math.round(e1)})&subset=N(${Math.round(n0)},${Math.round(n1)})` + (factor && factor < 1 ? `&scaleFactor=${+factor.toFixed(4)}` : '');
  };
  return P;
}
// A Cloud Optimized GeoTIFF read in pieces (HTTP range requests) through the Runoff relay.
// Uses the file's own overviews for coarse requests, so a wide preview only reads a little.
const RELAY = '__RUNOFF_RELAY__';
function cogProvider(key, name, url, attrib) {
  const P = { key, name, attrib, tiff: null };
  // open lazily: the file's index is big, so only parse the layers actually needed
  P.open = async () => {
    if (!RELAY) throw new Error(`${name} lidar needs the Runoff relay, which this copy doesn’t have set up yet. It’s coming soon.`);
    if (P.tiff) return P.tiff;
    try { P.tiff = await GeoTIFF.fromUrl(viaRelay(url), { allowFullFile: false, blockSize: 524288 }); }
    catch (e) { throw new Error(`Couldn’t reach the ${name} lidar through the relay.`); }
    const base = await P.tiff.getImage(0), [ox, oy] = base.getOrigin();
    P.levels = [{ im: base, res: Math.abs(base.getResolution()[0]) }];
    P.baseW = base.getWidth(); P.ox = ox; P.oy = oy;
    return P.tiff;
  };
  // walk the overviews (finest to coarsest) only as far as the requested cell size needs
  P.level = async cell => {
    let best = P.levels[0];
    for (let i = 1; ; i++) {
      if (!P.levels[i]) {
        let im; try { im = await P.tiff.getImage(i); } catch (e) { break; }
        P.levels[i] = { im, res: P.levels[0].res * P.baseW / im.getWidth() };
      }
      if (P.levels[i].res > cell * 1.01) break;
      best = P.levels[i];
    }
    return best;
  };
  P.candidates = async () => { await P.open(); return [{ id: 'wales-dtm-1m', rank: 0 }]; };
  P.nativeRes = async () => { await P.open(); return P.levels[0].res; };
  // read a box at roughly the requested cell size, as an in-memory GeoTIFF-like result
  P.read = async (e0, n0, e1, n1, cell) => {
    // pieces already read are kept in this browser, so reopening an area is instant
    const key = `${url}#${Math.round(e0)},${Math.round(n0)},${Math.round(e1)},${Math.round(n1)}@${+cell.toFixed(2)}`;
    const hit = await TileCache.get(key); if (hit) return hit;
    await P.open();
    const L = await P.level(cell);
    const x0 = Math.max(0, Math.floor((e0 - P.ox) / L.res)), x1 = Math.min(L.im.getWidth(), Math.ceil((e1 - P.ox) / L.res));
    const y0 = Math.max(0, Math.floor((P.oy - n1) / L.res)), y1 = Math.min(L.im.getHeight(), Math.ceil((P.oy - n0) / L.res));
    if (x1 <= x0 || y1 <= y0) throw new Error('outside Wales');
    const ras = await L.im.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
    const z = ras instanceof Float32Array ? ras : Float32Array.from(ras);
    const out = { w: x1 - x0, h: y1 - y0, z, cell: L.res, nodata: L.im.getGDALNoData ? L.im.getGDALNoData() : null,
      ox: P.ox + x0 * L.res, oy: P.oy - y0 * L.res, geo: true, spp: 1, bits: 32 };
    TileCache.put(key, out);
    return out;
  };
  return P;
}

const PROVIDERS = {
  england: {
    key: 'england', name: 'Environment Agency', attrib: 'Lidar © Environment Agency, OGL',
    candidates: async () => [{ id: 'ea', rank: 0 }],
    nativeRes: async () => 1,
    url: null // England keeps its own tried-and-tested requests (1 m and 2 m datasets), see providerUrl
  },
  wales: cogProvider('wales', 'Welsh Government', 'https://dmwproductionblob.blob.core.windows.net/cogs/lidar/wales_dtm_32bit_cog.tif', 'Lidar © Welsh Government, OGL'),
  walesWcs: geoserverProvider('wales', 'Welsh Government', 'https://datamap.gov.wales/geoserver/ows', 'Lidar © Welsh Government, OGL',
    t => /dtm|terrain|elevation|height|lidar|dem\b/i.test(t) && !/hillshade|pseudo|shade|dsm|surface|aspect|slope|tile|catalogue|index/i.test(t),
    t => (/dtm|terrain/i.test(t) ? 20 : 0) + (/2020|2021|2022|2023/.test(t) ? 10 : 0) + (/32 ?bit/i.test(t) ? 2 : 0) + (/1 ?m\b/i.test(t) ? 1 : 0)),
  scotland: { key: 'scotland', name: 'Scottish Government', attrib: 'Lidar © Scottish Government, OGL',
    candidates: async () => { throw new Error('Scottish lidar isn’t available in Runoff yet, but it’s on the way. You can still open a Scottish DTM file you’ve downloaded.'); } },
  scotlandWcs: geoserverProvider('scotland', 'Scottish Government', 'https://ows.remotesensing.data.gov.scot/geoserver/ows', 'Lidar © Scottish Government, OGL',
    t => /dtm|terrain/i.test(t) && !/dsm|surface|hillshade/i.test(t),
    // newest survey first: the national programme from 2025, then phases 6 down to 1, then others
    id => (/land-lidar|programme|202[5-9]/i.test(id) ? 100 : 0) + ((id.match(/lidar-(\d)/) || [])[1] ? +id.match(/lidar-(\d)/)[1] * 10 : 0))
};
// rough national borders in grid metres: good to a few km, and the fallback chain covers the rest
const lerpLine = (pts, x) => { for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [a, b] = [pts[i - 1], pts[i]]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); } return pts[pts.length - 1][1]; };
function countryAt(e, n) {
  // England/Scotland border, Solway to Berwick, as northing by easting
  const scot = [[300000, 560000], [318000, 566000], [340000, 567000], [355000, 580000], [370000, 605000], [382000, 611000], [390000, 628000], [395000, 650000], [400000, 657000], [700000, 657000]];
  if (n > (e < 300000 ? 555000 : lerpLine(scot, e))) return 'Scotland';
  // England/Wales border, Chepstow to the Dee, as easting by northing
  const wal = [[168000, 355000], [190000, 354500], [216000, 354000], [228000, 336000], [242000, 324000], [256000, 326000], [270000, 320000], [300000, 325000], [315000, 328000], [330000, 326000], [345000, 333000], [365000, 334000], [395000, 330000]];
  if (n >= 168000 && n <= 395000 && e < lerpLine(wal, n)) return 'Wales';
  return 'England';
}
// the spot's own country first; a neighbour's service only when within about 15 km of that border
const KEY = c => { c = String(c || '').toLowerCase(); return c.includes('scot') ? 'scotland' : c.includes('wal') ? 'wales' : 'england'; };
const providerOrder = (country, e, n) => {
  const first = KEY(country || (e ? countryAt(e, n) : ''));
  if (!e) return [first, ...['england', 'wales', 'scotland'].filter(k => k !== first)];
  const near = new Set([first]);
  for (let a = 0; a < 8; a++) near.add(KEY(countryAt(e + 15000 * Math.cos(a * Math.PI / 4), n + 15000 * Math.sin(a * Math.PI / 4))));
  return [...near];
};
async function providerUrl(P, cov, e0, n0, e1, n1, res, factor) {
  if (P.key === 'england') { const id = await eaCoverageId(res); return eaCoverageUrl(res, id, e0, n0, e1, n1, factor); }
  return P.url(cov, e0, n0, e1, n1, factor);
}
// fetch a box from the first provider/survey that actually has data there
async function fetchLidar(order, e0, n0, e1, n1, want, onProgress, overview) {
  const why = {};
  for (const key of order) {
    const P = PROVIDERS[key];
    let cands; try { cands = await P.candidates((e0 + e1) / 2, (n0 + n1) / 2); } catch (err) { if (/coming soon|on the way/.test(err.message) && key === order[0]) throw err; why[P.name] = err.message; continue; }
    console.info(`Runoff: ${P.name} layers covering this spot:`, cands.map(c => c.id));
    if (!cands.length) { why[P.name] = 'no survey covers this spot'; continue; }
    for (const cov of cands) {
      try {
        const native = P.key === 'england' ? (overview ? 2 : want.res) : await P.nativeRes(cov.id);
        const factor = overview ? Math.min(1, 800 / ((e1 - e0) / native)) : Math.min(1, native / want.res);
        cov.native = native;
        if (overview && P.noShrink && factor < 1) throw new Error('no shrink');
        const d = P.read ? await P.read(e0, n0, e1, n1, overview ? (e1 - e0) / 800 : Math.max(native, want.res))
          : await parseTIFF(await eaFetchTiff(await providerUrl(P, cov, e0, n0, e1, n1, want.res, factor), onProgress));
        if (d.spp > 1 || d.bits <= 8) { why[P.name] = `${cov.id}: an image, not heights`; continue; }
        let valid = 0, lo = Infinity, hi = -Infinity, seen = 0;
        for (let i = 0; i < d.z.length; i += 7) { seen++; const v = d.z[i]; if (v === v && v > -1000 && v !== d.nodata) { valid++; if (v < lo) lo = v; if (v > hi) hi = v; } }
        // mostly missing, or dead flat (a sheet of zeros), means this survey has nothing here: try the next
        if (valid < 0.3 * seen) { why[P.name] = `${cov.id}: no data here`; continue; }
        if (hi - lo < 0.05) { why[P.name] = `${cov.id}: came back flat`; continue; }
        return { d, P, cov };
      } catch (err) { why[P.name] = `${cov.id === 'ea' ? '' : cov.id + ': '}${err.message}`; if (overview) P.noShrink = true; }
    }
  }
  throw new Error('No usable lidar here. ' + Object.entries(why).map(([k, v]) => `${k}: ${v}`).join(' · '));
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
          if (j2.result && j2.result.eastings) out.push({ name: `${j2.result.postcode}, ${j2.result.admin_district || ''}`.replace(/, $/, ''), e: j2.result.eastings, n: j2.result.northings, country: j2.result.country }); } catch (e) {}
        continue;
      }
      const e = row.eastings, n = row.northings;
      if (!e || !n) continue;
      const name = [row.name_1 || row.postcode, row.county_unitary || row.admin_district || row.region].filter(Boolean).join(', ');
      if (seen.has(name)) continue; seen.add(name);
      out.push({ name, e, n, country: row.country });
    }
    if (out.length >= 5) break;
  }
  return out.slice(0, 8);
}

/* ---------- the two stages ---------- */
async function eaLoadOverview(e, n, name, sizeM, country) {
  const want = sizeM || +$('#eaSize').value || 4000, order = providerOrder(country, e, n);
  setInfo(`Fetching an overview around ${name}…`); setLogo('loading', 0.02);
  try {
    let got = null, S = want;
    for (const size of [want, 2000]) {
      S = size; const e0 = Math.round(e - size / 2), n0 = Math.round(n - size / 2);
      try { got = await fetchLidar(order, e0, n0, e0 + size, n0 + size, { res: 2 }, p => setLogo('loading', 0.05 + p * 0.85), size !== 2000); break; }
      catch (err) { if (size === 2000) throw err; setInfo(`The service turned down a ${size / 1000} km view, trying 2 km…`); }
    }
    const e0 = Math.round(e - S / 2), n0 = Math.round(n - S / 2), d = got.d;
    d.remote = { e: e0 + S / 2, n: n0 + S / 2, size: S, place: name, provider: got.P.key, country };
    finishDEM(d, `Lidar around ${name}`);
    const layer = got.cov.id === 'ea' ? '' : ` (${got.cov.id})`;
    setInfo(`${name}: ${(S / 1000)} km overview at about ${+(dem.cell).toFixed(1)} m from the ${got.P.name}${layer}. Drag a box, then press “Simulate this area” to download that part at full detail.`);
    setLogo('calm');
    await loadMapFor(dem, () => { buildOverview(); if (mode === 'select') drawOverview(); });
    return true;
  } catch (err) { setInfo(err.message || String(err), true); setLogo(dem ? 'calm' : 'idle'); return false; }
}

// called when the user presses Simulate on an overview: fetch just that box at full resolution
async function eaLoadDetail() {
  const e0 = dem.ox + sel.x0 * dem.cell, e1 = dem.ox + sel.x1 * dem.cell;
  const n1 = dem.oy - sel.y0 * dem.cell, n0 = dem.oy - sel.y1 * dem.cell;
  const wM = e1 - e0, hM = n1 - n0;
  if (Math.max(wM, hM) > EA.maxFineM) { setInfo(`That box is ${(Math.max(wM, hM) / 1000).toFixed(1)} km across. Pick one up to ${EA.maxFineM / 1000} km for a full-detail download.`, true); return; }
  const res = wM * hM > EA.fineAt1mM2 ? 2 : 1;
  const parent = dem, wantM = +$('#cellsize').value || res;
  const order = [parent.remote.provider, ...providerOrder(parent.remote.country, (e0 + e1) / 2, (n0 + n1) / 2)].filter((k, i, a) => a.indexOf(k) === i);
  setInfo(`Downloading ${(wM / 1000).toFixed(2)} × ${(hM / 1000).toFixed(2)} km at ${res} m…`);
  const btn = $('#go'); busyBtn(btn, 'Downloading');
  const slow = setTimeout(() => busyBtn(btn, 'May take a second'), 3000);
  setLogo('loading', 0.02);
  try {
    const { d, P } = await fetchLidar(order, e0, n0, e1, n1, { res }, p => setLogo('loading', 0.05 + p * 0.85), false);
    clearTimeout(slow); busyBtn(btn, 'Simulating');
    await new Promise(r => setTimeout(r, 40));   // let the label show before the heavy lifting
    d.parent = parent;
    d.ea = { e0: Math.round(e0), n0: Math.round(n0), e1: Math.round(e1), n1: Math.round(n1), res, place: parent.remote.place, provider: P.key };
    finishDEM(d, `${parent.remote.place} at ${res} m`);
    loadMapFor(dem, () => { buildOverview(); if (mode === 'select') drawOverview(); });
    setLogo('calm');
    setInfo(`${parent.remote.place}: ${dem.w} × ${dem.h} cells at ${res} m.`);
    const k = Math.max(1, Math.round(wantM / dem.cell));
    if ([...$('#cellsize').options].some(o => +o.value === k)) $('#cellsize').value = k;
    $('#go').click();
    busyBtn(btn, null);
  } catch (err) { clearTimeout(slow); busyBtn(btn, null); setInfo(err.message || String(err), true); setLogo('calm'); }
}

// re-download (or pull from the cache) the exact box a saved scenario was built on
async function eaLoadBox(ea) {
  setInfo(`Fetching the lidar for ${ea.place}…`); setLogo('loading', 0.02);
  const order = [ea.provider || 'england', ...providerOrder(null, (ea.e0 + ea.e1) / 2, (ea.n0 + ea.n1) / 2)].filter((k, i, a) => a.indexOf(k) === i);
  const { d } = await fetchLidar(order, ea.e0, ea.n0, ea.e1, ea.n1, { res: ea.res }, p => setLogo('loading', 0.05 + p * 0.85), false);
  d.ea = { ...ea };
  finishDEM(d, `${ea.place} at ${ea.res} m`); setLogo('calm');
  setInfo(`${ea.place}: ${dem.w} × ${dem.h} cells at ${ea.res} m.`);
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
      const slow = setTimeout(() => busyBtn(btn, 'May take a second'), 3000);
      const ok = await eaLoadOverview(r.e, r.n, r.name, 0, r.country);
      clearTimeout(slow); busyBtn(btn, null); if (!ok) return;
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
  } catch (err) { if (err.message !== 'no key') console.warn('Runoff: backdrop map unavailable:', err.message); }
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
