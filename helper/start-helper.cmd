@echo off
rem Starts the Editing Assistant helper in a console window (the panel's Start helper button runs this).
title Editing Assistant helper
cd /d "%~dp0"
if not exist node_modules (
  echo Installing helper packages, one time only...
  call npm install
)
node src\server.js
echo.
echo The helper stopped. Close this window, or press a key to close it.
pause >nul
