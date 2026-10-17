// ============================================================
//  漫库 MangaVault · Windows 原生宿主（desktop/host/Program.cs）
//
//  职责：
//    1. 自己拉起内置 Node 后端（隐藏窗口），等待 /api/ping 通过
//    2. 用 WebView2 打开界面（窗口即应用，不是浏览器外壳）
//    3. 提供原生能力：打开外部链接 / 资源管理器定位 / 原生选目录 / 退出
//    4. 关闭窗口 = 退出，并回收后端子进程（不留孤儿 node）
//
//  编译：C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe（系统自带，C# 5）
//        必须带 /codepage:65001，否则文件的 UTF-8 中文会被按 ANSI 解析成乱码。
//  运行：MangaVault.exe [--selftest] [--selftest-ms=40000] [--data-dir=DIR] [--trace=FILE]
//
//  ★ 两个必须遵守的历史坑（否则进程静默秒退、无任何报错）：
//      a) Microsoft.Web.WebView2.Core.dll / Microsoft.Web.WebView2.WinForms.dll
//         必须与 exe 同目录，CLR 在 JIT Main 时才能解析类型。
//      b) 绝不能在 UI 线程上 .Result / .Wait() 等待 WebView2 的异步 API
//         —— WebView2 的回调要回到 UI 线程，阻塞 UI 线程会自我死锁
//         （_spike 里的参考实现就卡死在 ENV-OK 之后，实测进程永不退出）。
//         本实现全部使用 ContinueWith(..., TaskScheduler.FromCurrentSynchronizationContext())。
//
//  启动即写 trace 文件：进程若在 Main 里静默死掉，也能从 trace 的最后一行定位。
// ============================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MangaVaultHost
{
  internal static class Program
  {
    /* ---------- 常量 ---------- */
    private const string APP_TITLE = "漫库 MangaVault";
    private const string APP_VERSION = "1.0.0";
    private const int BASE_W = 1440;
    private const int BASE_H = 900;
    private const int MIN_W = 1024;
    private const int MIN_H = 640;
    private const int MAX_W = 16000;
    private const int MAX_H = 16000;
    private const int BOOT_TIMEOUT_MS = 60000;
    private const int SELFTEST_DEFAULT_MS = 40000;
    private const int BRIDGE_LONGPOLL_MS = 25000;
    private const int BRIDGE_IDLE_MS = 1200;
    private const int PING_INTERVAL_MS = 3000;
    private const int PING_MAX_FAILS = 4;
    private const int TRACE_MAX_BYTES = 262144;
    /* 「后端在忙」的声明文件（由 src/core/heartbeat.mjs 写）。文件里是绝对时间戳 until，
       过点即自然失效；宿主只读不删，避免 Windows 上删除被占用文件抛 EPERM。 */
    private const string SILENCE_FILE = "backend-silence.json";

    /** 前端探针：确认页面真的渲染出来了（取标题/元素数/图片数） */
    private const string PROBE_JS =
      "(function(){try{return JSON.stringify({title:document.title,ready:document.readyState," +
      "elems:document.getElementsByTagName('*').length,imgs:document.images.length," +
      "links:document.querySelectorAll('a[href]').length});}catch(e){return 'PROBE-ERR '+e.message;}})()";

    /* ---------- 状态 ---------- */
    private static string baseDir;
    private static string appDir;
    private static string dataDir;
    private static string tracePath;
    private static string windowFile;
    private static Process server;
    private static int port;
    private static bool selftest;
    private static int selftestMs = SELFTEST_DEFAULT_MS;
    private static string argDataDir = null;
    private static string argTrace = null;
    private static Form form;
    private static WebView2 wv;
    private static Label bootLabel;
    private static System.Windows.Forms.Timer overallTimer;
    private static System.Threading.Timer bridgeTimer;
    private static int pingFails;
    /* 静默窗口只记录一次（避免 3 秒一条把 trace 刷满），窗口消失时复位。 */
    private static bool silenceLogged;
    private static int bridgeBusy;   // 0/1：同一时刻只允许一个长轮询线程
    private static volatile bool dumped;
    private static volatile bool quitting;
    /** 自检：原生能力桥往返探测的结果 */
    private static volatile bool bridgeProbeOk;
    private static readonly object dumpLock = new object();
    private static readonly object traceLock = new object();
    /** 写 trace 文件（AppendRaw）的独占锁：多个线程会同时写同一文件，缺锁会互相踩踏。 */
    private static readonly object fileLock = new object();
    private static readonly List<string> logLines = new List<string>();
    private static IntPtr jobHandle = IntPtr.Zero;
    private static readonly Stopwatch clock = Stopwatch.StartNew();

    /* ============================================================
     *  入口
     * ============================================================ */
    [STAThread]
    private static void Main(string[] args)
    {
      baseDir = AppDomain.CurrentDomain.BaseDirectory;

      /* --- 第一件事：解析参数并立刻写 trace，保证「启动即留痕」 --- */
      ParseArgs(args);
      appDir = Directory.Exists(Path.Combine(baseDir, "app")) ? Path.Combine(baseDir, "app") : baseDir;
      dataDir = string.IsNullOrEmpty(argDataDir) ? Path.Combine(baseDir, "data") : Path.GetFullPath(argDataDir.Trim('"'));
      tracePath = string.IsNullOrEmpty(argTrace) ? Path.Combine(dataDir, "host-trace.txt") : Path.GetFullPath(argTrace.Trim('"'));
      try { if (File.Exists(tracePath)) File.Delete(tracePath); } catch { }
      try { Directory.CreateDirectory(dataDir); } catch { }
      windowFile = Path.Combine(dataDir, "window.json");

      Trace("BOOT pid=" + Process.GetCurrentProcess().Id + " selftest=" + selftest);
      Trace("TITLE " + APP_TITLE);
      Trace("VERSION " + APP_VERSION);
      Trace("DIRS base=" + baseDir + " app=" + appDir + " data=" + dataDir);

      AppDomain.CurrentDomain.UnhandledException += delegate (object s, UnhandledExceptionEventArgs e)
      {
        Trace("FATAL " + Describe(e.ExceptionObject));
        Dump("FATAL");
      };
      Application.ThreadException += delegate (object s, ThreadExceptionEventArgs e)
      {
        Trace("UI-THREAD-EXCEPTION " + Describe(e.Exception));
      };

      try { SetProcessDPIAware(); } catch { }
      try
      {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
      }
      catch (Exception ex) { Trace("APPLICATION-INIT-FAIL " + ex.Message); }

      /* --- 1. 选一个空闲端口并拉起后端 --- */
      port = PickFreePort(8775);
      if (port <= 0) { Trace("PORT-UNAVAILABLE"); Dump("NOPORT"); return; }
      Trace("PORT-CHOSEN " + port);

      string node = FindNode();
      Trace("NODE " + (node == null ? "(not-found)" : node));
      string serverFile = Path.Combine(appDir, "src", "server.mjs");
      if (!File.Exists(serverFile)) { Trace("SERVER-MISSING " + serverFile); Dump("NOSERVER"); return; }
      if (node == null) { Trace("NODE-MISSING"); Dump("NONODE"); return; }

      StartServer(node, serverFile);
      bool ready = WaitForHttp(port, BOOT_TIMEOUT_MS);
      Trace("BOOT-PING " + ready);
      if (!ready) { Trace("BOOT-TIMEOUT"); Dump("BOOTFAIL"); return; }

      /* --- 2. 建窗口 --- */
      BuildWindow();

      if (selftest)
      {
        overallTimer = new System.Windows.Forms.Timer();
        overallTimer.Interval = Math.Max(5000, selftestMs);
        overallTimer.Tick += delegate { Trace("TIMEOUT " + overallTimer.Interval); Dump("TIMEOUT"); };
        overallTimer.Start();
      }

      form.Shown += delegate
      {
        Trace("SHOWN");
        StartWebView();
      };

      /* --- 3. 后端存活看护 + 原生能力桥长轮询（同一个线程池定时器驱动） --- */
      bridgeTimer = new System.Threading.Timer(delegate { WatchdogTick(); }, null, 1000, PING_INTERVAL_MS / 3);

      Trace("RUNNING");
      try { Application.Run(form); }
      catch (Exception ex) { Trace("RUN-FAIL " + Describe(ex)); }

      Trace("MAIN-AFTER-RUNLOOP");
      Shutdown("窗口已关闭");
    }

    /* ============================================================
     *  参数 / 路径
     * ============================================================ */
    private static void ParseArgs(string[] args)
    {
      if (args == null) return;
      foreach (string a in args)
      {
        if (a == "--selftest") { selftest = true; continue; }
        if (a.StartsWith("--selftest-ms="))
        {
          int v;
          if (int.TryParse(a.Substring("--selftest-ms=".Length), out v) && v > 1000) selftestMs = v;
          continue;
        }
        if (a.StartsWith("--data-dir=")) { argDataDir = a.Substring("--data-dir=".Length); continue; }
        if (a.StartsWith("--trace=")) { argTrace = a.Substring("--trace=".Length); continue; }
      }
    }

    /** 优先用随身 node（绿色包），其次系统安装的 node */
    private static string FindNode()
    {
      string local = Path.Combine(baseDir, "node", "node.exe");
      if (File.Exists(local)) return local;
      string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
      string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
      string[] cands = new string[] {
        Path.Combine(pf, "nodejs", "node.exe"),
        Path.Combine(pf86, "nodejs", "node.exe")
      };
      foreach (string c in cands) if (File.Exists(c)) return c;
      return null;
    }

    /** 从 start 起找一个能绑定的回环端口；全被占用返回 0 */
    private static int PickFreePort(int start)
    {
      for (int i = 0; i < 20; i++)
      {
        int p = start + i;
        TcpListener l = null;
        try
        {
          l = new TcpListener(IPAddress.Loopback, p);
          l.Start();
          l.Stop();
          return p;
        }
        catch { }
        finally { if (l != null) { try { l.Stop(); } catch { } } }
      }
      return 0;
    }

    /* ============================================================
     *  后端进程
     * ============================================================ */
    private static void StartServer(string node, string serverFile)
    {
      try
      {
        ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + serverFile + "\"");
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.EnvironmentVariables["MV_DATA_DIR"] = dataDir;
        psi.EnvironmentVariables["MV_DESKTOP"] = "1";
        /* ★ 必须把选定的端口显式告诉后端。
           宿主先用 PickFreePort 挑一个空闲端口并轮询它，后端却只读 config.port；
           一旦 config.port 被别的实例占着，后端会 listenWithFallback 落到另一个端口，
           宿主就永远 ping 不到自己那个端口 —— 实测表现为 BOOT-PING False → BOOT-TIMEOUT →
           SHUTDOWN/DONE BOOTFAIL。以前 8775 恰好空闲时两边都解析成 8775，纯属巧合，
           本契约漏洞因此长期潜伏。MV_PORT 优先级高于 config.port（见 src/server.mjs 顶部）。 */
        psi.EnvironmentVariables["MV_PORT"] = port.ToString();
        server = Process.Start(psi);
        Trace("SERVER-PID " + (server == null ? "(null)" : server.Id.ToString()));
        if (server != null)
        {
          try { server.EnableRaisingEvents = true; } catch { }
          AttachToJob(server);
        }
      }
      catch (Exception ex)
      {
        Trace("SERVER-FAIL " + Describe(ex));
      }
    }

    /** 轮询 GET /api/ping，直到返回 MangaVault 或超时 */
    private static bool WaitForHttp(int p, int timeoutMs)
    {
      Stopwatch sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < timeoutMs)
      {
        if (server != null && server.HasExited)
        {
          Trace("SERVER-EXITED-EARLY code=" + SafeExitCode());
          return false;
        }
        string body = TryGet("http://127.0.0.1:" + p + "/api/ping", 1200);
        if (body != null && body.IndexOf("MangaVault") >= 0) return true;
        Thread.Sleep(250);
      }
      return false;
    }

    private static int SafeExitCode()
    {
      try { return server == null ? -1 : server.ExitCode; } catch { return -1; }
    }

    /**
     * 收掉后端：先 Kill，再兜底 taskkill /T /F（连子进程），最后确认它真的没了。
     * Job Object（见 AttachToJob）是最后一道保险：本进程无论怎么死，句柄关闭即连坐。
     * 返回 true 表示确认没有残留进程。
     */
    private static bool KillServer()
    {
      if (server == null) { Trace("SERVER-KILL n/a"); return true; }
      try
      {
        if (!server.HasExited)
        {
          try { server.Kill(); } catch (Exception ex) { Trace("SERVER-KILL-ERR " + ex.Message); }
          try { server.WaitForExit(5000); } catch { }
          bool stillUp = false;
          try { stillUp = !server.HasExited; } catch { }
          if (stillUp)
          {
            Trace("SERVER-KILL taskkill-fallback pid=" + server.Id);
            try
            {
              ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/PID " + server.Id + " /T /F");
              psi.UseShellExecute = false;
              psi.CreateNoWindow = true;
              Process tk = Process.Start(psi);
              if (tk != null) tk.WaitForExit(6000);
            }
            catch (Exception ex) { Trace("SERVER-TASKKILL-ERR " + ex.Message); }
          }
        }
      }
      catch (Exception ex) { Trace("SERVER-KILL-OUTER " + ex.Message); }
      return ServerAliveNow();
    }

    /** 复核后端是否真的没了。★ 由调用方在 KillServer() 之后**另行**调用并打证据，
        不能塞进 KillServer 里打：那样「SERVER-ALIVE-AFTER-KILL」就会出现在
        「SHUTDOWN <status>」之前，看起来像收尾开始前就已经杀过一遍。 */
    private static bool ServerAliveNow()
    {
      bool alive = false;
      try { alive = server != null && !server.HasExited; } catch { }
      return alive;
    }

    /* ============================================================
     *  Job Object：进程级连坐回收（防孤儿 node）
     * ============================================================ */
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
      public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
      public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private const int JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;

    /** 把 node 挂进一个「宿主一死就跟着死」的 Job Object */
    private static void AttachToJob(Process p)
    {
      try
      {
        if (jobHandle == IntPtr.Zero) jobHandle = CreateJobObject(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero) { Trace("JOB-CREATE-FAIL"); return; }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buf = Marshal.AllocHGlobal(len);
        try
        {
          Marshal.StructureToPtr(info, buf, false);
          if (!SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, buf, (uint)len))
          {
            Trace("JOB-SETINFO-FAIL");
            return;
          }
        }
        finally { Marshal.FreeHGlobal(buf); }
        bool ok = AssignProcessToJobObject(jobHandle, p.Handle);
        Trace("JOB-ASSIGN " + ok);
      }
      catch (Exception ex) { Trace("JOB-FAIL " + ex.Message); }
    }

    /* ============================================================
     *  窗口
     * ============================================================ */
    private static void BuildWindow()
    {
      form = new Form();
      form.Text = APP_TITLE;
      form.MinimumSize = new Size(MIN_W, MIN_H);
      form.BackColor = Color.FromArgb(18, 16, 22);
      form.Icon = LoadIcon();

      bootLabel = new Label();
      bootLabel.Dock = DockStyle.Fill;
      bootLabel.TextAlign = ContentAlignment.MiddleCenter;
      bootLabel.ForeColor = Color.FromArgb(232, 228, 216);
      bootLabel.BackColor = Color.FromArgb(18, 16, 22);
      try { bootLabel.Font = new Font("Microsoft YaHei UI", 12f); } catch { }
      bootLabel.Text = "漫库正在启动…" + Environment.NewLine + "http://127.0.0.1:" + port + "/";
      form.Controls.Add(bootLabel);

      wv = new WebView2();
      wv.Dock = DockStyle.Fill;
      wv.Visible = false;
      try { wv.DefaultBackgroundColor = Color.FromArgb(18, 16, 22); } catch { }
      form.Controls.Add(wv);

      LoadWindow();

      if (selftest)
      {
        // 自检时不进任务栏、不抢焦点，但保持真实可见（WebView2 需要真实渲染）
        form.ShowInTaskbar = false;
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(40, 40);
      }

      form.FormClosing += delegate
      {
        quitting = true;
        Trace("FORM-CLOSING");
        SaveWindow();
      };
      form.FormClosed += delegate
      {
        Trace("FORM-CLOSED-EVENT");
        Shutdown("窗口已关闭");
      };
    }

    private static Icon LoadIcon()
    {
      try
      {
        string ico = Path.Combine(baseDir, "icon.ico");
        if (File.Exists(ico)) return new Icon(ico);
      }
      catch { }
      return null;
    }

    /** 读取 data/window.json 并还原窗口几何；越界或缺失则主屏居中 */
    private static void LoadWindow()
    {
      int w = BASE_W, h = BASE_H, x = int.MinValue, y = int.MinValue;
      bool max = false;
      string text = null;
      try { if (File.Exists(windowFile)) text = File.ReadAllText(windowFile, new UTF8Encoding(false)); }
      catch (Exception ex) { Trace("WINDOW-READ-FAIL " + ex.Message); }
      if (!string.IsNullOrEmpty(text))
      {
        w = JsonInt(text, "width", BASE_W);
        h = JsonInt(text, "height", BASE_H);
        x = JsonInt(text, "x", int.MinValue);
        y = JsonInt(text, "y", int.MinValue);
        max = JsonBool(text, "maximized", false);
      }
      w = Math.Max(MIN_W, Math.Min(MAX_W, w));
      h = Math.Max(MIN_H, Math.Min(MAX_H, h));
      form.Size = new Size(w, h);

      bool onScreen = false;
      if (x != int.MinValue && y != int.MinValue)
      {
        Rectangle want = new Rectangle(x, y, w, h);
        foreach (Screen s in Screen.AllScreens)
        {
          Rectangle hit = Rectangle.Intersect(s.WorkingArea, want);
          if (hit.Width >= 160 && hit.Height >= 100) { onScreen = true; break; }
        }
      }
      if (onScreen) { form.StartPosition = FormStartPosition.Manual; form.Location = new Point(x, y); }
      else { form.StartPosition = FormStartPosition.CenterScreen; }
      if (max) form.WindowState = FormWindowState.Maximized;
      Trace("WINDOW-RESTORE w=" + w + " h=" + h + " x=" + (onScreen ? x.ToString() : "center") +
        " y=" + (onScreen ? y.ToString() : "center") + " max=" + max);
    }

    /** 落盘窗口几何（最大化时记 RestoreBounds，恢复时不会跳成满屏尺寸） */
    private static void SaveWindow()
    {
      try
      {
        Rectangle b;
        if (form.WindowState == FormWindowState.Normal) b = form.Bounds;
        else b = form.RestoreBounds;
        if (b.Width < MIN_W || b.Height < MIN_H)
        {
          Rectangle fallback = new Rectangle(form.Location, form.Size);
          if (fallback.Width >= MIN_W && fallback.Height >= MIN_H) b = fallback;
          else b = form.RestoreBounds;
        }
        string json = "{" +
          "\"width\":" + b.Width + "," +
          "\"height\":" + b.Height + "," +
          "\"x\":" + b.X + "," +
          "\"y\":" + b.Y + "," +
          "\"maximized\":" + ((form.WindowState == FormWindowState.Maximized) ? "true" : "false") + "," +
          "\"updatedAt\":" + Lit(DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss")) +
          "}";
        WriteAtomic(windowFile, json);
        Trace("WINDOW-SAVED " + b.Width + "x" + b.Height + "+" + b.X + "+" + b.Y);
      }
      catch (Exception ex) { Trace("WINDOW-SAVE-FAIL " + ex.Message); }
    }

    private static void WriteAtomic(string file, string text)
    {
      string tmp = file + ".tmp";
      File.WriteAllText(tmp, text, new UTF8Encoding(false));
      if (File.Exists(file)) File.Delete(file);
      File.Move(tmp, file);
    }

    /* ============================================================
     *  WebView2（全程非阻塞：绝不在 UI 线程等待）
     * ============================================================ */
    private static void StartWebView()
    {
      string udf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MangaVault", "webview");
      try { Directory.CreateDirectory(udf); } catch (Exception ex) { Trace("UDF-CREATE-FAIL " + ex.Message); }
      Trace("UDF " + udf);

      Task<CoreWebView2Environment> task;
      try { task = CoreWebView2Environment.CreateAsync(null, udf, null); }
      catch (Exception ex) { Trace("ENV-CALL-FAIL " + Describe(ex)); Dump("INITFAIL"); return; }

      task.ContinueWith(delegate (Task<CoreWebView2Environment> t)
      {
        if (t.IsFaulted || t.IsCanceled)
        {
          Trace("ENV-FAIL " + Describe(t.Exception));
          Dump("INITFAIL");
          return;
        }
        CoreWebView2Environment env = t.Result;
        Trace("ENV-OK version=" + env.BrowserVersionString);
        EnsureWebView(env);
      }, TaskScheduler.FromCurrentSynchronizationContext());
    }

    private static void EnsureWebView(CoreWebView2Environment env)
    {
      wv.EnsureCoreWebView2Async(env).ContinueWith(delegate (Task t)
      {
        if (t.IsFaulted || t.IsCanceled)
        {
          Trace("WV2-FAIL " + Describe(t.Exception));
          Dump("INITFAIL");
          return;
        }
        Trace("WV2-READY");
        try
        {
          CoreWebView2 core = wv.CoreWebView2;
          Trace("WV2-UDF " + core.Environment.UserDataFolder);
          core.NavigationCompleted += OnNavigationCompleted;
          core.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs e)
          {
            // 页面里的 target=_blank 一律交给系统默认程序，不在窗口内再开窗口
            e.Handled = true;
            Trace("NEWWINDOW " + e.Uri);
            string r = OpenExternal(e.Uri);
            if (r.IndexOf("\"ok\":true") == 0) { /* 已打开 */ }
          };
          core.ProcessFailed += delegate (object s, CoreWebView2ProcessFailedEventArgs e)
          {
            Trace("WV2-PROCESS-FAILED " + e.ProcessFailedKind);
          };
        }
        catch (Exception ex) { Trace("WV2-HOOK-FAIL " + ex.Message); }

        wv.Visible = true;
        if (bootLabel != null) bootLabel.Visible = false;
        string url = "http://127.0.0.1:" + port + "/";
        Trace("NAVIGATE " + url);
        try { wv.CoreWebView2.Navigate(url); }
        catch (Exception ex) { Trace("NAVIGATE-FAIL " + ex.Message); Dump("INITFAIL"); }
      }, TaskScheduler.FromCurrentSynchronizationContext());
    }

    /* ============================================================
     *  自检专用：原生能力桥的真实往返探测
     *
     *  这条是「原生能力到底能不能用」的硬证据：它让宿主**真的**去执行一次
     *  pick-dir 命令（自检模式下 PickDir 不弹框、直接返回「用户取消」），
     *  从而证明「宿主的轮询线程 -> 后端队列 -> 命令下发 -> 宿主执行 -> 回执 -> 后端销账」
     *  整条链路是通的，而不是只证明 HTTP 端口开着。
     * ============================================================ */
    private static void ProbeBridge()
    {
      /* ★ 两个必须记住的坑：
         1) CoreWebView2 的成员只能在 UI 线程调用，否则抛
            "CoreWebView2 members can only be accessed from the UI thread"。
         2) ExecuteScriptAsync **不会等待 JS Promise**：往页面里塞一个 async IIFE，
            拿回来的是 Promise 序列化成的 "{}"，而不是结果 —— 这里已真实踩到。
         因此探测走纯 HTTP。它同样能证明「后端队列 -> 宿主轮询线程 -> 执行 -> 回执」整条链路，
         而且不依赖页面 JS 语义。只有阻塞的 HTTP 被丢到线程池。 */
      Task.Run(delegate
      {
        bool attached = false;
        string mode = null;
        try
        {
          string info = TryGet("http://127.0.0.1:" + port + "/api/desktop/info", 5000);
          Trace("BRIDGE-INFO " + Short(info));
          mode = JsonStr(info, "mode");
          attached = info != null && info.IndexOf("\"attached\":true") >= 0;
          Trace("BRIDGE-ATTACHED " + attached + " mode=" + mode);
        }
        catch (Exception ex2) { Trace("BRIDGE-INFO-FAIL " + Describe(ex2)); }

        /* 真的 POST 一次 pick-dir：后端会挂起它，宿主自己的轮询线程取走并执行。
           自检模式下 PickDir 不弹框，直接返回「用户取消」-> 后端映射成 409。 */
        bool cancelled = false;
        try
        {
          int status = 0;
          string body = TryPostResp("http://127.0.0.1:" + port + "/api/desktop/pick-dir",
            "{\"title\":\"原生能力自检\"}", 45000, out status);
          Trace("BRIDGE-PICKDIR status=" + status + " body=" + Short(body));
          cancelled = status == 409 && body != null && body.IndexOf("取消") >= 0;
        }
        catch (Exception ex3) { Trace("BRIDGE-PICKDIR-FAIL " + Describe(ex3)); }
        Trace("BRIDGE-CANCEL-OK " + cancelled);

        bridgeProbeOk = attached && mode == "webview2" && cancelled;
        Trace("BRIDGE-PROBE-RESULT " + bridgeProbeOk);
        Dump(bridgeProbeOk ? "OK" : "BRIDGEFAIL");
      });
    }

    private static void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
      Trace("NAVCOMPLETE ok=" + e.IsSuccess + " status=" + e.WebErrorStatus);
      if (!e.IsSuccess)
      {
        Trace("NAV-FAIL");
        if (selftest) Dump("NAVFAIL");
        return;
      }
      try
      {
        wv.CoreWebView2.ExecuteScriptAsync(PROBE_JS).ContinueWith(delegate (Task<string> t)
        {
          if (t.IsFaulted || t.IsCanceled) { Trace("SCRIPT-FAIL " + Describe(t.Exception)); if (selftest) Dump("SCRIPTFAIL"); return; }
          Trace("SCRIPT " + t.Result);
          if (!selftest) return;
          /* 页面已渲染：再用真实 HTTP 走一遍原生能力桥，拿到「桥能用」的硬证据。 */
          ProbeBridge();
        }, TaskScheduler.FromCurrentSynchronizationContext());
      }
      catch (Exception ex)
      {
        Trace("SCRIPT-CALL-FAIL " + ex.Message);
        if (selftest) Dump("SCRIPTFAIL");
      }
    }

    /* ============================================================
     *  看护：后端死了就收摊（窗口即应用，不该留一个空白外壳）
     * ============================================================ */
    private static void WatchdogTick()
    {
      if (dumped || quitting) return;
      if (server != null && ServerHasExited())
      {
        Trace("SERVER-DEAD-EXIT code=" + SafeExitCode());
        Dump("SERVERDEAD");
        return;
      }
      /* 先问一次「后端是不是在忙」：既给下面的判定用，也顺带在 trace 里留一份**
         可被自动自检断言的证据**（证明宿主真的在读静默窗口，而不是靠猜）。 */
      bool busy = BackendBusy();
      string body = TryGet("http://127.0.0.1:" + port + "/api/ping", 2000);
      if (body != null && body.IndexOf("MangaVault") >= 0)
      {
        pingFails = 0;
      }
      else if (busy)
      {
        /* 后端声明了「我在跑长任务」：此刻 ping 不通是忙，不是死。
           清空失败计数，免得长任务结束前的最后几次失败继续累积到阈值。 */
        pingFails = 0;
      }
      else
      {
        pingFails++;
        if (pingFails >= PING_MAX_FAILS)
        {
          Trace("SERVER-UNREACHABLE fails=" + pingFails);
          Dump("SERVERDEAD");
          return;
        }
      }
      /* 长轮询会占住本线程最多 BRIDGE_LONGPOLL_MS，用闸门保证同一时刻只有一个轮询者；
         上面的存活检查不依赖它，仍按 PING_INTERVAL_MS/3 的节奏跑。 */
      if (Interlocked.CompareExchange(ref bridgeBusy, 1, 0) != 0) return;
      try { PollBridge(); }
      finally { Interlocked.Exchange(ref bridgeBusy, 0); }
    }

    /* ============================================================
     *  「后端在忙」≠「后端已死」
     *
     *  ★ 真实事故：用户在桌面端跑「查重 / 重扫 / 孤儿清理」这类长任务时窗口自己关掉。
     *  ★ 根因：Node 后端长任务里是单线程忙（一段长时间不 await 的同步循环把事件循环占满），
     *    /api/ping 连续 4 次超时 → 上面的死亡判定收摊 → 窗口消失。
     *  ★ 修法：后端在长任务开始时写 backend-silence.json（绝对时间戳 until）。窗口有效期间，
     *    看护不把 ping 失败当作死亡 —— 但**进程真退出（HasExited）必须照常收摊**，
     *    否则会留一个没有后端的空白外壳。
     * ============================================================ */
    private static bool BackendBusy()
    {
      try
      {
        string f = Path.Combine(dataDir, SILENCE_FILE);
        if (!File.Exists(f)) { silenceLogged = false; return false; }
        string txt = File.ReadAllText(f);
        long until = JsonLong(txt, "until", 0);
        if (until <= 0) { silenceLogged = false; return false; }
        if (until <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) { silenceLogged = false; return false; }
        if (!silenceLogged)
        {
          silenceLogged = true;
          Trace("SERVER-BUSY 静默窗口有效至 " + until + "，暂停死亡判定（长任务进行中）");
        }
        return true;
      }
      catch { return false; }
    }

    private static long JsonLong(string text, string key, long dflt)
    {
      if (string.IsNullOrEmpty(text)) return dflt;
      Match m = Regex.Match(text, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(\\d+)");
      long v;
      if (m.Success && long.TryParse(m.Groups[1].Value, out v)) return v;
      return dflt;
    }

    private static bool ServerHasExited()
    {
      try { return server != null && server.HasExited; } catch { return false; }
    }

    /* ============================================================
     *  原生能力桥：轮询 /api/desktop/native/next，执行后回 /result
     * ============================================================ */
    private static void PollBridge()
    {
      /* 把 pid / exe 一并带上：后端据此判定「宿主在线」（心跳），
         /api/desktop/info 也用它填 mode=webview2 与 exe 字段。 */
      string exePath = Path.Combine(baseDir, "MangaVault.exe");
      string nextUrl = "http://127.0.0.1:" + port + "/api/desktop/native/next?pid=" +
        Process.GetCurrentProcess().Id + "&exe=" + Uri.EscapeDataString(exePath);

      /* 用循环而不是递归：本函数会被反复调用，递归写法会让调用栈无限增长并最终栈溢出。 */
      while (!dumped && !quitting)
      {
        string body = TryGet(nextUrl, BRIDGE_LONGPOLL_MS + 3000);
        if (body == null) return;   // 后端不可达：交给下一轮看护

        string kind = JsonStr(body, "kind");
        string id = JsonStr(body, "id");

        /* 后端长轮询到点会回 {"ok":true,"kind":null} —— 这是正常的「暂无命令」，立刻重连。
           只有连 kind 字段都没有时，才说明后端没有桌面模块（降级场景），此时才慢下来避免刷屏。 */
        if (string.IsNullOrEmpty(kind))
        {
          if (body.IndexOf("\"kind\"") < 0) Thread.Sleep(BRIDGE_IDLE_MS);
          continue;
        }

        Trace("CMD " + kind + " id=" + id);
        bool wantQuit = false;
        string result;
        try
        {
          if (kind == "open-external") result = OpenExternal(JsonStr(body, "url"));
          else if (kind == "reveal") result = Reveal(JsonStr(body, "path"));
          else if (kind == "pick-dir") result = PickDir(JsonStr(body, "title"));
          else if (kind == "quit") { result = Ok(""); wantQuit = true; }
          else result = Err("宿主不认识这个原生能力：" + kind);
        }
        catch (Exception ex)
        {
          result = Err("宿主执行失败：" + ex.Message);
          Trace("CMD-FAIL " + Describe(ex));
        }

        if (string.IsNullOrEmpty(id))
        {
          // 服务端兜底（无回执地址的探测请求），宿主不回写
          Trace("CMD-NOID " + kind);
          if (wantQuit) QueueQuit();
          continue;
        }

        string replyUrl = "http://127.0.0.1:" + port + "/api/desktop/native/result";
        bool posted = TryPost(replyUrl, "{\"id\":" + Lit(id) + ",\"result\":" + result + "}", 5000);
        Trace("CMD-DONE " + kind + " posted=" + posted + " " + Short(result));

        /* 先回执再关窗：否则前端拿不到「已接受退出」的确认 */
        if (wantQuit) QueueQuit();
      }
    }

    private static string OpenExternal(string rawUrl)
    {
      string url = rawUrl == null ? "" : rawUrl.Trim();
      if (url.Length == 0) return Err("缺少 url 参数");
      Uri u = null;
      if (!Uri.TryCreate(url, UriKind.Absolute, out u)) return Err("url 不是合法地址");
      string scheme = u.Scheme == null ? "" : u.Scheme.ToLowerInvariant();
      if (scheme != "http" && scheme != "https" && scheme != "mailto")
        return Err("出于安全考虑，只允许打开 http / https / mailto 链接");
      try
      {
        ProcessStartInfo psi = new ProcessStartInfo(url);
        psi.UseShellExecute = true;
        Process.Start(psi);
      }
      catch (Exception ex) { return Err("调用系统默认程序失败：" + ex.Message); }
      return Ok("\"opened\":" + Lit(url) + ",\"via\":\"shell\"");
    }

    private static string Reveal(string rawPath)
    {
      string p = rawPath == null ? "" : rawPath.Trim();
      if (p.Length == 0) return Err("缺少 path 参数");
      if (p.IndexOf('"') >= 0) return Err("路径含有非法字符");
      string full;
      try { full = Path.GetFullPath(p); }
      catch (Exception ex) { return Err("路径无法解析：" + ex.Message); }
      bool isFile = false, isDir = false;
      try { isFile = File.Exists(full); isDir = Directory.Exists(full); } catch { }
      if (!isFile && !isDir) return Err("路径不存在：" + full);
      try
      {
        ProcessStartInfo psi = new ProcessStartInfo("explorer.exe");
        psi.Arguments = "/select,\"" + full + "\"";
        psi.UseShellExecute = false;
        Process.Start(psi);
      }
      catch (Exception ex) { return Err("打开资源管理器失败：" + ex.Message); }
      return Ok("\"path\":" + Lit(full) + ",\"kind\":" + Lit(isDir ? "dir" : "file"));
    }

    /** 原生选目录：对话框必须在 UI 线程上弹 */
    private static string PickDir(string rawTitle)
    {
      /* 自检模式下绝不弹真实对话框：自动化必须无人工干预，
         返回「用户取消」正好可以顺便验证「取消 -> 明确中文错误」的分支。 */
      if (selftest) return Err("用户取消了目录选择（自检模式不弹对话框）");
      string title = string.IsNullOrEmpty(rawTitle) ? "请选择漫画库根目录" : rawTitle.Trim();
      string picked = null;
      string fail = null;
      try
      {
        form.Invoke((MethodInvoker)delegate
        {
          using (FolderBrowserDialog dlg = new FolderBrowserDialog())
          {
            dlg.Description = title;
            dlg.ShowNewFolderButton = true;
            try { dlg.SelectedPath = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments); } catch { }
            DialogResult r = dlg.ShowDialog(form);
            if (r == DialogResult.OK) picked = dlg.SelectedPath;
          }
        });
      }
      catch (Exception ex) { fail = ex.Message; }
      if (fail != null) return Err("打开目录选择对话框失败：" + fail);
      if (string.IsNullOrEmpty(picked)) return Err("用户取消了目录选择");
      return Ok("\"path\":" + Lit(picked));
    }

    /** 退出必须回到 UI 线程关闭窗口 */
    private static void QueueQuit()
    {
      quitting = true;
      try
      {
        if (form != null && form.IsHandleCreated) form.BeginInvoke((MethodInvoker)delegate { form.Close(); });
        else Shutdown("桥请求退出");
      }
      catch (Exception ex) { Trace("QUIT-FAIL " + ex.Message); }
    }

    /* ============================================================
     *  收尾
     * ============================================================ */
    private static void Shutdown(string reason)
    {
      if (dumped) return;
      Trace("SHUTDOWN " + reason);
      Dump("OK");
    }

    /** 写自检快照并退出；status=OK 时退出码 0，其余为 7
     *
     *  ★ 顺序为什么是这样（曾经把 DONE 写成「偶尔缺失」，踩了两个坑）：
     *    1) KillServer() 会 WaitForExit(5000) / tk.WaitForExit(6000)，最坏能把收尾拖长十几秒。
     *       看护线程（bridgeTimer，3 秒一跳）在这期间照样跑，进来看到 server 已退出就打
     *       「SERVER-DEAD-EXIT」并再调 Dump("SERVERDEAD") —— 要是这一步发生在 KillServer 之前，
     *       真正的收尾就被抢先，日志里只剩 SERVERDEAD，自检读不到 DONE OK。
     *       所以必须**先停看护定时器，再无条件落一行 DONE**，最后才去杀后端。
     *    2) AppendRaw 是 File.AppendAllText，多个线程同时写同一文件会互相踩踏、
     *       偶发 IOException 被 catch 吞掉 —— 收尾那几行正好是并发最密的时刻。
     *       所以全部写文件操作都走 fileLock 串行。 */
    private static void Dump(string status)
    {
      lock (dumpLock)
      {
        if (dumped) return;
        dumped = true;
      }
      /* ① 先落「收尾开始」，再立刻停看护：此刻起不会再有别的线程进来抢着 Dump。 */
      Trace("SHUTDOWN " + status);
      try { if (overallTimer != null) overallTimer.Stop(); } catch { }
      try { if (bridgeTimer != null) bridgeTimer.Dispose(); } catch { }
      /* ② 再杀后端，并把复核结果落成证据。
            ★ DONE 必须排在 KillServer() 之后：自检脚本一看到 DONE OK 就会独立复核
              「后端 pid 是否真的没了」，把 DONE 提前会让那次复核必然读到「还活着」。 */
      KillServer();
      Trace("SERVER-ALIVE-AFTER-KILL " + ServerAliveNow());
      Trace("DONE " + status);
      Trace("SNAPSHOT-BEGIN");
      string[] copy;
      lock (traceLock) { copy = logLines.ToArray(); }
      foreach (string l in copy) AppendRaw("SNAP " + l);
      Trace("SNAPSHOT-END");
      Thread.Sleep(150);   // 给文件系统一点时间把最后一次写入刷下去
      Environment.Exit(status == "OK" ? 0 : 7);
    }

    /* ============================================================
     *  trace 日志（启动即写，静默秒退也能留痕）
     * ============================================================ */
    private static void Trace(string line)
    {
      string text = clock.ElapsedMilliseconds.ToString().PadLeft(7, ' ') + "  " + line;
      lock (traceLock)
      {
        logLines.Add(text);
        if (logLines.Count > 4000) logLines.RemoveRange(0, 1000);
      }
      AppendRaw(text);
    }

    private static void AppendRaw(string text)
    {
      /* 串行化：Trace 会被 UI 线程、线程池定时器、桥轮询线程同时调用，
         File.AppendAllText 并发写同一文件会偶发 IOException（被 catch 吞掉 = 悄悄丢行）。
         收尾阶段恰恰是写入最密的时刻，所以这把锁是「DONE 稳定出现」的前提。 */
      lock (fileLock)
      {
        try
        {
          FileInfo fi = new FileInfo(tracePath);
          if (fi.Exists && fi.Length > TRACE_MAX_BYTES) File.Delete(tracePath);
          File.AppendAllText(tracePath, text + Environment.NewLine, new UTF8Encoding(false));
        }
        catch { }
      }
    }

    private static string Describe(object e)
    {
      if (e == null) return "(null)";
      Exception ex = e as Exception;
      if (ex == null) return e.ToString();
      AggregateException ag = ex as AggregateException;
      if (ag != null && ag.InnerExceptions.Count > 0) ex = ag.InnerExceptions[0];
      return ex.GetType().Name + ": " + ex.Message;
    }

    private static string Short(string s)
    {
      string t = s == null ? "" : s.Replace('\r', ' ').Replace('\n', ' ');
      return t.Length > 160 ? t.Substring(0, 160) + "…" : t;
    }

    /* ============================================================
     *  HTTP 小工具（只用 System.Net，零第三方依赖）
     * ============================================================ */
    private static string TryGet(string url, int timeoutMs)
    {
      try
      {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "GET";
        req.Timeout = timeoutMs;
        req.ReadWriteTimeout = timeoutMs;
        req.Proxy = null;
        req.KeepAlive = false;
        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
        using (StreamReader r = new StreamReader(resp.GetResponseStream(), new UTF8Encoding(false)))
          return r.ReadToEnd();
      }
      catch { return null; }
    }

    /** POST 并读回 { status, text }；用于自检里核对真实 HTTP 状态码 */
    private static string TryPostResp(string url, string body, int timeoutMs, out int status)
    {
      status = 0;
      try
      {
        byte[] data = new UTF8Encoding(false).GetBytes(body);
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "POST";
        req.ContentType = "application/json; charset=utf-8";
        req.ContentLength = data.Length;
        req.Timeout = timeoutMs;
        req.ReadWriteTimeout = timeoutMs;
        req.Proxy = null;
        req.KeepAlive = false;
        using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
        {
          status = (int)resp.StatusCode;
          using (StreamReader r = new StreamReader(resp.GetResponseStream(), new UTF8Encoding(false)))
            return r.ReadToEnd();
        }
      }
      catch (WebException wex)
      {
        /* 4xx/5xx 会抛 WebException，但响应体里有我们要的中文错误，必须读出来 */
        try
        {
          HttpWebResponse resp = (HttpWebResponse)wex.Response;
          if (resp != null)
          {
            status = (int)resp.StatusCode;
            using (StreamReader r = new StreamReader(resp.GetResponseStream(), new UTF8Encoding(false)))
              return r.ReadToEnd();
          }
        }
        catch { }
        return null;
      }
      catch { return null; }
    }

    private static bool TryPost(string url, string body, int timeoutMs)
    {
      try
      {
        byte[] data = new UTF8Encoding(false).GetBytes(body);
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "POST";
        req.ContentType = "application/json; charset=utf-8";
        req.ContentLength = data.Length;
        req.Timeout = timeoutMs;
        req.ReadWriteTimeout = timeoutMs;
        req.Proxy = null;
        req.KeepAlive = false;
        using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
        using (StreamReader r = new StreamReader(resp.GetResponseStream(), new UTF8Encoding(false)))
        { r.ReadToEnd(); return true; }
      }
      catch { return false; }
    }

    /* ============================================================
     *  迷你 JSON 读写（宿主只处理自己约定的少量字段）
     * ============================================================ */
    private static string JsonField(string text, string key)
    {
      if (string.IsNullOrEmpty(text)) return null;
      Match m = Regex.Match(text, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
      return m.Success ? Unescape(m.Groups[1].Value) : null;
    }

    private static string JsonStr(string text, string key) { return JsonField(text, key); }

    private static int JsonInt(string text, string key, int dflt)
    {
      if (string.IsNullOrEmpty(text)) return dflt;
      Match m = Regex.Match(text, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+)");
      int v;
      if (m.Success && int.TryParse(m.Groups[1].Value, out v)) return v;
      return dflt;
    }

    private static bool JsonBool(string text, string key, bool dflt)
    {
      if (string.IsNullOrEmpty(text)) return dflt;
      Match m = Regex.Match(text, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(true|false)");
      if (!m.Success) return dflt;
      return m.Groups[1].Value == "true";
    }

    /** 生成 JSON 字符串字面量 */
    private static string Lit(string s)
    {
      if (s == null) return "null";
      StringBuilder sb = new StringBuilder(s.Length + 8);
      sb.Append('"');
      foreach (char c in s)
      {
        switch (c)
        {
          case '"': sb.Append("\\\""); break;
          case '\\': sb.Append("\\\\"); break;
          case '\b': sb.Append("\\b"); break;
          case '\f': sb.Append("\\f"); break;
          case '\n': sb.Append("\\n"); break;
          case '\r': sb.Append("\\r"); break;
          case '\t': sb.Append("\\t"); break;
          default:
            if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
            break;
        }
      }
      sb.Append('"');
      return sb.ToString();
    }

    private static string Unescape(string s)
    {
      if (s == null || s.IndexOf('\\') < 0) return s;
      StringBuilder sb = new StringBuilder(s.Length);
      for (int i = 0; i < s.Length; i++)
      {
        char c = s[i];
        if (c != '\\' || i + 1 >= s.Length) { sb.Append(c); continue; }
        char n = s[++i];
        switch (n)
        {
          case 'n': sb.Append('\n'); break;
          case 'r': sb.Append('\r'); break;
          case 't': sb.Append('\t'); break;
          case 'b': sb.Append('\b'); break;
          case 'f': sb.Append('\f'); break;
          case '"': sb.Append('"'); break;
          case '\\': sb.Append('\\'); break;
          case '/': sb.Append('/'); break;
          case 'u':
            if (i + 4 < s.Length)
            {
              int code;
              if (int.TryParse(s.Substring(i + 1, 4), System.Globalization.NumberStyles.HexNumber, null, out code))
              {
                sb.Append((char)code);
                i += 4;
                break;
              }
            }
            sb.Append(n);
            break;
          default: sb.Append(n); break;
        }
      }
      return sb.ToString();
    }

    private static string Ok(string fields)
    {
      return "{\"ok\":true" + (string.IsNullOrEmpty(fields) ? "" : "," + fields) + "}";
    }

    private static string Err(string message)
    {
      return "{\"ok\":false,\"error\":" + Lit(message) + "}";
    }
  }
}
