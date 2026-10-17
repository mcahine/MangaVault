# -*- coding: utf-8 -*-
"""批量生成缩略图：读取任务 JSON（[{"src","dst","size"}]），跳过已存在的 dst。
每完成一项打印 PROGRESS <done> <total>，供主进程上报真实进度。
"""
import json, os, sys

try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
except Exception as exc:
    sys.stderr.write('NO_PIL: %s\n' % exc)
    sys.exit(3)


def main():
    tasks = json.load(open(sys.argv[1], encoding='utf-8'))
    total = len(tasks)
    ok = fail = skip = 0
    for i, t in enumerate(tasks, 1):
        dst = t['dst']
        if os.path.exists(dst):
            skip += 1
            print('PROGRESS %d %d' % (i, total), flush=True)
            continue
        try:
            d = os.path.dirname(dst)
            if d:
                os.makedirs(d, exist_ok=True)
            im = Image.open(t['src'])
            im = im.convert('RGB')
            size = int(t.get('size', 256))
            im.thumbnail((size, size), Image.LANCZOS)
            im.save(dst, 'JPEG', quality=82)
            ok += 1
        except Exception as e:
            fail += 1
            sys.stderr.write('FAIL %s: %s\n' % (t['src'], e))
        print('PROGRESS %d %d' % (i, total), flush=True)
    print(json.dumps({'ok': ok, 'skip': skip, 'fail': fail}, ensure_ascii=False))


main()
