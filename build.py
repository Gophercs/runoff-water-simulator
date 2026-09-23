#!/usr/bin/env python3
"""Build Runoff into one self-contained HTML file: dist/index.html.

Everything (physics, engines, app, three.js, geotiff.js, the font) is inlined, so the result works
opened straight from disk, on any static host, or as a claude.ai artifact. Needs only Python 3.
"""
import base64, pathlib

ROOT = pathlib.Path(__file__).parent

def read(p): return (ROOT / p).read_text(encoding='utf-8')
def b64(p): return base64.b64encode((ROOT / p).read_bytes()).decode()

VERSION = '1.2.2'

HEADER = f"""<!--
  Runoff {VERSION}: lidar terrain water simulator, by Gophercs and Claude.
  Copyright (C) 2026 Gophercs. Licensed under the GNU GPL v3 or later; see LICENSE.
  Bundles three.js (MIT), geotiff.js (MIT) and Atkinson Hyperlegible (SIL OFL 1.1); the logo is drawn from
  Ubuntu Condensed (Ubuntu Font Licence 1.0). See vendor/.
-->
"""

FONTFACE = '\n'.join(
    f"@font-face{{font-family:'Atkinson Hyperlegible';font-style:normal;font-weight:{w};font-display:swap;"
    f"src:url(data:font/woff2;base64,{b64(f'vendor/fonts/atkinson-hyperlegible-latin-{w}-normal.woff2')}) format('woff2')}}"
    for w in (400, 700))

# the tab icon: replace vendor/favicon.png to change it
FAVICON = 'data:image/png;base64,' + b64('vendor/favicon.png')

# Optional shared OS Maps API key for hosted builds, so visitors get a map without signing up.
# It's read from the RUNOFF_OS_KEY environment variable (set it in Cloudflare Pages) or a local os_key.txt,
# and never lives in the repository. Use a key from an OS project with only the OS Maps API on the OpenData plan.
import os
OS_KEY = os.environ.get('RUNOFF_OS_KEY', '').strip()
if not OS_KEY and (ROOT / 'os_key.txt').exists(): OS_KEY = (ROOT / 'os_key.txt').read_text().strip()
assert all(c.isalnum() or c in '-_' for c in OS_KEY), 'that OS key has unexpected characters'

html = read('src/shell.html')
parts = {
    '/*VENDOR_GEOTIFF*/': read('vendor/geotiff.js'),
    '/*VENDOR_THREE*/': read('vendor/three.min.js'),
    '/*FONTFACE*/': FONTFACE,
    '/*FAVICON*/': FAVICON,
    '/*SIM_CORE*/': read('src/sim_core.js'),
    '/*GPU*/': read('src/gpu.js'),
    '/*POOL*/': read('src/pool.js'),
    '/*LOGO*/': read('src/logo.js'),
    '/*APP*/': read('src/app_head.js') + read('src/lidar.js') + read('src/app_tail.js'),
}
for key, val in parts.items():
    assert html.count(key) == 1, f'{key} should appear exactly once in src/shell.html'
    html = html.replace(key, val)
html = html.replace('<!doctype html>', '<!doctype html>\n' + HEADER, 1)
# Optional relay address (a Cloudflare Worker, see relay/) for Welsh lidar: RUNOFF_RELAY env var or relay.txt
# '/relay' is the Pages Function in functions/relay.js, which deploys with the site
RELAY = os.environ.get('RUNOFF_RELAY', '/relay').strip()
if (ROOT / 'relay.txt').exists(): RELAY = (ROOT / 'relay.txt').read_text().strip()
assert RELAY == '' or RELAY.startswith('https://') or RELAY.startswith('/'), 'the relay should be /relay or an https:// address'
html = html.replace('__RUNOFF_RELAY__', RELAY)
html = html.replace('__RUNOFF_OS_KEY__', OS_KEY).replace('__RUNOFF_VERSION__', VERSION)

out = ROOT / 'dist' / 'index.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding='utf-8')
print(f'wrote {out} ({len(html.encode()) / 1e6:.2f} MB), version {VERSION}, shared OS key {"included" if OS_KEY else "not set"}, relay {RELAY or "not set"}')
