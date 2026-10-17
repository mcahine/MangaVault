# ============================================================
#  漫库 MangaVault · 系统托盘（可选）
#  PowerShell + WinForms NotifyIcon：打开窗口 / 重启 / 退出 / 看日志
#  用法：powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File desktop\tray.ps1
#  注意：托盘图标常驻会在任务栏留下 PowerShell 进程，因此默认不自动启用（见 docs/modules/desktop.md）。
# ============================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$lock = Join-Path $root 'data\server.lock.json'
$vbs = Join-Path $root '启动漫库.vbs'
$iconPath = Join-Path $root 'assets\icon.ico'

function Get-BaseUrl {
  try {
    $raw = Get-Content -Raw -Encoding UTF8 $lock
    $obj = $raw | ConvertFrom-Json
    if ($obj.port) { return ('http://127.0.0.1:' + $obj.port) }
  } catch { }
  return $null
}

function Post-Api([string]$path, [string]$body) {
  $base = Get-BaseUrl
  if (-not $base) { return $false }
  try {
    Invoke-RestMethod -Method Post -Uri ($base + $path) -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
    return $true
  } catch { return $false }
}

$notify = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) { $notify.Icon = New-Object System.Drawing.Icon($iconPath) }
$notify.Text = '漫库 MangaVault'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemOpen = $menu.Items.Add('打开漫库窗口')
$itemOpen.add_Click({
  $base = Get-BaseUrl
  if (-not $base) {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $root
    return
  }
  Start-Process -FilePath $env:ComSpec -ArgumentList ('/c start "" wscript.exe "' + $vbs + '"') -WorkingDirectory $root -WindowStyle Hidden
})

$itemRestart = $menu.Items.Add('重启本地内核')
$itemRestart.add_Click({
  if (-not (Post-Api '/api/desktop/restart?confirm=1' '{}')) {
    $notify.ShowBalloonTip(3000, '漫库', '重启失败：内核未运行', [System.Windows.Forms.ToolTipIcon]::Warning)
    return
  }
  Start-Sleep -Milliseconds 800
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $root
  $notify.ShowBalloonTip(3000, '漫库', '已请求重启', [System.Windows.Forms.ToolTipIcon]::Info)
})

$itemLogs = $menu.Items.Add('打开日志目录')
$itemLogs.add_Click({ Start-Process explorer.exe (Join-Path $root 'data') })

$menu.Items.Add('-') | Out-Null
$itemQuit = $menu.Items.Add('退出漫库')
$itemQuit.add_Click({
  Post-Api '/api/desktop/quit?confirm=1' '{}' | Out-Null
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ $itemOpen.PerformClick() })

[System.Windows.Forms.Application]::Run()
$notify.Visible = $false