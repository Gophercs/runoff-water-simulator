// Runoff logo: "Runoff" in Ubuntu Condensed, converted to outlines at build time (tools/make_logo.py), so it
// needs no font file. Water is a blue fill clipped to the letters; its level and motion show what the app is doing:
// idle = empty white letters, loading = rising, calm = full and still, running = sloshing.
const LOGO = { x: 84.0, y: -776.0, w: 2469.0, h: 789.0, d: 'M84 -683Q154 -700 219 -700Q271 -700 313 -688Q355 -676 385 -650Q415 -624 431.5 -583Q448 -542 448 -484Q448 -412 420.5 -367.5Q393 -323 346 -300Q358 -280 376.5 -245.5Q395 -211 414.5 -169.5Q434 -128 452.5 -84Q471 -40 484 0H394Q383 -30 366.5 -68Q350 -106 332 -143.5Q314 -181 296 -215.5Q278 -250 264 -274Q248 -272 231 -271Q214 -270 197 -270H172V0H84ZM1881 -262Q1881 -200 1870 -149.5Q1859 -99 1836.5 -63Q1814 -27 1779.5 -7Q1745 13 1698 13Q1651 13 1616 -7Q1581 -27 1558.5 -63Q1536 -99 1525 -149.5Q1514 -200 1514 -262Q1514 -323 1525 -374Q1536 -425 1558.5 -461.5Q1581 -498 1616 -518Q1651 -538 1698 -538Q1745 -538 1779.5 -518Q1814 -498 1836.5 -461.5Q1859 -425 1870 -374Q1881 -323 1881 -262ZM907 -15Q894 -10 875.5 -5.5Q857 -1 836.5 2.5Q816 6 795.5 8.5Q775 11 758 11Q717 11 683 1.5Q649 -8 625 -32Q601 -56 588 -97.5Q575 -139 575 -202V-525H661V-205Q661 -128 684.5 -96.5Q708 -65 756 -65Q772 -65 788 -66.5Q804 -68 821 -73V-525H907ZM1062 -510Q1099 -521 1142 -528.5Q1185 -536 1221 -536Q1260 -536 1292 -525.5Q1324 -515 1346.5 -490Q1369 -465 1381.5 -422.5Q1394 -380 1394 -317V0H1308V-310Q1308 -388 1288 -424Q1268 -460 1213 -460Q1184 -460 1148 -450V0H1062ZM2160 -776Q2189 -776 2211 -770Q2233 -764 2247 -757L2229 -689Q2215 -696 2200 -699.5Q2185 -703 2168 -703Q2145 -703 2130 -695Q2115 -687 2107 -673Q2099 -659 2096 -639.5Q2093 -620 2093 -598V-525H2228V-451H2093V0H2007V-598Q2007 -683 2045 -729.5Q2083 -776 2160 -776ZM2466 -776Q2495 -776 2517 -770Q2539 -764 2553 -757L2535 -689Q2521 -696 2506 -699.5Q2491 -703 2474 -703Q2451 -703 2436 -695Q2421 -687 2413 -673Q2405 -659 2402 -639.5Q2399 -620 2399 -598V-525H2534V-451H2399V0H2313V-598Q2313 -683 2351 -729.5Q2389 -776 2466 -776ZM1791 -262Q1791 -306 1786 -342.5Q1781 -379 1770 -405.5Q1759 -432 1741 -446.5Q1723 -461 1698 -461Q1672 -461 1654.5 -446.5Q1637 -432 1625.5 -405.5Q1614 -379 1609 -342.5Q1604 -306 1604 -262Q1604 -218 1609 -181.5Q1614 -145 1625.5 -119Q1637 -93 1654.5 -78.5Q1672 -64 1698 -64Q1723 -64 1741 -78.5Q1759 -93 1770 -119Q1781 -145 1786 -181.5Q1791 -218 1791 -262ZM172 -344H210Q279 -344 316 -375.5Q353 -407 353 -484Q353 -523 343.5 -549.5Q334 -576 316.5 -591.5Q299 -607 274.5 -614Q250 -621 220 -621Q194 -621 172 -618Z' };
const logos = [];
let logoSeq = 0;
function makeLogo(el) {
  const id = 'lgclip' + (++logoSeq), p = 24, L = LOGO;
  el.innerHTML = `<svg viewBox="${L.x - p} ${L.y - p} ${L.w + 2 * p} ${L.h + 2 * p}" aria-hidden="true" focusable="false">
    <defs><clipPath id="${id}"><path d="${L.d}"/></clipPath></defs>
    <path d="${L.d}" class="lg-letters"/>
    <g clip-path="url(#${id})"><path class="lg-back"/><path class="lg-water"/></g>
    <path d="${L.d}" class="lg-line"/></svg>`;
  const g = { back: el.querySelector('.lg-back'), water: el.querySelector('.lg-water'), level: 0.6, slosh: 1, phase: Math.random() * 6 };
  logos.push(g); return g;
}
let logoMode = 'idle', logoTarget = 0.6, logoCreep = false, logoLast = performance.now();
// idle: empty; loading: creep upwards (or follow real progress); calm: full and still; running: full and sloshing
function setLogo(mode, progress) {
  logoMode = mode;
  logoCreep = false; logoTarget = 0.6;   // always half full: sloshing = busy or running, still = ready
}
function logoTick(now) {
  const dt = Math.min(0.1, (now - logoLast) / 1000); logoLast = now;
  if (logoCreep) logoTarget += (0.7 - logoTarget) * dt * 0.55;       // unknown progress: ease towards most of the way
  const L = LOGO, bottom = L.y + L.h + 30, top = L.y - 10, N = 48;
  for (const g of logos) {
    g.level += (logoTarget - g.level) * Math.min(1, dt * 2.5);
    const want = logoMode === 'calm' ? 0 : 1;
    g.slosh += (want - g.slosh) * Math.min(1, dt * 1.5);
    g.phase += dt * (1.0 + 3.0 * g.slosh);
    const base = bottom - (bottom - top) * g.level;
    const amp = 5 + 55 * g.slosh, tilt = 130 * g.slosh * Math.sin(g.phase * 0.6);
    const wave = (k, off) => {
      let s = `M${L.x - 30} ${bottom}`;
      for (let i = 0; i <= N; i++) {
        const xx = L.x - 30 + (L.w + 60) * i / N, u = (xx - L.x) / L.w;
        const yy = base + tilt * (u - 0.5) * 2 + amp * Math.sin(u * 9 * k + g.phase * (k > 1 ? 1.3 : 1) + off) + amp * 0.4 * Math.sin(u * 23 - g.phase * 1.7 + off);
        s += `L${xx.toFixed(1)} ${yy.toFixed(1)}`;
      }
      return s + `L${L.x + L.w + 30} ${bottom}Z`;
    };
    if (g.level < 0.002) { g.water.setAttribute('d', ''); g.back.setAttribute('d', ''); continue; }
    g.back.setAttribute('d', wave(1.3, 2.1)); g.water.setAttribute('d', wave(1, 0));
  }
  requestAnimationFrame(logoTick);
}
requestAnimationFrame(logoTick);
