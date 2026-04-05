@echo off
REM MyBot auto-start — runs at Windows logon via Task Scheduler
REM Starts WSL, waits for Docker, then runs the watchdog to bring the container up.

set LOG=%USERPROFILE%\mybot-autostart.log
echo [%date% %time%] wsl-autostart triggered >> "%LOG%"

REM Boot the WSL distro (no-op if already running)
wsl -d Ubuntu -- echo "WSL up" >> "%LOG%" 2>&1

REM Start Docker Desktop if installed (ignore errors if not present)
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  tasklist /FI "IMAGENAME eq Docker Desktop.exe" | find /I "Docker Desktop.exe" >nul
  if errorlevel 1 (
    echo [%date% %time%] Starting Docker Desktop >> "%LOG%"
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
  )
)

REM Give Docker up to 90s to be ready, then run watchdog (it also waits for Docker)
timeout /t 30 /nobreak >nul
wsl -d Ubuntu -- bash -lc "/mnt/c/Users/karen/Desktop/Github\ Projects/MyBot/watchdog.sh" >> "%LOG%" 2>&1

echo [%date% %time%] wsl-autostart finished >> "%LOG%"
exit /b 0
