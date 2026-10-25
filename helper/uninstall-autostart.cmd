@echo off
rem Stops the helper from starting by itself at login (removes the startup shortcut).
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Editing Assistant helper.lnk" 2>nul
echo The helper will no longer start at login.
pause
