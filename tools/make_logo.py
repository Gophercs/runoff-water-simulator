#!/usr/bin/env python3
"""Regenerate the logo outlines in src/logo.js from a font.

Shapes the word with HarfBuzz (so the font's own kerning applies), converts the glyphs to outlines and merges
overlaps (so the double f has one clean outline), then prints LOGO data to paste into src/logo.js.

  pip install fonttools uharfbuzz skia-pathops
  python3 tools/make_logo.py UbuntuCondensed-Regular.ttf Runoff
"""
import re, sys
import uharfbuzz as hb, pathops
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

path, text = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'Runoff'
font = hb.Font(hb.Face(hb.Blob.from_file_path(path)))
buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
hb.shape(font, buf, {'liga': False, 'kern': True})
tt = TTFont(path); gs = tt.getGlyphSet(); order = tt.getGlyphOrder()

merged = pathops.Path(); pen = merged.getPen(); bounds = BoundsPen(gs); x = 0
for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
    g = gs[order[info.codepoint]]
    g.draw(TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, 0)))
    g.draw(TransformPen(bounds, (1, 0, 0, -1, x + pos.x_offset, 0)))
    x += pos.x_advance
merged.simplify(fix_winding=True)
svg = SVGPathPen(None); merged.draw(svg)
d = re.sub(r'-?\d+\.\d+', lambda m: ('%.1f' % float(m.group())).rstrip('0').rstrip('.'), svg.getCommands())
x0, y0, x1, y1 = bounds.bounds
print(f"const LOGO = {{ x: {x0}, y: {y0}, w: {x1 - x0}, h: {y1 - y0}, d: '{d}' }};")
