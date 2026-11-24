@echo off
cd /d "%~dp0"
title PDF Qonverter
where py >nul 2>nul
if %errorlevel%==0 (
  py server.py
  goto :done
)
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto :done
)
echo Python was not found. Install Python 3 from python.org, then run this file again.
:done
pause
