// Local inertial shallow-water solver (Bates, Horritt & Fewtrell 2010)
// Grid of w*h cells, cell size dx metres.
// z: ground elevation (m), h: water depth (m)
// qx[i]: flow per metre width from cell i to i+1 (m2/s)
// qy[i]: flow per metre width from cell i to i+w (m2/s)
function createSim(z, w, h, dx, sinkMask) {
  const N = w * h;
  const S = {
    w, h, dx, z,
    d: new Float64Array(N),
    qx: new Float64Array(N),
    qy: new Float64Array(N),
    qx0: new Float64Array(N),
    qy0: new Float64Array(N),
    theta: 0.7,           // de Almeida 2012 weighting (1 = original Bates)
    scale: new Float64Array(N),
    sink: sinkMask || new Uint8Array(N),
    n2: new Float64Array(N).fill(0.035 * 0.035), // Manning's n squared, per cell
    Ks: new Float64Array(N),  // soil conductivity per cell, m/s (0 = nothing soaks in)
    P: new Float64Array(N),   // Green-Ampt suction x moisture deficit per cell, m (0 = steady rate)
    rain: 0,              // m/s
    F: new Float64Array(N), // cumulative infiltration per cell, m
    alpha: 0.5,           // CFL safety factor
    dtMax: 2.0,           // s
    minDepth: 1e-4,       // m: below this a face carries no flow
    sources: [],          // {i, Q} Q in m3/s
    culverts: [],         // {a, b, D} inlet/outlet cells, pipe diameter m
    t: 0,
    vol: { rain: 0, added: 0, source: 0, drained: 0, infil: 0 },
    lastDt: 0,
    maxDepth: 0,
  };
  return S;
}

function stored(S) {
  let v = 0; const A = S.dx * S.dx;
  for (let i = 0; i < S.d.length; i++) v += S.d[i];
  return v * A;
}

function step(S) {
  const { w, h, dx, z, d, qx, qy, scale, sink } = S;
  const N = w * h, g = 9.81, A = dx * dx;
  const n2 = S.n2;

  // adaptive timestep from deepest water
  let hmax = 0;
  for (let i = 0; i < N; i++) if (d[i] > hmax) hmax = d[i];
  S.maxDepth = hmax;
  let dt = hmax > 1e-6 ? S.alpha * dx / Math.sqrt(g * hmax) : S.dtMax;
  if (dt > S.dtMax) dt = S.dtMax;

  // momentum: update face flows (de Almeida et al. 2012 theta scheme)
  const qx0 = S.qx0, qy0 = S.qy0, th = S.theta, th2 = (1 - S.theta) / 2;
  qx0.set(qx); qy0.set(qy);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const ei = z[i] + d[i];
      if (x < w - 1) {
        const j = i + 1, ej = z[j] + d[j];
        const hf = Math.max(ei, ej) - Math.max(z[i], z[j]);
        if (hf > S.minDepth) {
          const q = qx0[i];
          const qa = (x > 0 ? qx0[i - 1] : q), qb = (x < w - 2 ? qx0[i + 1] : q);
          qx[i] = (th * q + th2 * (qa + qb) - g * hf * dt * (ej - ei) / dx) /
                  (1 + g * dt * 0.5 * (n2[i] + n2[j]) * Math.abs(q) / (hf * hf * Math.cbrt(hf)));
        } else qx[i] = 0;
      }
      if (y < h - 1) {
        const j = i + w, ej = z[j] + d[j];
        const hf = Math.max(ei, ej) - Math.max(z[i], z[j]);
        if (hf > S.minDepth) {
          const q = qy0[i];
          const qa = (y > 0 ? qy0[i - w] : q), qb = (y < h - 2 ? qy0[i + w] : q);
          qy[i] = (th * q + th2 * (qa + qb) - g * hf * dt * (ej - ei) / dx) /
                  (1 + g * dt * 0.5 * (n2[i] + n2[j]) * Math.abs(q) / (hf * hf * Math.cbrt(hf)));
        } else qy[i] = 0;
      }
    }
  }

  // positivity limiter: a cell can't send out more than it holds
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let out = 0;
      if (x < w - 1 && qx[i] > 0) out += qx[i];
      if (x > 0 && qx[i - 1] < 0) out -= qx[i - 1];
      if (y < h - 1 && qy[i] > 0) out += qy[i];
      if (y > 0 && qy[i - w] < 0) out -= qy[i - w];
      const outDepth = out * dt / dx;
      scale[i] = outDepth > d[i] && outDepth > 0 ? d[i] / outDepth : 1;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1) { const q = qx[i]; qx[i] = q * (q > 0 ? scale[i] : scale[i + 1]); }
      if (y < h - 1) { const q = qy[i]; qy[i] = q * (q > 0 ? scale[i] : scale[i + w]); }
    }
  }

  // continuity
  const k = dt / dx;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let net = 0;
      if (x < w - 1) net -= qx[i];
      if (x > 0) net += qx[i - 1];
      if (y < h - 1) net -= qy[i];
      if (y > 0) net += qy[i - w];
      let v = d[i] + k * net;
      if (v < 0) v = 0; // only round-off after limiter
      d[i] = v;
    }
  }

  // rain, sources, infiltration, sinks
  if (S.rain > 0) {
    const r = S.rain * dt;
    for (let i = 0; i < N; i++) if (!sink[i]) d[i] += r;
    let wet = 0; for (let i = 0; i < N; i++) if (!sink[i]) wet++;
    S.vol.rain += r * wet * A;
  }
  for (const s of S.sources) { d[s.i] += s.Q * dt / A; S.vol.source += s.Q * dt; }

  // culverts: inlet-controlled orifice flow, Q = Cd * A_wet * sqrt(2 g dh)
  for (const c of S.culverts) {
    let from = c.a, to = c.b;
    let dh = (z[from] + d[from]) - (z[to] + d[to]);
    if (dh < 0) { from = c.b; to = c.a; dh = -dh; }
    const din = d[from];
    if (din <= S.minDepth || dh <= 0) { c.Q = 0; continue; }
    const Apipe = Math.PI * c.D * c.D / 4;
    const wet = din < c.D ? din / c.D : 1;          // partly-submerged inlet
    let vol = 0.6 * Apipe * wet * Math.sqrt(2 * g * dh) * dt;
    const maxV = Math.min(din, dh / 2) * A;         // can't empty inlet or overshoot level
    if (vol > maxV) vol = maxV;
    d[from] -= vol / A; d[to] += vol / A;
    c.Q = (from === c.a ? 1 : -1) * vol / dt;
  }
  // Green-Ampt per cell: f = Ks (1 + P / F). P = 0 gives a steady rate; Ks = 0 means nothing soaks in.
  { const Ks = S.Ks, P = S.P, F = S.F; let tot = 0;
    for (let i = 0; i < N; i++) {
      const di = d[i], k = Ks[i]; if (di <= 0 || k <= 0 || sink[i]) continue;
      const Fi = F[i] > 1e-3 ? F[i] : 1e-3;
      let a = k * (1 + P[i] / Fi) * dt; if (a > di) a = di;
      d[i] = di - a; F[i] += a; tot += a;
    }
    S.vol.infil += tot * A; }
  let dr = 0;
  for (let i = 0; i < N; i++) if (sink[i] && d[i] > 0) { dr += d[i]; d[i] = 0; }
  S.vol.drained += dr * A;

  S.t += dt; S.lastDt = dt;
  return dt;
}

