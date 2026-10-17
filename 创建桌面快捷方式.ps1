# ============================================================
#  漫库 MangaVault · 创建桌面快捷方式（桌面 + 开始菜单）
#  指向 启动漫库.vbs（无控制台黑窗），图标用 assets\icon.ico，工作目录=项目根
#  用法：右键「使用 PowerShell 运行」，或  powershell -ExecutionPolicy Bypass -File 创建桌面快捷方式.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root '启动漫库.vbs'
$icon = Join-Path $root 'assets\icon.ico'
$name = '漫库 MangaVault'

if (-not (Test-Path $vbs)) { Write-Host "[错误] 找不到 $vbs" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $icon)) { Write-Host '[提示] 缺少 assets\icon.ico，将先尝试生成…' -ForegroundColor Yellow; & node (Join-Path $root 'desktop\make-icon.mjs') }
if (-not (Test-Path $icon)) { $icon = (Join-Path $env:SystemRoot 'System32\shell32.dll,13') }

$shell = New-Object -ComObject WScript.Shell
$targets = @()
$targets += (Join-Path ([Environment]::GetFolderPath('Desktop')) ($name + '.lnk'))
$startDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
if (Test-Path $startDir) { $targets += (Join-Path $startDir ($name + '.lnk')) }

$made = @()
foreach ($lnkPath in $targets) {
  try {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = (Join-Path $env:SystemRoot 'System32\wscript.exe')
    $lnk.Arguments = '"' + $vbs + '"'
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = $icon
    $lnk.Description = '漫库 MangaVault —— 本地漫画管理 / 阅读 / 下载 / 查重'
    $lnk.WindowStyle = 1
    $lnk.Save()
    $made += $lnkPath
    Write-Host ("[完成] " + $lnkPath) -ForegroundColor Green
  } catch {
    Write-Host ("[失败] " + $lnkPath + ' -> ' + $_.Exception.Message) -ForegroundColor Red
  }
}

if ($made.Count -eq 0) { exit 1 }
Write-Host '' 
Write-Host '快捷方式已就绪：双击即可无黑框启动漫库（关闭窗口 = 退出漫库）。' -ForegroundColor Cyan