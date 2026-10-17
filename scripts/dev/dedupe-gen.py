# -*- coding: utf-8 -*-
import os, sys
from PIL import Image, ImageDraw
import random
root = sys.argv[1]
def mk(seed, size, path, fmt):
    rnd = random.Random(seed)
    im = Image.new('RGB', size, (rnd.randint(0,255), rnd.randint(0,255), rnd.randint(0,255)))
    d = ImageDraw.Draw(im)
    for i in range(24):
        d.line([(rnd.randint(0,size[0]), rnd.randint(0,size[1])), (rnd.randint(0,size[0]), rnd.randint(0,size[1]))],
               fill=(rnd.randint(0,255), rnd.randint(0,255), rnd.randint(0,255)), width=rnd.randint(1,5))
    for i in range(60):
        x0, y0 = rnd.randint(0, size[0] - 24), rnd.randint(0, size[1] - 24)
        d.rectangle([x0, y0, x0 + rnd.randint(6, 24), y0 + rnd.randint(6, 24)], fill=(rnd.randint(0,255), rnd.randint(0,255), rnd.randint(0,255)))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, fmt, quality=92) if fmt == 'JPEG' else im.save(path, fmt)
for i in range(1, 7):
    mk(100 + i, (400, 560), os.path.join(root, 'scan', '分类X', '单元A', '%03d.jpg' % i), 'JPEG')
    mk(100 + i, (400, 560), os.path.join(root, 'lib', '漫画Z', '第1话', '%03d.png' % i), 'PNG')
for i in range(1, 4):
    mk(900 + i, (300, 400), os.path.join(root, 'scan', '分类X', '单元B', 'p%02d.jpg' % i), 'JPEG')
# 只含子目录、不含图片的目录不应成为单元
os.makedirs(os.path.join(root, 'scan', '分类X', '空壳', '子目录'), exist_ok=True)
print('generated')