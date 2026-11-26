# Logo et écran de démarrage pour la nouvelle interface : le noir devient transparent (le dessin se fond sur le fond de l'appli),
# les traits prennent le vert de l'interface, un peu plus clair dans les zones lumineuses. Les originaux ne sont pas modifiés.
import sys
from PIL import Image

ACCENT = (79, 216, 196)   # vert de l'interface (#4fd8c4)
LIGHT = (130, 236, 218)   # reflets
BG = (11, 18, 22)         # fond de l'appli, pour l'aperçu


def recolor(src, dst, preview):
    im = Image.open(src).convert('RGB')
    w, h = im.size
    out = Image.new('RGBA', (w, h))
    px = im.load(); po = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            lum = max(r, g, b) / 255.0
            a = min(1.0, max(0.0, (lum - 0.05) / 0.75)) ** 0.85
            t = min(1.0, max(0.0, (lum - 0.93) / 0.07)) * 0.6
            t = t * t * (3 - 2 * t)
            c = tuple(round(ACCENT[i] + (LIGHT[i] - ACCENT[i]) * t) for i in range(3))
            po[x, y] = (*c, round(a * 255))
    out.save(dst, 'WEBP', lossless=True)
    bg = Image.new('RGBA', (w, h), (*BG, 255))
    bg.alpha_composite(out)
    bg.convert('RGB').save(preview)


recolor(sys.argv[1], sys.argv[2], sys.argv[3])
recolor(sys.argv[4], sys.argv[5], sys.argv[6])
print('ok')
