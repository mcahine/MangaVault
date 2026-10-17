# -*- coding: utf-8 -*-
"""把查重单元的首图拼成一张联络表，便于人工/视觉快速读取标题。
用法: python covers.py <spec.json>
spec.json: {"scanRoot":"...","out":"...jpg","cols":3,"cell":[460,650],"pad":12,"top":30,"hexOnly":true}
hexOnly=true 时只收录名称形如 24 位十六进制（哔咔章节 ID）的单元。
"""
import json, os, sys

try:
    from PIL import Image, ImageDraw
    Image.MAX_IMAGE_PIXELS = None
except Exception as exc:
    sys.stderr.write('NO_PIL: %s\n' % exc)
    sys.exit(3)

IMG = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif')


def first_image(d):
    try:
        imgs = sorted([f for f in os.listdir(d) if f.lower().endswith(IMG)])
    except OSError:
        return None
    return os.path.join(d, imgs[0]) if imgs else None


def collect(scan_root):
    units = []
    try:
        entries = sorted(os.listdir(scan_root))
    except OSError:
        return units
    for e in entries:
        p = os.path.join(scan_root, e)
        if not os.path.isdir(p):
            continue
        f = first_image(p)
        if f:
            units.append((e, f))
            continue
        try:
            subs = sorted(os.listdir(p))
        except OSError:
            continue
        for s in subs:
            sp = os.path.join(p, s)
            if not os.path.isdir(sp):
                continue
            sf = first_image(sp)
            if sf:
                units.append((e + '/' + s, sf))
    return units


def main():
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    scan_root = spec['scanRoot']
    out = spec['out']
    cols = int(spec.get('cols', 3))
    cell = spec.get('cell') or [460, 650]
    cw, ch = int(cell[0]), int(cell[1])
    pad = int(spec.get('pad', 12))
    top = int(spec.get('top', 30))
    hex_only = spec.get('hexOnly') is not False

    units = collect(scan_root)
    if hex_only:
        hexchars = set('0123456789abcdef')
        units = [(n, f) for (n, f) in units if len(n.split('/')[-1]) == 24 and all(c in hexchars for c in n.split('/')[-1])]
    if not units:
        print(json.dumps({'ok': True, 'count': 0, 'out': ''}, ensure_ascii=False))
        return

    rows = (len(units) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * (cw + pad) + pad, rows * (ch + top + pad) + pad), (24, 26, 30))
    d = ImageDraw.Draw(sheet)
    placed = 0
    for i, (name, first) in enumerate(units):
        try:
            im = Image.open(first).convert('RGB')
        except Exception as ex:
            sys.stderr.write('FAIL %s: %s\n' % (first, ex))
            continue
        im.thumbnail((cw, ch), Image.LANCZOS)
        cx = pad + (i % cols) * (cw + pad)
        cy = pad + (i // cols) * (ch + top + pad)
        d.text((cx + 4, cy + 8), name.split('/')[-1] + '  (' + str(placed + 1) + ')', fill=(255, 220, 120))
        sheet.paste(im, (cx + (cw - im.width) // 2, cy + top))
        placed += 1
        print('PROGRESS %d %d' % (i + 1, len(units)), flush=True)
    pdir = os.path.dirname(out)
    if pdir:
        os.makedirs(pdir, exist_ok=True)
    sheet.save(out, 'JPEG', quality=88)
    print(json.dumps({'ok': True, 'count': placed, 'out': out, 'size': list(sheet.size)}, ensure_ascii=False))


main()
