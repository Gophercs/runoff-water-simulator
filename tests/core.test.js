// Physics checks for the reference engine. Run with: node tests/core.test.js
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'sim_core.js'), 'utf8');
const { createSim, step, stored } = new Function(src + '\nreturn { createSim, step, stored };')();

let failed = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; }
const balance = S => { const V = S.vol, inn = V.rain + V.added + V.source; return (inn - stored(S) - V.drained - V.infil) / inn; };

{ // 1. a dollop in a bowl settles dead flat and conserves water
  const w = 60, h = 60, z = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) z[y * w + x] = 0.002 * ((x - 30) ** 2 + (y - 30) ** 2);
  const S = createSim(z, w, h, 1);
  for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) S.d[y * w + x] = 2;
  S.vol.added = 50;
  while (S.t < 3000) step(S);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < w * h; i++) if (S.d[i] > 0.05) { lo = Math.min(lo, z[i] + S.d[i]); hi = Math.max(hi, z[i] + S.d[i]); }
  check('pool settles flat', hi - lo < 1e-4, `surface range ${(hi - lo).toExponential(1)} m`);
  check('pool conserves water', Math.abs(balance(S)) < 1e-12, `error ${balance(S).toExponential(1)}`);
}
{ // 2. rain on a uniform slope reaches the Manning normal depth
  const w = 4, h = 200, slope = 0.01, n = 0.035, rain = 50 / 1000 / 3600, z = new Float64Array(w * h), sink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) z[y * w + x] = (h - y) * slope;
  for (let x = 0; x < w; x++) sink[(h - 1) * w + x] = 1;
  const S = createSim(z, w, h, 1, sink); S.n2.fill(n * n); S.rain = rain;
  while (S.t < 3 * 3600) step(S);
  for (const L of [50, 100, 150]) {
    const model = S.d[L * w + 1], manning = Math.pow(rain * L * n / Math.sqrt(slope), 0.6), err = (model - manning) / manning;
    check(`Manning depth at ${L} m`, Math.abs(err) < 0.03, `${(model * 1000).toFixed(2)} mm vs ${(manning * 1000).toFixed(2)} mm (${(err * 100).toFixed(1)}%)`);
  }
}
{ // 3. a dam holds until the pond reaches its crest, then spills
  const w = 200, h = 120, z = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) z[y * w + x] = (w - x) * 0.01 + Math.abs(y - 60) * 0.05;
  for (let y = 0; y < h; y++) { const i = y * w + 110; z[i] = Math.max(z[i], 2.4); }
  const sink = new Uint8Array(w * h); for (let y = 0; y < h; y++) sink[y * w + w - 1] = 1;
  const S = createSim(z, w, h, 1, sink); S.n2.fill(0.0025); S.sources.push({ i: 60 * w + 20, Q: 0.6 });
  let heldDry = true;
  while (S.t < 1800) { step(S); for (let x = 112; x < w; x++) if (S.d[60 * w + x] > 1e-9) heldDry = false; }
  check('dam holds below its crest', heldDry && S.vol.drained === 0, `pond at ${(z[60 * w + 100] + S.d[60 * w + 100]).toFixed(2)} m, crest 2.40 m`);
  while (S.t < 5400) step(S);
  const pond = z[60 * w + 100] + S.d[60 * w + 100];
  check('dam spills at its crest', S.vol.drained > 0 && pond > 2.4 && pond < 2.5, `pond ${pond.toFixed(3)} m, drained ${S.vol.drained.toFixed(0)} m³`);
}
{ // 4. a culvert equalises two basins and conserves water
  const w = 60, h = 20, z = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) z[y * w + x] = (x === 30 ? 3 : 0) + ((x === 0 || x === w - 1 || y === 0 || y === h - 1) ? 5 : 0);
  const S = createSim(z, w, h, 1); S.n2.fill(0.0009);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < 30; x++) S.d[y * w + x] = 2;
  const v0 = stored(S); S.vol.added = v0;
  S.culverts.push({ a: 10 * w + 29, b: 10 * w + 31, D: 0.6, Q: 0 });
  while (S.t < 4000) step(S);
  const L = S.d[10 * w + 15], Rt = S.d[10 * w + 45];
  check('culvert equalises levels', Math.abs(L - Rt) < 1e-3, `left ${L.toFixed(3)} m, right ${Rt.toFixed(3)} m`);
  check('culvert conserves water', Math.abs(balance(S)) < 1e-12, `error ${balance(S).toExponential(1)}`);
}
{ // 5. Green-Ampt: loam under 30 mm/hr starts ponding when the textbook says
  const w = 20, h = 20, S = createSim(new Float64Array(w * h), w, h, 1);
  const Ks = 3.4 / 3.6e6, P = 0.0889 * 0.434 * 0.5, r = 30 / 3.6e6;
  S.Ks.fill(Ks); S.P.fill(P); S.rain = r;
  const tp = Ks * P / (r - Ks) / r; // time to ponding for constant rain
  let tPond = null; const i0 = 10 * w + 10;
  while (S.t < 1800) { step(S); if (tPond === null && S.d[i0] > 1e-9) tPond = S.t; } // first water left standing
  check('Green-Ampt ponding time', Math.abs(tPond - tp) / tp < 0.05, `model ${(tPond / 60).toFixed(1)} min, formula ${(tp / 60).toFixed(1)} min`);
  check('Green-Ampt conserves water', Math.abs(balance(S)) < 1e-12, `error ${balance(S).toExponential(1)}`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
