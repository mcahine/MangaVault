# -*- coding: utf-8 -*-
"""为库内全部章节（lib）与查重全部单元（dup）建立 32x32 灰度指纹缓存（Windows 多进程安全版）。
用法: python build-fp.py <spec.json> [--force] [--only lib|dup]
spec.json: {"libFp":"...","dupFp":"...","spec":"fp-v2",jobs:[[kind,key,dir,files,out],...],"index":[...]}
产物: <libFp>/<md5>.bin, <libFp>/index.json, <libFp>/sigs.json, <dupFp>/<md5>.bin, <dupFp>/sigs.json
增量判据 = 源文件「mtime + 总字节数 + 张数」签名 + 指纹规格版本（不再是纯 mtime，
改编码 / 同秒覆盖 / 换文件名都能识别；规格升版会整体重建）。
每批次打印 PROGRESS <done> <total>，最后打印 DONE <json>，供主进程上报真实进度。
注意：签名（当前/上次）随任务元组一起传给子进程，**不能依赖模块级全局**——
Windows 用 spawn 启动子进程，子进程拿到的是全新的模块副本，全局签名表在子进程里永远是空的。
"""
import json, os, struct, sys, time, threading, gc, ctypes

try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
except Exception as exc:
    sys.stderr.write('NO_PIL: %s\n' % exc)
    sys.exit(3)

FORCE = '--force' in sys.argv
# 解码阶段就降采样的边长。draft('L', (n,n)) 是 JPEG 专用优化（解码时就按 1/2、1/4、1/8 抽），
# 实测对 63397 张全库约 2x 加速；webp/png 会抛异常，回落到全尺寸解码。
DECODE_TO = int(os.environ.get('FP_DECODE_TO') or 64)
SPEC = 'fp-v2'
# 每个并行解码槽的内存预留（MB）。实测（本机 4 物理核 / 8 逻辑核，60 张最大图，合计 1182MPx）：
# 单线程峰值增量约 26MB，12 线程约 693MB —— 即每个并行槽约 30~58MB。
# 这里取 32MB 作预留；FP_THREAD_MB 可覆盖，便于复现脚本做对照实测。
PER_WORKER_MB = int(os.environ.get('FP_THREAD_MB') or 32)
# 超大图阈值（像素）。超过就逐张打印 BIGIMG 行，绝不静默丢弃（原先只计 badimg，看不见）。
BIG_PX = int(os.environ.get('FP_BIG_PX') or (64 * 1024 * 1024))
# BIGIMG 行最多打印多少条，避免一个畸形库把日志刷爆
BIG_LOG_MAX = int(os.environ.get('FP_BIG_LOG_MAX') or 20)
_big_lock = threading.Lock()
_big_lines = [0]

# 「大图闸门」：超过这个像素数的图，全进程最多只允许 BIG_GATE_N 张同时解码。
# 为什么必须有它：draft('L', ...) 只对 JPEG 生效，PNG/webp 会按原尺寸解码，
# 一张 33MP 的 RGBA PNG 就是 132MB 瞬时内存。12 个线程同时撞上几张这种图，
# 峰值直接上 GB —— 这正是「点一下重新扫描，程序就崩了」的内存放大器。
# 闸门只限制并发数，不改变任何一张图的解码路径，因此指纹结果与旧版逐字节一致。
BIG_GATE_PX = int(os.environ.get('FP_BIG_GATE_PX') or 4000000)
BIG_GATE_N = int(os.environ.get('FP_BIG_GATE') or 2)
_big_gate = threading.Semaphore(max(1, BIG_GATE_N))


