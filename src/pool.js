// Multi-core CPU engine. The grid is cut into horizontal strips, one per worker. Each strip keeps G ghost
// rows from its neighbours (one step's reach), and neighbours swap edge rows directly after every step.
// Worker 0 coordinates the global step length and culverts. Same arithmetic, same order as the core.
const POOL_G = 3;

function runoffWorker() {
  let W = null, stepNo = 0, cNo = 0, xNo = 0;
  const box = new Map();
  function deliver(m) { const e = box.get(m.k); if (e && e.res) { box.delete(m.k); e.res(m); } else box.set(m.k, { m }); }
  function waitFor(k) { const e = box.get(k); if (e && e.m) { box.delete(k); return Promise.resolve(e.m); } return new Promise(res => box.set(k, { res })); }
  const listen = p => { if (p) p.onmessage = e => deliver(e.data); };

  self.onmessage = e => {
    const m = e.data;
    if (m.k === 'ping') postMessage({ k: 'pong' });
    else if (m.k === 'init') init(m);
    else if (m.k === 'run') run(m).then(r => postMessage(r.msg, r.tr), err => postMessage({ k: 'err', index: W && W.index, msg: String(err && err.message || err) }));
  };

  function init(m) {
    const { w, h, G, r0, r1, l0, l1, index, count } = m, lh = l1 - l0, N = w * lh;
    W = { w, h, G, r0, r1, l0, l1, lh, N, index, count, z: m.z, d: m.d, qx: m.qx, qy: m.qy, F: m.F, sink: m.sink, n2: m.n2, Ks: m.Ks, Pc: m.P,
      qx0: new Float64Array(N), qy0: new Float64Array(N), sc: new Float64Array(N),
      up: m.up || null, down: m.down || null, hub: m.hub || null, spokes: m.spokes || [] };
    box.clear(); stepNo = 0; cNo = 0; xNo = 0;
    listen(W.up); listen(W.down); listen(W.hub); W.spokes.forEach(listen);
    let wet = 0; for (let i = (r0 - l0) * w; i < (r1 - l0) * w; i++) if (!W.sink[i]) wet++;
    W.wet = wet;
  }

  function ownedHmax() {
    let hm = 0; const d = W.d, e = (W.r1 - W.l0) * W.w;
    for (let i = (W.r0 - W.l0) * W.w; i < e; i++) if (d[i] > hm) hm = d[i];
    return hm;
  }

  async function syncDt(hm) {
    const key = stepNo++, P = W.P;
    if (W.index === 0) {
      let mx = hm;
      for (let j = 1; j < W.count; j++) { const r = await waitFor('h' + key + '_' + j); if (r.hm > mx) mx = r.hm; }
      let dt = mx > 1e-6 ? P.alpha * P.dx / Math.sqrt(9.81 * mx) : P.dtMax;
      if (dt > P.dtMax) dt = P.dtMax;
      for (let j = 1; j < W.count; j++) W.spokes[j].postMessage({ k: 'dt' + key, dt });
      return dt;
    }
    W.hub.postMessage({ k: 'h' + key + '_' + W.index, hm });
    return (await waitFor('dt' + key)).dt;
  }

  function physics(dt) {
    const { w, lh, z, d, qx, qy, qx0, qy0, sc, sink, P, n2 } = W, g = 9.81, th = P.theta, th2 = (1 - P.theta) / 2, dx = P.dx;
    qx0.set(qx); qy0.set(qy);
    for (let y = 0; y < lh; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x, ei = z[i] + d[i];
        if (x < w - 1) {
          const j = i + 1, ej = z[j] + d[j];
          const hf = Math.max(ei, ej) - Math.max(z[i], z[j]);
          if (hf > P.minD) {
            const q = qx0[i];
            const qa = (x > 0 ? qx0[i - 1] : q), qb = (x < w - 2 ? qx0[i + 1] : q);
            qx[i] = (th * q + th2 * (qa + qb) - g * hf * dt * (ej - ei) / dx) / (1 + g * dt * 0.5 * (n2[i] + n2[j]) * Math.abs(q) / (hf * hf * Math.cbrt(hf)));
          } else qx[i] = 0;
        }
        if (y < lh - 1) {
          const j = i + w, ej = z[j] + d[j];
          const hf = Math.max(ei, ej) - Math.max(z[i], z[j]);
          if (hf > P.minD) {
            const q = qy0[i];
            const qa = (y > 0 ? qy0[i - w] : q), qb = (y < lh - 2 ? qy0[i + w] : q);
            qy[i] = (th * q + th2 * (qa + qb) - g * hf * dt * (ej - ei) / dx) / (1 + g * dt * 0.5 * (n2[i] + n2[j]) * Math.abs(q) / (hf * hf * Math.cbrt(hf)));
          } else qy[i] = 0;
        }
      }
    }
    for (let y = 0; y < lh; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let out = 0;
      if (x < w - 1 && qx[i] > 0) out += qx[i];
      if (x > 0 && qx[i - 1] < 0) out -= qx[i - 1];
      if (y < lh - 1 && qy[i] > 0) out += qy[i];
      if (y > 0 && qy[i - w] < 0) out -= qy[i - w];
      const od = out * dt / dx;
      sc[i] = od > d[i] && od > 0 ? d[i] / od : 1;
    }
    for (let y = 0; y < lh; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1) { const q = qx[i]; qx[i] = q * (q > 0 ? sc[i] : sc[i + 1]); }
      if (y < lh - 1) { const q = qy[i]; qy[i] = q * (q > 0 ? sc[i] : sc[i + w]); }
    }
    const k = dt / dx;
    for (let y = 0; y < lh; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let net = 0;
      if (x < w - 1) net -= qx[i];
      if (x > 0) net += qx[i - 1];
      if (y < lh - 1) net -= qy[i];
      if (y > 0) net += qy[i - w];
      let v = d[i] + k * net; if (v < 0) v = 0;
      d[i] = v;
    }
    if (P.rain > 0) { const r = P.rain * dt; for (let i = 0; i < W.N; i++) if (!sink[i]) d[i] += r; }
  }

  function soak(dt) {
    const { d, F, sink, N, Ks, Pc } = W, o0 = (W.r0 - W.l0) * W.w, o1 = (W.r1 - W.l0) * W.w;
    let inf = 0, dr = 0;
    for (let i = 0; i < N; i++) {
      const di = d[i], k = Ks[i]; if (di <= 0 || k <= 0 || sink[i]) continue;
      const Fi = F[i] > 1e-3 ? F[i] : 1e-3;
      let a = k * (1 + Pc[i] / Fi) * dt; if (a > di) a = di;
      d[i] = di - a; F[i] += a; if (i >= o0 && i < o1) inf += a;
    }
    for (let i = 0; i < N; i++) if (sink[i] && d[i] > 0) { if (i >= o0 && i < o1) dr += d[i]; d[i] = 0; }
    return [inf, dr];
  }

  async function culvertSync(culs, dt) {
    const key = cNo++, { w } = W;
    const own = gi => { const y = Math.floor(gi / w); return y >= W.r0 && y < W.r1; };
    const mine = [];
    for (const c of culs) for (const gi of [c.a, c.b]) if (own(gi)) { const li = gi - W.l0 * w; mine.push([gi, W.d[li], W.z[li]]); }
    let res;
    if (W.index === 0) {
      const vals = new Map(); for (const [gi, dv, zv] of mine) vals.set(gi, [dv, zv]);
      for (let j = 1; j < W.count; j++) { const r = await waitFor('c' + key + '_' + j); for (const [gi, dv, zv] of r.v) vals.set(gi, [dv, zv]); }
      const P = W.P, A = P.dx * P.dx, Q = [], delta = new Map();
      for (const c of culs) {
        let from = c.a, to = c.b;
        let dh = (vals.get(from)[1] + vals.get(from)[0]) - (vals.get(to)[1] + vals.get(to)[0]);
        if (dh < 0) { from = c.b; to = c.a; dh = -dh; }
        const din = vals.get(from)[0];
        if (din <= P.minD || dh <= 0) { Q.push(0); continue; }
        const Ap = Math.PI * c.D * c.D / 4, wet = din < c.D ? din / c.D : 1;
        let vol = 0.6 * Ap * wet * Math.sqrt(2 * 9.81 * dh) * dt;
        const maxV = Math.min(din, dh / 2) * A; if (vol > maxV) vol = maxV;
        vals.get(from)[0] -= vol / A; vals.get(to)[0] += vol / A;
        delta.set(from, (delta.get(from) || 0) - vol / A); delta.set(to, (delta.get(to) || 0) + vol / A);
        Q.push((from === c.a ? 1 : -1) * vol / dt);
      }
      res = { k: 'cr' + key, delta: [...delta], Q };
      for (let j = 1; j < W.count; j++) W.spokes[j].postMessage(res);
    } else {
      W.hub.postMessage({ k: 'c' + key + '_' + W.index, v: mine });
      res = await waitFor('cr' + key);
    }
    for (const [gi, dv] of res.delta) if (own(gi)) W.d[gi - W.l0 * w] += dv;
    return res.Q;
  }

  async function exchange() {
    const key = xNo++, { w, G } = W, n = G * w;
    const pack = gy0 => { const o = (gy0 - W.l0) * w, b = new Float64Array(3 * n);
      b.set(W.d.subarray(o, o + n), 0); b.set(W.qx.subarray(o, o + n), n); b.set(W.qy.subarray(o, o + n), 2 * n); return b; };
    const unpack = (b, gy0) => { const o = (gy0 - W.l0) * w;
      W.d.set(b.subarray(0, n), o); W.qx.set(b.subarray(n, 2 * n), o); W.qy.set(b.subarray(2 * n), o); };
    if (W.up) W.up.postMessage({ k: 'xd' + key, b: pack(W.r0) });
    if (W.down) W.down.postMessage({ k: 'xu' + key, b: pack(W.r1 - G) });
    if (W.up) unpack((await waitFor('xu' + key)).b, W.r0 - G);
    if (W.down) unpack((await waitFor('xd' + key)).b, W.r1);
  }

  async function run(m) {
    W.P = m.par;
    const A = m.par.dx * m.par.dx, w = W.w;
    const srcs = [];
    for (const s of m.sources) { const y = Math.floor(s.i / w); if (y >= W.r0 && y < W.r1) srcs.push([s.i - W.l0 * w, s.Q]); }
    const culs = m.culverts;
    let inf = 0, dr = 0, dtSum = 0, lastDt = 0, culQ = culs.map(() => 0);
    let dt = await syncDt(ownedHmax());
    for (let k = 0; k < m.n; k++) {
      physics(dt);
      for (const [li, Q] of srcs) W.d[li] += Q * dt / A;
      if (culs.length) culQ = await culvertSync(culs, dt);
      const [a, b] = soak(dt); inf += a; dr += b;
      await exchange();
      dtSum += dt; lastDt = dt;
      if (k < m.n - 1) dt = await syncDt(ownedHmax());
    }
    const o0 = (W.r0 - W.l0) * w, o1 = (W.r1 - W.l0) * w;
    const d = W.d.slice(o0, o1), qx = W.qx.slice(o0, o1), qy = W.qy.slice(o0, o1), F = W.F.slice(o0, o1);
    return { msg: { k: 'done', index: W.index, d, qx, qy, F, inf, dr, dtSum, lastDt, culQ, wet: W.wet }, tr: [d.buffer, qx.buffer, qy.buffer, F.buffer] };
  }
}

