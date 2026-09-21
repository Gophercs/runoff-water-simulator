// WebGPU engine: same local inertial scheme as the CPU core, run as compute passes.
// The CPU sim object S stays the record: its arrays are uploaded when S.dirty is set, and every batch
// copies depth, flows and the water-balance tallies back into it.
const GPU_MAX_STEPS = 1024, GPU_MAX_SRC = 256, GPU_MAX_CUL = 256;

async function createGPUEngine() {
  if (!navigator.gpu) return null;
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) {}
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const info = adapter.info || {};
  const eng = { kind: 'gpu', device, busy: false, lost: false, label: [info.vendor, info.architecture].filter(Boolean).join(' ') || 'WebGPU', grid: null, lastMsPerStep: 0.5 };
  device.lost.then(() => { eng.lost = true; });

  const PARAMS = `struct P { w:u32, h:u32, n:u32, nsrc:u32, ncul:u32, gaOn:u32, pad0:u32, pad1:u32,
    dx:f32, g:f32, n2:f32, theta:f32, alpha:f32, dtMax:f32, minD:f32, rain:f32,
    infil:f32, Ks:f32, Pga:f32, A:f32 };`;
  const ST_ATOMIC = `struct St { hmax: atomic<u32>, count: atomic<u32>, dt: f32, pad: f32, log: array<f32, ${GPU_MAX_STEPS}> };`;
  const ST_PLAIN = `struct St { hmax: u32, count: u32, dt: f32, pad: f32, log: array<f32, ${GPU_MAX_STEPS}> };`;
  const DECL = {
    z: 'var<storage, read_write> z: array<f32>;', d: 'var<storage, read_write> d: array<f32>;',
    qxo: 'var<storage, read_write> qxo: array<f32>;', qyo: 'var<storage, read_write> qyo: array<f32>;',
    qxn: 'var<storage, read_write> qxn: array<f32>;', qyn: 'var<storage, read_write> qyn: array<f32>;',
    sc: 'var<storage, read_write> sc: array<f32>;', F: 'var<storage, read_write> F: array<f32>;',
    sink: 'var<storage, read_write> sink: array<u32>;', ai: 'var<storage, read_write> ai: array<f32>;',
    ad: 'var<storage, read_write> ad: array<f32>;', st: 'var<storage, read_write> st: St;',
    src: 'var<storage, read_write> src: array<Src>;', cul: 'var<storage, read_write> cul: array<Cul>;',
    n2: 'var<storage, read_write> n2: array<f32>;', Ks: 'var<storage, read_write> Ks: array<f32>;', Pg: 'var<storage, read_write> Pg: array<f32>;'
  };
  const pipes = {};
  function pipe(name, names, body, atomicSt) {
    const decl = names.map((n, k) => `@group(0) @binding(${k + 1}) ${DECL[n]}`).join('\n');
    const code = `${PARAMS}\n${atomicSt ? ST_ATOMIC : ST_PLAIN}\nstruct Src { i:u32, Q:f32 };\nstruct Cul { a:u32, b:u32, D:f32, Q:f32 };
@group(0) @binding(0) var<uniform> p: P;\n${decl}\n${body}`;
    const module = device.createShaderModule({ code });
    pipes[name] = { names, pipeline: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }) };
  }
  const CELL = `@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; if (i >= p.n) { return; } let x = i % p.w; let y = i / p.w;`;

  pipe('reduce', ['d', 'st'], `var<workgroup> wm: atomic<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wm, 0u); }
  workgroupBarrier();
  if (gid.x < p.n) { atomicMax(&wm, bitcast<u32>(max(d[gid.x], 0.0))); }
  workgroupBarrier();
  if (li == 0u) { atomicMax(&st.hmax, atomicLoad(&wm)); }
}`, true);

  pipe('dt', ['st'], `@compute @workgroup_size(1) fn main() {
  let hm = bitcast<f32>(atomicLoad(&st.hmax));
  var dt = p.dtMax;
  if (hm > 1e-6) { dt = min(p.alpha * p.dx / sqrt(p.g * hm), p.dtMax); }
  st.dt = dt;
  let c = atomicLoad(&st.count);
  if (c < ${GPU_MAX_STEPS}u) { st.log[c] = dt; }
  atomicStore(&st.count, c + 1u);
  atomicStore(&st.hmax, 0u);
}`, true);

  pipe('momentum', ['z', 'd', 'qxo', 'qyo', 'qxn', 'qyn', 'st', 'n2'], `
fn flux(q: f32, qa: f32, qb: f32, zi: f32, zj: f32, di: f32, dj: f32, dt: f32, nn: f32) -> f32 {
  let ei = zi + di; let ej = zj + dj;
  let hf = max(ei, ej) - max(zi, zj);
  if (hf <= p.minD) { return 0.0; }
  let num = p.theta * q + 0.5 * (1.0 - p.theta) * (qa + qb) - p.g * hf * dt * (ej - ei) / p.dx;
  return num / (1.0 + p.g * dt * nn * abs(q) / (hf * hf * pow(hf, 1.0 / 3.0)));
}
${CELL}
  let dt = st.dt;
  if (x < p.w - 1u) {
    let q = qxo[i];
    let qa = select(q, qxo[i - 1u], x > 0u); let qb = select(q, qxo[i + 1u], x + 2u < p.w);
    qxn[i] = flux(q, qa, qb, z[i], z[i + 1u], d[i], d[i + 1u], dt, 0.5 * (n2[i] + n2[i + 1u]));
  } else { qxn[i] = 0.0; }
  if (y < p.h - 1u) {
    let q = qyo[i];
    let qa = select(q, qyo[i - p.w], y > 0u); let qb = select(q, qyo[i + p.w], y + 2u < p.h);
    qyn[i] = flux(q, qa, qb, z[i], z[i + p.w], d[i], d[i + p.w], dt, 0.5 * (n2[i] + n2[i + p.w]));
  } else { qyn[i] = 0.0; }
}`);

  pipe('scale', ['d', 'qxn', 'qyn', 'sc', 'st'], `${CELL}
  var o = 0.0;
  if (x < p.w - 1u && qxn[i] > 0.0) { o += qxn[i]; }
  if (x > 0u && qxn[i - 1u] < 0.0) { o -= qxn[i - 1u]; }
  if (y < p.h - 1u && qyn[i] > 0.0) { o += qyn[i]; }
  if (y > 0u && qyn[i - p.w] < 0.0) { o -= qyn[i - p.w]; }
  let od = o * st.dt / p.dx;
  sc[i] = select(1.0, d[i] / od, od > d[i] && od > 0.0);
}`);

  pipe('apply', ['qxn', 'qyn', 'sc'], `${CELL}
  if (x < p.w - 1u) { let q = qxn[i]; qxn[i] = q * select(sc[i + 1u], sc[i], q > 0.0); }
  if (y < p.h - 1u) { let q = qyn[i]; qyn[i] = q * select(sc[i + p.w], sc[i], q > 0.0); }
}`);

  pipe('continuity', ['d', 'qxn', 'qyn', 'sink', 'st'], `${CELL}
  let dt = st.dt;
  var net = 0.0;
  if (x < p.w - 1u) { net -= qxn[i]; }
  if (x > 0u) { net += qxn[i - 1u]; }
  if (y < p.h - 1u) { net -= qyn[i]; }
  if (y > 0u) { net += qyn[i - p.w]; }
  var v = max(d[i] + dt / p.dx * net, 0.0);
  if (sink[i] == 0u) { v += p.rain * dt; }
  d[i] = v;
}`);

  pipe('extras', ['z', 'd', 'src', 'cul', 'st'], `@compute @workgroup_size(1) fn main() {
  let dt = st.dt;
  for (var s = 0u; s < p.nsrc; s++) { let k = src[s].i; d[k] += src[s].Q * dt / p.A; }
  for (var c = 0u; c < p.ncul; c++) {
    var fr = cul[c].a; var to = cul[c].b; var sgn = 1.0;
    var dh = (z[fr] + d[fr]) - (z[to] + d[to]);
    if (dh < 0.0) { fr = cul[c].b; to = cul[c].a; dh = -dh; sgn = -1.0; }
    let din = d[fr];
    if (din <= p.minD || dh <= 0.0) { cul[c].Q = 0.0; continue; }
    let D = cul[c].D; let Ap = 3.14159265 * D * D / 4.0;
    let wet = min(din / D, 1.0);
    var vol = 0.6 * Ap * wet * sqrt(2.0 * p.g * dh) * dt;
    vol = min(vol, min(din, dh / 2.0) * p.A);
    d[fr] -= vol / p.A; d[to] += vol / p.A;
    cul[c].Q = sgn * vol / dt;
  }
}`);

  pipe('soak', ['d', 'F', 'sink', 'ai', 'ad', 'st', 'Ks', 'Pg'], `${CELL}
  let dt = st.dt;
  var di = d[i];
  if (di <= 0.0) { return; }
  if (sink[i] != 0u) { ad[i] += di; d[i] = 0.0; return; }
  let k = Ks[i];
  if (k > 0.0) {
    let Fi = max(F[i], 1e-3);
    let a = min(k * (1.0 + Pg[i] / Fi) * dt, di);
    di -= a; F[i] += a; ai[i] += a;
  }
  d[i] = di;
}`);

  // allocate per-grid buffers; rebuilt when the grid size changes
  function alloc(S) {
    if (eng.grid) Object.values(eng.grid.buf).forEach(b => b.destroy());
    const N = S.w * S.h, SZ = N * 4;
    const mk = (size, usage) => device.createBuffer({ size: Math.max(16, size), usage });
    const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = {
      params: mk(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      z: mk(SZ, ST), d: mk(SZ, ST), qxA: mk(SZ, ST), qyA: mk(SZ, ST), qxB: mk(SZ, ST), qyB: mk(SZ, ST),
      sc: mk(SZ, ST), F: mk(SZ, ST), sink: mk(SZ, ST), ai: mk(SZ, ST), ad: mk(SZ, ST), n2: mk(SZ, ST), Ks: mk(SZ, ST), Pg: mk(SZ, ST),
      st: mk(16 + GPU_MAX_STEPS * 4, ST), src: mk(GPU_MAX_SRC * 8, ST), cul: mk(GPU_MAX_CUL * 16, ST),
      read: mk(SZ * 5 + 16 + GPU_MAX_STEPS * 4 + GPU_MAX_CUL * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
    };
    const bind = (name, parity) => {
      const map = { z: buf.z, d: buf.d, sc: buf.sc, F: buf.F, sink: buf.sink, ai: buf.ai, ad: buf.ad, st: buf.st, src: buf.src, cul: buf.cul,
        n2: buf.n2, Ks: buf.Ks, Pg: buf.Pg,
        qxo: parity ? buf.qxB : buf.qxA, qyo: parity ? buf.qyB : buf.qyA, qxn: parity ? buf.qxA : buf.qxB, qyn: parity ? buf.qyA : buf.qyB };
      const pp = pipes[name];
      return device.createBindGroup({ layout: pp.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: buf.params } }, ...pp.names.map((n, k) => ({ binding: k + 1, resource: { buffer: map[n] } }))] });
    };
    const groups = [0, 1].map(par => Object.fromEntries(Object.keys(pipes).map(n => [n, bind(n, par)])));
    eng.grid = { S, N, w: S.w, h: S.h, buf, groups, parity: 0, zref: 0, f32: new Float32Array(N), u32: new Uint32Array(N), wet: 0 };
  }

  // push the CPU state to the card (whole arrays; only when something changed them)
  function upload(S) {
    const G = eng.grid, q = device.queue, f = G.f32, N = G.N;
    let zmin = Infinity; for (let i = 0; i < N; i++) if (S.z[i] < zmin) zmin = S.z[i];
    G.zref = zmin;
    for (let i = 0; i < N; i++) f[i] = S.z[i] - zmin; q.writeBuffer(G.buf.z, 0, f);
    for (let i = 0; i < N; i++) f[i] = S.d[i]; q.writeBuffer(G.buf.d, 0, f);
    const qxCur = G.parity ? G.buf.qxB : G.buf.qxA, qyCur = G.parity ? G.buf.qyB : G.buf.qyA;
    for (let i = 0; i < N; i++) f[i] = S.qx[i]; q.writeBuffer(qxCur, 0, f);
    for (let i = 0; i < N; i++) f[i] = S.qy[i]; q.writeBuffer(qyCur, 0, f);
    for (let i = 0; i < N; i++) f[i] = S.F[i]; q.writeBuffer(G.buf.F, 0, f);
    for (let i = 0; i < N; i++) f[i] = S.n2[i]; q.writeBuffer(G.buf.n2, 0, f);
    for (let i = 0; i < N; i++) f[i] = S.Ks[i]; q.writeBuffer(G.buf.Ks, 0, f);
    for (let i = 0; i < N; i++) f[i] = S.P[i]; q.writeBuffer(G.buf.Pg, 0, f);
    let wet = 0; for (let i = 0; i < N; i++) { G.u32[i] = S.sink[i]; if (!S.sink[i]) wet++; }
    q.writeBuffer(G.buf.sink, 0, G.u32); G.wet = wet;
    S.dirty = false;
  }

  function writeSmall(S) {
    const G = eng.grid, q = device.queue;
    const pb = new ArrayBuffer(80), u = new Uint32Array(pb), fl = new Float32Array(pb);
    const nsrc = Math.min(S.sources.length, GPU_MAX_SRC), ncul = Math.min(S.culverts.length, GPU_MAX_CUL);
    u[0] = S.w; u[1] = S.h; u[2] = G.N; u[3] = nsrc; u[4] = ncul;
    fl[8] = S.dx; fl[9] = 9.81; fl[11] = S.theta; fl[12] = S.alpha; fl[13] = S.dtMax;
    fl[14] = S.minDepth; fl[15] = S.rain; fl[19] = S.dx * S.dx;
    q.writeBuffer(G.buf.params, 0, pb);
    if (nsrc) { const sb = new ArrayBuffer(nsrc * 8), su = new Uint32Array(sb), sf = new Float32Array(sb);
      S.sources.slice(0, nsrc).forEach((s, k) => { su[k * 2] = s.i; sf[k * 2 + 1] = s.Q; }); q.writeBuffer(G.buf.src, 0, sb); }
    if (ncul) { const cb = new ArrayBuffer(ncul * 16), cu = new Uint32Array(cb), cf = new Float32Array(cb);
      S.culverts.slice(0, ncul).forEach((c, k) => { cu[k * 4] = c.a; cu[k * 4 + 1] = c.b; cf[k * 4 + 2] = c.D; }); q.writeBuffer(G.buf.cul, 0, cb); }
  }

  // run n steps, then copy results back into S. Resolves when S is up to date.
  eng.run = async (S, n) => {
    if (eng.lost) throw new Error('GPU device lost');
    n = Math.max(1, Math.min(GPU_MAX_STEPS, n | 0));
    if (!eng.grid || eng.grid.S !== S || eng.grid.N !== S.w * S.h) { alloc(S); S.dirty = true; }
    const G = eng.grid;
    if (S.dirty) upload(S);
    writeSmall(S);
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    const wg = Math.ceil(G.N / 256);
    let par = G.parity;
    for (let k = 0; k < n; k++) {
      const g = G.groups[par];
      const run = (name, count) => { pass.setPipeline(pipes[name].pipeline); pass.setBindGroup(0, g[name]); pass.dispatchWorkgroups(count); };
      run('reduce', wg); run('dt', 1); run('momentum', wg); run('scale', wg); run('apply', wg);
      run('continuity', wg); run('extras', 1); run('soak', wg);
      par ^= 1;
    }
    pass.end();
    G.parity = par;
    const SZ = G.N * 4, B = G.buf, qxCur = par ? B.qxB : B.qxA, qyCur = par ? B.qyB : B.qyA;
    const oSt = SZ * 5, oCul = oSt + 16 + GPU_MAX_STEPS * 4;
    enc.copyBufferToBuffer(B.d, 0, B.read, 0, SZ);
    enc.copyBufferToBuffer(qxCur, 0, B.read, SZ, SZ);
    enc.copyBufferToBuffer(qyCur, 0, B.read, SZ * 2, SZ);
    enc.copyBufferToBuffer(B.ai, 0, B.read, SZ * 3, SZ);
    enc.copyBufferToBuffer(B.ad, 0, B.read, SZ * 4, SZ);
    enc.copyBufferToBuffer(B.st, 0, B.read, oSt, 16 + GPU_MAX_STEPS * 4);
    enc.copyBufferToBuffer(B.cul, 0, B.read, oCul, GPU_MAX_CUL * 16);
    enc.clearBuffer(B.ai); enc.clearBuffer(B.ad); enc.clearBuffer(B.st);
    device.queue.submit([enc.finish()]);
    await B.read.mapAsync(GPUMapMode.READ);
    const all = B.read.getMappedRange();
    const fd = new Float32Array(all, 0, G.N), fqx = new Float32Array(all, SZ, G.N), fqy = new Float32Array(all, SZ * 2, G.N);
    const fai = new Float32Array(all, SZ * 3, G.N), fad = new Float32Array(all, SZ * 4, G.N);
    const stU = new Uint32Array(all, oSt, 4), stLog = new Float32Array(all, oSt + 16, GPU_MAX_STEPS), cf = new Float32Array(all, oCul, GPU_MAX_CUL * 4);
    let sInf = 0, sDr = 0;
    for (let i = 0; i < G.N; i++) { S.d[i] = fd[i]; S.qx[i] = fqx[i]; S.qy[i] = fqy[i]; sInf += fai[i]; sDr += fad[i]; }
    const steps = Math.min(stU[1], GPU_MAX_STEPS);
    let dtSum = 0; for (let k = 0; k < steps; k++) dtSum += stLog[k];
    const A = S.dx * S.dx;
    let qSrc = 0; for (const s of S.sources.slice(0, GPU_MAX_SRC)) qSrc += s.Q;
    S.vol.rain += S.rain * dtSum * G.wet * A;
    S.vol.source += qSrc * dtSum;
    S.vol.infil += sInf * A; S.vol.drained += sDr * A;
    S.culverts.slice(0, GPU_MAX_CUL).forEach((c, k) => { c.Q = cf[k * 4 + 3]; });
    S.t += dtSum; S.lastDt = steps ? stLog[steps - 1] : S.lastDt;
    B.read.unmap();
    eng.lastMsPerStep = 0.3 * eng.lastMsPerStep + 0.7 * (performance.now() - t0) / n;
    return steps;
  };
  eng.forget = () => { if (eng.grid) { Object.values(eng.grid.buf).forEach(b => b.destroy()); eng.grid = null; } };
  return eng;
}
