# Stacks the layers saved by browser-first.spec.ts (SHOT=1) into one picture: python3 scripts/_compose-layers.py test-results/bf-open.json out.png
import base64, io, json, sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
parts = json.load(open(src))
base = None
for p in parts:
    im = Image.open(io.BytesIO(base64.b64decode(p['png']))).convert('RGBA')
    if base is None:
        k = im.width / p['w']
        base = Image.new('RGBA', (int(p['w'] * k), int(p['h'] * k)), 'white')
    im = im.resize((int(p['w'] * k), int(p['h'] * k)))
    base.alpha_composite(im, (int(p['x'] * k), int(p['y'] * k)))
base.convert('RGB').save(out)
