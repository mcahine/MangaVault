' ============================================================
'  MangaVault - console-free launcher
'  Runs node desktop/app.mjs with a hidden console, and restarts
'  when the app exits with code 66 (RESTART_EXIT in desktop/app.mjs).
'  Double-click this file. Troubleshooting: data\desktop.log
'  NOTE: keep this file pure ASCII. wscript reads .vbs using the
'  system ANSI code page, so non-ASCII comments here are the same
'  bug class as the GBK-only rule for .bat files.
' ============================================================
Option Explicit

Dim fso, shell, root, cmd, code, retries, rcFile
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
retries = 0

Do
  cmd = """node"" """ & root & "\desktop\app.mjs"""
  code = shell.Run(cmd, 0, True)
  If code = 66 Then
    retries = retries + 1
    If retries > 5 Then Exit Do
    WScript.Sleep 1500
  Else
    Exit Do
  End If
Loop

' normal exit: clear the restart marker so the next launch is not confused
rcFile = fso.BuildPath(root, "data\desktop-restart.request")
If fso.FileExists(rcFile) Then fso.DeleteFile rcFile, True