async function createPoolEngine() {
  const hc = navigator.hardwareConcurrency || 1;
  if (hc < 2 || typeof Worker === 'undefined') return null;
  const want = Math.max(2, Math.min(8, Math.floor(hc / 2)));
  let url;
  try { url = URL.createObjectURL(new Blob(['(' + runoffWorker.toString() + ')()'], { type: 'text/javascript' })); } catch (e) { return null; }
  const ws = [];
  try { for (let k = 0; k < want; k++) ws.push(new Worker(url)); } catch (e) { ws.forEach(w => w.terminate()); return null; }
  const pong = w => new Promise(res => { w.onmessage = e => res(e.data && e.data.k === 'pong'); w.onerror = () => res(false); w.postMessage({ k: 'ping' }); });
  const ok = await Promise.race([Promise.all(ws.map(pong)).then(a => a.every(Boolean)), new Promise(r => setTimeout(() => r(false), 4000))]);
  if (!ok) { ws.forEach(w => w.terminate()); return null; }

  const eng = { kind: 'pool', threads: want, busy: false, lost: false, grid: null, lastMsPerStep: 2, targetMs: 30 };
  eng.fits = S => S && Math.floor(S.h / (POOL_G * 3)) >= 2;

  function init(S) {
    const G = POOL_G, w = S.w, h = S.h, m = Math.min(ws.length, Math.floor(h / (G * 3)));
    const strips = [];
    for (let j = 0; j < m; j++) {
      const r0 = Math.floor(j * h / m), r1 = Math.floor((j + 1) * h / m);
      strips.push({ r0, r1, l0: Math.max(0, r0 - G), l1: Math.min(h, r1 + G) });
    }
    const ports = strips.map(() => ({ spokes: [] }));
    for (let j = 0; j < m - 1; j++) { const ch = new MessageChannel(); ports[j].down = ch.port1; ports[j + 1].up = ch.port2; }
    for (let j = 1; j < m; j++) { const ch = new MessageChannel(); ports[0].spokes[j] = ch.port1; ports[j].hub = ch.port2; }
    strips.forEach((s, j) => {
      const a = s.l0 * w, b = s.l1 * w;
      const msg = { k: 'init', w, h, G, ...s, index: j, count: m,
        z: S.z.slice(a, b), d: S.d.slice(a, b), qx: S.qx.slice(a, b), qy: S.qy.slice(a, b), F: S.F.slice(a, b), sink: S.sink.slice(a, b),
        n2: S.n2.slice(a, b), Ks: S.Ks.slice(a, b), P: S.P.slice(a, b),
        up: ports[j].up, down: ports[j].down, hub: ports[j].hub, spokes: ports[j].spokes };
      const tr = [msg.z.buffer, msg.d.buffer, msg.qx.buffer, msg.qy.buffer, msg.F.buffer, msg.sink.buffer, msg.n2.buffer, msg.Ks.buffer, msg.P.buffer,
        ...[ports[j].up, ports[j].down, ports[j].hub].filter(Boolean), ...ports[j].spokes.filter(Boolean)];
      ws[j].postMessage(msg, tr);
    });
    eng.grid = { S, strips, m };
    S.dirty = false;
  }

  eng.run = async (S, n) => {
    if (!eng.grid || eng.grid.S !== S || S.dirty) init(S);
    const { strips, m } = eng.grid;
    n = Math.max(1, Math.min(4096, n | 0));
    const par = { dx: S.dx, theta: S.theta, alpha: S.alpha, dtMax: S.dtMax, minD: S.minDepth, rain: S.rain };
    const sources = S.sources.map(s => ({ i: s.i, Q: s.Q })), culverts = S.culverts.map(c => ({ a: c.a, b: c.b, D: c.D }));
    const t0 = performance.now();
    const results = await Promise.all(strips.map((s, j) => new Promise((res, rej) => {
      ws[j].onmessage = e => { if (e.data.k === 'done') res(e.data); else if (e.data.k === 'err') rej(new Error(e.data.msg)); };
      ws[j].onerror = ev => rej(new Error(ev.message || 'worker error'));
      ws[j].postMessage({ k: 'run', n, par, sources, culverts });
    })));
    const w = S.w, A = S.dx * S.dx;
    let inf = 0, dr = 0, wet = 0;
    results.forEach((r, j) => {
      const o = strips[j].r0 * w;
      S.d.set(r.d, o); S.qx.set(r.qx, o); S.qy.set(r.qy, o); S.F.set(r.F, o);
      inf += r.inf; dr += r.dr; wet += r.wet;
    });
    const hub = results[0], dtSum = hub.dtSum;
    let qSrc = 0; for (const s of S.sources) qSrc += s.Q;
    S.vol.rain += S.rain * dtSum * wet * A;
    S.vol.source += qSrc * dtSum;
    S.vol.infil += inf * A; S.vol.drained += dr * A;
    S.culverts.forEach((c, k) => { c.Q = hub.culQ[k] || 0; });
    S.t += dtSum; S.lastDt = hub.lastDt;
    eng.lastMsPerStep = 0.3 * eng.lastMsPerStep + 0.7 * (performance.now() - t0) / n;
    return n;
  };
  return eng;
}
