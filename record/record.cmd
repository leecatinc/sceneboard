@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python Launcher "py" was not found. Install Python 3 for Windows.
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ffmpeg.exe was not found on PATH.
  echo Install FFmpeg for Windows, reopen this window, and try again.
  pause
  exit /b 1
)

rem Before recording, run this once in the Codex CMD window:
rem title SceneBoard Codex

py -3 record.py ^
  --x 0 --y 0 ^
  --width 1920 --height 1080 --fps 60 ^
  --terminal-title "SceneBoard Codex" ^
  --terminal-x 1340 --terminal-y 210 ^
  --terminal-width 580 --terminal-height 870 ^
  --mask 1680,112,240,58 ^
  --max-seconds 1800

if errorlevel 1 (
  echo.
  echo Recording did not complete successfully.
  pause
  exit /b 1
)

echo.
echo Recording completed. Press any key to close this window.
pause >nul
endlocal
