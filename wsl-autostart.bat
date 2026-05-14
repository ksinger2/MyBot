@echo off
REM MyBot auto-start — runs at Windows startup via Task Scheduler
REM Starts WSL, waits for Docker Desktop to be ready, then runs the watchdog
REM to bring the container up. Retries watchdog up to 3 times on failure.

set LOG=%USERPROFILE%\mybot-autostart.log

REM ── Step 1: Boot WSL ──────────────────────────────────────────────────
echo [%date% %time%] === wsl-autostart triggered === >> "%LOG%"

echo [%date% %time%] Starting WSL distro... >> "%LOG%"
wsl -d Ubuntu -- echo "WSL up" >> "%LOG%" 2>&1
echo [%date% %time%] WSL boot complete >> "%LOG%"

REM ── Step 2: Start Docker Desktop if not running ───────────────────────
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  tasklist /FI "IMAGENAME eq Docker Desktop.exe" | find /I "Docker Desktop.exe" >nul
  if errorlevel 1 (
    echo [%date% %time%] Docker Desktop not running — starting it >> "%LOG%"
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
  ) else (
    echo [%date% %time%] Docker Desktop already running >> "%LOG%"
  )
)

REM ── Step 3: Wait for Docker daemon to be ready ────────────────────────
REM Docker Desktop takes 60-120s on cold boot after a restart.
REM We wait up to 90s here; the watchdog also has its own Docker wait loop.
echo [%date% %time%] Waiting 90s for Docker daemon to initialize... >> "%LOG%"
timeout /t 90 /nobreak >nul
echo [%date% %time%] Docker wait complete >> "%LOG%"

REM ── Step 4: Run watchdog with retry loop ──────────────────────────────
REM The watchdog checks container health and rebuilds if needed.
REM Retry up to 3 times with 30s delay between attempts.
set ATTEMPTS=0
set MAX_ATTEMPTS=3

:watchdog_retry
set /a ATTEMPTS+=1
echo [%date% %time%] Watchdog attempt %ATTEMPTS% of %MAX_ATTEMPTS% >> "%LOG%"
wsl -d Ubuntu -- bash -lc "/mnt/c/Users/karen/Desktop/Github\ Projects/MyBot/watchdog.sh" >> "%LOG%" 2>&1

if %errorlevel% equ 0 (
  echo [%date% %time%] Watchdog succeeded on attempt %ATTEMPTS% >> "%LOG%"
  goto watchdog_done
)

echo [%date% %time%] Watchdog failed on attempt %ATTEMPTS% (exit code %errorlevel%) >> "%LOG%"

if %ATTEMPTS% geq %MAX_ATTEMPTS% (
  echo [%date% %time%] ERROR: All %MAX_ATTEMPTS% watchdog attempts failed >> "%LOG%"
  goto watchdog_done
)

echo [%date% %time%] Waiting 30s before retry... >> "%LOG%"
timeout /t 30 /nobreak >nul
goto watchdog_retry

:watchdog_done
echo [%date% %time%] === wsl-autostart finished === >> "%LOG%"
exit /b 0
