@echo off
rem Makes the helper start by itself (hidden) whenever you log in to Windows.
rem Undo with uninstall-autostart.cmd.
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Editing Assistant helper.lnk"
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%~dp0start-hidden.vbs\"'; $s.WorkingDirectory = '%~dp0'; $s.Save()"
if exist "%LINK%" (
  echo Done. The helper will start by itself next time you log in.
  echo To start it now without logging out, double-click start-hidden.vbs.
) else (
  echo Could not create the startup shortcut.
)
pause
