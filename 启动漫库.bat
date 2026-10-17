@echo off
chcp 936 >nul
cd /d "%~dp0"

rem 漫库 MangaVault 最小启动器：调起桌面端，不留控制台窗口
rem 本文件必须保存为 GBK / cp936 编码，用 UTF-8 保存会让 cmd 拆断中文行

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node.js 20 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if exist "%~dp0启动漫库.vbs" (
  start "" wscript.exe "%~dp0启动漫库.vbs"
  exit /b 0
)

node desktop\app.mjs