def avail_mb():
    """系统可用物理内存（MB）；取不到返回 None。零第三方依赖，直接调 Win32。"""
    try:
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                        ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                        ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                        ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                        ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]
        st = MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return None
        return int(st.ullAvailPhys // (1024 * 1024))
    except Exception:
        return None


def self_peak_mb():
    """本进程的**峰值**工作集（MB）。用 GetProcessMemoryInfo 取真实峰值，不靠外部轮询采样 —— 
    外部每 100ms 采一次的脚本对几秒就结束的批次根本采不到峰值，会得出「改前 0MB」这种荒唐数字。
    失败返回 None。用于把「解码并发到底吃了多少内存」变成可核对的事实。"""
    try:
        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [('cb', ctypes.c_ulong), ('PageFaultCount', ctypes.c_ulong),
                        ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]
        k32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        pmc = PROCESS_MEMORY_COUNTERS()
        pmc.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        # 必须显式声明参数类型：GetCurrentProcess 返回的伪句柄是 64 位无符号值，
        # 不声明 argtypes 时 ctypes 会按默认 32 位 int 转换并抛
        # OverflowError: int too long to convert，函数整个失败（返回 None）。
        psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), ctypes.c_ulong]
        # 注意 argtypes 里的结构体类型必须与 byref 传入的是**同一个类对象**，
        # 否则 ctypes 会因类型标识不同而报 TypeError: expected LP_... instance
        psapi.GetProcessMemoryInfo.restype = ctypes.c_int
        if not psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
            return None
        return int(pmc.PeakWorkingSetSize // (1024 * 1024))
    except Exception:
        return None


def decode_limit_mb():
    """整个线程池允许占用的内存上限：可用内存的 60%，至少 256MB。FP_MEM_LIMIT_MB 可覆盖。"""
    override = int(os.environ.get('FP_MEM_LIMIT_MB') or 0)
    if override > 0:
        return override
    free = avail_mb()
    if free is None:
        return 1024
    return max(256, int(free * 0.6))


def pick_workers():
    """按可用内存收缩线程数：线程数 × 每槽预留 不得超过内存预算。

    旧写死 max(4, min(12, cpu*2))：在空闲内存只剩 1GB 出头的机器上，12 个槽位
    同时解码大图会把内存打到 700MB 以上，是「点重新扫描就崩」的内存放大器之一。
    FP_WORKERS 显式指定时直接生效（复现脚本据此做「改前 12 / 改后自动」的对照）。
    """
    override = int(os.environ.get('FP_WORKERS') or 0)
    if override > 0:
        return max(1, override)
    cpu = os.cpu_count() or 4
    natural = max(4, min(12, cpu * 2))
    room = decode_limit_mb() // max(1, PER_WORKER_MB)
    return max(1, min(natural, room))


def sig_of(paths):
    """源文件签名：mtime(毫秒) + 总字节数 + 张数。任一变化都视为需要重算。"""
    newest = 0.0
    total = 0
    n = 0
    for p in paths:
        try:
            st = os.stat(p)
            if st.st_mtime > newest:
                newest = st.st_mtime
            total += st.st_size
            n += 1
        except OSError:
            pass
    return '%d:%d:%d' % (int(newest * 1000), total, n)


def job_sig(d, files):
    """任务签名：路径过滤口径必须与 dump() 完全一致，否则跳过判定会错。"""
    paths = [os.path.join(d, f) for f in files]
    paths = [p for p in paths if os.path.isfile(p)]
    if not paths:
        return ''
    return SPEC + '|' + sig_of(paths)


def load_sigs(path):
    try:
        with open(path, encoding='utf-8') as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def dump(job):
    # sig = 当前磁盘签名，prev = 上次落盘的签名；两者都由主进程算好随任务传进来
    kind, k, d, files, out, sig, prev = job
    # extra：本任务的细粒度计数（丢失/超大/最大像素），由主线程汇总，不做线程内累加（会race）
    extra = {'declared': 0, 'missing': 0, 'big': 0, 'peakpx': 0}
    declared = len(files)
    paths = [os.path.join(d, f) for f in files]
    paths = [p for p in paths if os.path.isfile(p)]
    extra['declared'] = declared
    extra['missing'] = declared - len(paths)
    if not paths:
        return (kind, k, 0, 0, 'empty', None, extra)
    if (not FORCE) and prev and os.path.exists(out) and prev == sig:
        return (kind, k, 0, 0, 'skip', sig, extra)
    # 临时名必须带线程号：改用线程池后，同一进程内多个 worker 共享 pid，
    # 只用 pid 会让并发任务写到同一个临时文件上互相覆盖。
    tmp = out + '.tmp' + str(os.getpid()) + '_' + str(threading.get_ident())
    ok = fail = 0
    try:
        os.makedirs(os.path.dirname(out), exist_ok=True)
    except OSError:
        pass
    try:
        with open(tmp, 'wb') as fh:
            fh.write(struct.pack('<i', len(paths)))
            for p in paths:
                try:
                    # 必须用 with：解码到一半抛错时半开的大图会把句柄与解码缓冲拖到进程结束，
                    # 12 个线程叠起来就是几百 MB 的常驻（旧写法裸 Image.open 的坑）。
                    with Image.open(p) as im:
                        try:
                            im.draft('L', (DECODE_TO, DECODE_TO))
                        except Exception:
                            pass
                        w, h = im.size
                        px = w * h
                        if px > extra['peakpx']:
                            extra['peakpx'] = px
                        if px > BIG_PX:
                            # 超大图必须留痕：draft 只对 JPEG 生效，PNG/webp 会被全尺寸解码
                            extra['big'] += 1
                            with _big_lock:
                                if _big_lines[0] < BIG_LOG_MAX:
                                    _big_lines[0] += 1
                                    sys.stdout.write('BIGIMG %d x %d %.1fMP %s\n' % (w, h, px / 1048576.0, p))
                                    sys.stdout.flush()
                        # 大图走闸门：同一时刻全进程最多 BIG_GATE_N 张在解码，
                        # 把峰值从「线程数 × 单图内存」压成「BIG_GATE_N × 单图内存」。
                        big = px > BIG_GATE_PX
                        if big:
                            _big_gate.acquire()
                        try:
                            g = im.convert('L').resize((32, 32), Image.LANCZOS).tobytes()
                        finally:
                            if big:
                                _big_gate.release()
                        if len(g) != 1024:
                            raise ValueError('bad size')
                except Exception:
                    fail += 1
                    continue
                name = os.path.basename(p).encode('utf-8')
                fh.write(struct.pack('<i', len(name)))
                fh.write(name)
                fh.write(struct.pack('<ii', w, h))
                fh.write(g)
                ok += 1
        os.replace(tmp, out)
    except Exception:
        return (kind, k, 0, len(paths), 'fail', None, extra)
    return (kind, k, ok, fail, 'done', sig, extra)


SIGS = {}


def settle_extra(stats, extra):
    """把单个任务返回的细粒度计数汇总进 stats（主线程串行调用，无需加锁）。"""
    if not extra:
        return
    stats['missing'] = stats.get('missing', 0) + int(extra.get('missing') or 0)
    stats['bigimg'] = stats.get('bigimg', 0) + int(extra.get('big') or 0)
    px = int(extra.get('peakpx') or 0)
    if px > stats.get('peakpx', 0):
        stats['peakpx'] = px


def main():
    global SIGS
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    lib_fp = spec['libFp']
    dup_fp = spec['dupFp']
    jobs = [tuple(j) for j in (spec.get('jobs') or [])]
    index = spec.get('index') or []
    only = ''
    for i, a in enumerate(sys.argv):
        if a == '--only' and i + 1 < len(sys.argv):
            only = sys.argv[i + 1]
    if only in ('lib', 'dup'):
        jobs = [j for j in jobs if j[0] == only]
    try:
        os.makedirs(lib_fp, exist_ok=True)
        os.makedirs(dup_fp, exist_ok=True)
    except OSError:
        pass

    # 每个目录一份签名表；规格版本不符即整体作废（触发重建）
    stamp = spec.get('spec') or SPEC
    lib_sigs = load_sigs(os.path.join(lib_fp, 'sigs.json'))
    dup_sigs = load_sigs(os.path.join(dup_fp, 'sigs.json'))
    if lib_sigs.get('__spec') != stamp:
        lib_sigs = {'__spec': stamp}
    if dup_sigs.get('__spec') != stamp:
        dup_sigs = {'__spec': stamp}
    SIGS = dict(lib_sigs)
    SIGS.update(dup_sigs)

    # 签名在主进程统一算好（子进程拿到的是空全局，必须随任务传参），
    # 并把「上次落盘的签名」一并带上，由子进程做跳过判定。
    jobs = [(j[0], j[1], j[2], j[3], j[4], job_sig(j[2], j[3]), SIGS.get(j[1])) for j in jobs]

    json.dump(index, open(os.path.join(lib_fp, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    total = len(jobs)
    print('任务: lib=%d dup=%d 共 %d（规格 %s, 解码 %d）' % (
        sum(1 for j in jobs if j[0] == 'lib'), sum(1 for j in jobs if j[0] == 'dup'), total, stamp, DECODE_TO), flush=True)
    if total == 0:
        print('DONE {"done": 0}', flush=True)
        return

    # 用线程池而不是进程池：Pillow 的解码（libjpeg-turbo / libwebp）在 C 层释放 GIL，
    # 线程真能并行，还省掉进程池每批建池/序列化的开销。
    # 实测（本机 4 物理核 8 逻辑核，交替 A/B 取中位数）：
    #   库侧（jpg 为主）进程池 2.08x → 线程池 3.45x；查重侧（webp 为主）进程池 2.70x → 线程池 3.70x。
    from concurrent.futures import ThreadPoolExecutor

    # 解码是「CPU + I/O 混合」，线程数略高于逻辑核数反而更快，但**并发槽位会同时持有解码缓冲**：
    # 单槽实测峰值约 26MB，12 槽叠加就是 700MB 级 —— 空闲内存不足时直接被 OOM/看护杀掉。
    # 因此线程数改为按可用内存收缩，见 pick_workers()。FP_WORKERS 可显式覆盖（复现脚本用）。
    workers = pick_workers()
    t0 = time.time()
    stats = {'done': 0, 'skip': 0, 'fail': 0, 'empty': 0, 'imgs': 0, 'badimg': 0,
             'missing': 0, 'bigimg': 0, 'peakpx': 0, 'oom': 0}
    print('并发: 线程 %d（每槽预留 %dMB，内存预算 %dMB，可用 %sMB，CPU %d）'
          % (workers, PER_WORKER_MB, decode_limit_mb(), avail_mb(), os.cpu_count() or 0), flush=True)
    # 线程池每批重建；BATCH 决定进度上报与签名落盘的粒度（不必太大）
    BATCH = int(os.environ.get('FP_BATCH') or 400)
    done_n = 0
    for i in range(0, total, BATCH):
        batch = jobs[i:i + BATCH]
        # 已在本批次内成功结算的任务数。池子中途抛错时只能从这里往后补做，
        # 否则整批重跑会把已完成的任务重复计数（stats 虚高）。
        settled = 0
        # 用 with 保证「这一批全部 join 完」再进下一批：旧写法虽然也 join，
        # 但 join 之后解码缓冲仍留在 allocator 里，必须再加一次 gc.collect() 才真的还给系统。
        try:
            with ThreadPoolExecutor(max_workers=workers) as ex:
                for kind, k, ok, fail, st, sig, extra in ex.map(dump, batch):
                    stats[st] = stats.get(st, 0) + 1
                    stats['imgs'] += ok
                    stats['badimg'] += fail
                    settle_extra(stats, extra)
                    if sig:
                        SIGS[k] = sig
                    settled += 1
                    done_n += 1
        except Exception as exc:
            print('  批次 %d 异常（%s），从第 %d 个起逐个补做…' % (i // BATCH, exc, settled), flush=True)
            for job in batch[settled:]:
                try:
                    kind, k, ok, fail, st, sig, extra = dump(job)
                    stats[st] = stats.get(st, 0) + 1
                    stats['imgs'] += ok
                    stats['badimg'] += fail
                    settle_extra(stats, extra)
                    if sig:
                        SIGS[k] = sig
                except MemoryError:
                    # 内存不够时不能装作「没事」继续：清出空间后让下一批再试，
                    # 并把 oom 计数落进 DONE，前端/日志能直接看见。
                    stats['oom'] = stats.get('oom', 0) + 1
                    gc.collect()
                except Exception:
                    stats['fail'] = stats.get('fail', 0) + 1
                done_n += 1
        settled = 0
        # 每批结束显式回收：解码出的大图缓冲不属于 Python 对象图，只有触发一次 gc
        # 才会把峰值还回去（实测线程池把峰值打到 693MB、结束后常驻仍 25MB）。
        gc.collect()
        print('PROGRESS %d %d' % (done_n, total), flush=True)
        # 每批落一次签名表，中途被中止也不会让已完成的工作全部白费
        try:
            ls = {'__spec': stamp}
            ds = {'__spec': stamp}
            for j in jobs:
                k = j[1]
                if k in SIGS:
                    (ls if j[0] == 'lib' else ds)[k] = SIGS[k]
            json.dump(ls, open(os.path.join(lib_fp, 'sigs.json'), 'w', encoding='utf-8'))
            json.dump(ds, open(os.path.join(dup_fp, 'sigs.json'), 'w', encoding='utf-8'))
        except Exception:
            pass

    stats['seconds'] = round(time.time() - t0, 1)
    # 把本进程峰值工作集记进统计：内存问题是这次事故的核心，必须是可核对的数字，
    # 不能依赖外部脚本按固定间隔轮询（几秒的批次根本采不到峰值）。
    peak_ws = self_peak_mb()
    if peak_ws is not None:
        stats['peak_ws_mb'] = peak_ws
    # 失败可见性：这条汇总行与 DONE 不同，会被 onLine 当作普通日志转出去；
    # 同时落一份到 lib_fp/build-fp-report.txt —— pipeline 目前没有把 onLog 传下来，
    # 只打 stdout 会被丢掉，落盘才能事后查（丢失/超大/OOM 都必须看得见）。
    report = ('统计 图片 %d 张 · 声明但缺失 %d · 超大图 %d 张(%dMP 以上) · 最大 %.1fMP · OOM %d · 失败单元 %d · 耗时 %.1fs'
              % (stats['imgs'], stats['missing'], stats['bigimg'], BIG_GATE_PX // 1048576,
                 (stats.get('peakpx') or 0) / 1048576.0, stats['oom'], stats['fail'], stats['seconds']))
    print(report, flush=True)
    try:
        with open(os.path.join(lib_fp, 'build-fp-report.txt'), 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(stats, ensure_ascii=False, indent=2) + '\n')
    except Exception:
        pass
    print('PEAKWS %d' % (stats.get('peak_ws_mb') or 0), flush=True)
    print('DONE ' + json.dumps(stats, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
