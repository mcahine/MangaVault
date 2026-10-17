# MangaVault 查重模块 · 删除执行器（由 engine/delete.mjs 数组传参调用）
# 人工在界面上确认（输入 DELETE）后才会触发。
# Mode: recycle = 移入回收站 / quarantine = 移动到隔离目录 / permanent = 永久删除
# -Root 为查重根目录，脚本内再兜底校验一次：只允许删除 Root 之内的路径，且不允许删除 Root 本身。
param(
  [Parameter(Mandatory = $true)][string]$ListFile,
  [Parameter(Mandatory = $true)][ValidateSet('recycle', 'quarantine', 'permanent')][string]$Mode,
  [string]$QuarantineDir = '',
  [string]$Root = ''
)
$ErrorActionPreference = 'Continue'
if ($Mode -eq 'recycle') { Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop }

function Test-WithinRoot([string]$path, [string]$root) {
  if ([string]::IsNullOrWhiteSpace($root)) { return $true }
  $r = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
  $p = [System.IO.Path]::GetFullPath($path)
  if ($p -eq $r) { return $false }
  return $p.StartsWith($r + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

$items = Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json
$results = @()
foreach ($p in $items.paths) {
  $rec = [ordered]@{ path = $p; ok = $false; error = ''; target = '' }
  try {
    if (-not (Test-WithinRoot -path $p -root $Root)) { throw '路径越界，已拒绝' }
    if (-not (Test-Path -LiteralPath $p)) { throw '路径不存在' }
    switch ($Mode) {
      'recycle' { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
      'quarantine' {
        if ([string]::IsNullOrWhiteSpace($QuarantineDir)) { throw '未指定隔离目录' }
        New-Item -ItemType Directory -Force -Path $QuarantineDir | Out-Null
        $target = Join-Path $QuarantineDir ([System.IO.Path]::GetFileName($p))
        if (Test-Path -LiteralPath $target) { $target = $target + '_' + (Get-Date -Format 'yyyyMMddHHmmss') + '_' + (Get-Random -Maximum 9999) }
        Move-Item -LiteralPath $p -Destination $target
        $rec.target = $target
      }
      'permanent' { Remove-Item -LiteralPath $p -Recurse -Force }
    }
    $rec.ok = $true
  } catch {
    $rec.error = $_.Exception.Message
  }
  $results += [pscustomobject]$rec
}
$out = [pscustomobject]@{ mode = $Mode; time = (Get-Date).ToString('s'); results = $results }
$out | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ($ListFile + '.result.json') -Encoding UTF8
Write-Output ('done ' + ($results | Where-Object { $_.ok }).Count + '/' + $results.Count)
