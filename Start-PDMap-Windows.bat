@echo off
setlocal
cd /d "%~dp0"
title PDMap - Fossil Globe
set PORT=8000

echo ============================================
echo   PDMap - Fossil Globe
echo ============================================
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  echo Starting a local server with Python...
  echo Your browser will open at http://localhost:%PORT%/
  echo Leave this window open while using PDMap. Close it to stop.
  start "" "http://localhost:%PORT%/"
  py -m http.server %PORT%
  goto end
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo Starting a local server with Python...
  echo Your browser will open at http://localhost:%PORT%/
  echo Leave this window open while using PDMap. Close it to stop.
  start "" "http://localhost:%PORT%/"
  python -m http.server %PORT%
  goto end
)

echo Python was not found, so opening the app directly in your browser.
echo (If the fossils do not load, install Python from https://www.python.org/
echo  and double-click this file again.)
start "" "index.html"

:end
endlocal
