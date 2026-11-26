# Découpe des visages des caractères dans les deux planches : chaque tête avec son cadre, l'antenne (mangée par la case du dessus)
# reprise de la première rangée, puis recolorée comme le logo (noir transparent, traits au vert de l'interface).
import os, sys
from PIL import Image

A = 'D:/005-GIT/PAIZ/app/assets/'
OUT = 'D:/005-GIT/PAIZ/app/public/v2/faces/'
os.makedirs(OUT, exist_ok=True)
COLS = [375, 697, 1018, 1338]          # centres des colonnes (Assistant, Léo, Léa, HAL)
ROWS = ['normal', 'souriant', 'mecontent', 'gene']
PITCH = 221; TOP = 92; BOTTOM = 300; HALF = 164; ANT = 50
ACCENT = (79, 216, 196); LIGHT = (130, 236, 218)


def recolor(im):
    im = im.convert('RGB'); w, h = im.size; out = Image.new('RGBA', (w, h)); px = im.load(); po = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]; lum = max(r, g, b) / 255.0
            a = min(1.0, max(0.0, (lum - 0.05) / 0.75)) ** 0.85
            t = min(1.0, max(0.0, (lum - 0.93) / 0.07)) * 0.6; t = t * t * (3 - 2 * t)
            po[x, y] = (*(round(ACCENT[i] + (LIGHT[i] - ACCENT[i]) * t) for i in range(3)), round(a * 255))
    return out


def head(sheet, ci, ri):
    cx = COLS[ci]
    ant = sheet.crop((cx - HALF, ANT, cx + HALF, TOP))                           # antenne entière (rangée du haut)
    body = sheet.crop((cx - HALF, TOP + PITCH * ri, cx + HALF, BOTTOM + PITCH * ri))
    im = Image.new('RGB', (2 * HALF, (TOP - ANT) + (BOTTOM - TOP)), (0, 0, 0))
    im.paste(ant, (0, 0)); im.paste(body, (0, TOP - ANT))
    return im


sets = [('Grille d’expressions robotiques néon.png', [(0, 'assistant'), (1, 'leo'), (2, 'lea'), (3, 'hal')]),
        ('Grille néon des émotions robotisées.png', [(2, 'blip'), (3, 'blup')])]
sheet_preview = Image.new('RGBA', (6 * 170, 4 * 140), (11, 18, 22, 255))
k = 0
for fname, cols in sets:
    sheet = Image.open(A + fname).convert('RGB')
    for ci, name in cols:
        for ri, expr in enumerate(ROWS):
            im = recolor(head(sheet, ci, ri)).resize((160, 121), Image.LANCZOS)
            im.save(f'{OUT}{name}-{expr}.webp', 'WEBP', lossless=True)
            sheet_preview.alpha_composite(im, (k * 170 + 5, ri * 140 + 10))
        k += 1
sheet_preview.convert('RGB').save(sys.argv[1] if len(sys.argv) > 1 else 'faces-preview.png')
print('ok', k * 4, 'visages')
