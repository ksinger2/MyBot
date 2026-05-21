@echo off
setlocal EnableDelayedExpansion
REM MyBot watchdog — called every 5 minutes by Task Scheduler AND at boot.
REM Fast path: if bot is already running, exits in <2 seconds.
REM Recovery path: boots WSL, waits for Docker, runs watchdog.sh.

set LOG=%USERPROFILE%\mybot-autostart.log

REM ── Fast path: check if bot is already running ────────────────────────
wsl -d Ubuntu -- bash -c "docker inspect mybot-claude-api-1 --format '{{.State.Status}}'" 2>nul | findstr /C:"running" >nul
if %errorlevel% equ 0 (
    exit /b 0
)

REM ── If we get here, either WSL is dead or the container is not running ─
echo [%date% %time%] === MyBot watchdog triggered === >> "%LOG%"

REM ── Step 1: Boot WSL (no-op if already running) ───────────────────────
echo [%date% %time%] Ensuring WSL is running... >> "%LOG%"
wsl -d Ubuntu -- echo "WSL up" >> "%LOG%" 2>&1
echo [%date% %time%] WSL boot complete >> "%LOG%"

REM ── Step 2: Wait for Docker daemon (active poll, up to 120s) ──────────
echo [%date% %time%] Waiting for Docker daemon... >> "%LOG%"
set DOCKER_READY=0
for /L %%i in (1,1,24) do (
    if !DOCKER_READY! equ 0 (
        wsl -d Ubuntu -- bash -c "docker info > /dev/null 2>&1"
        if !errorlevel! equ 0 (
            set DOCKER_READY=1
            echo [%date% %time%] Docker ready after %%i checks >> "%LOG%"
        ) else (
            timeout /t 5 /nobreak >nul
        )
    )
)

if !DOCKER_READY! equ 0 (
    echo [%date% %time%] ERROR: Docker not ready after 120s >> "%LOG%"
    exit /b 1
)

REM ── Step 3: Run watchdog with retry loop ──────────────────────────────
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
echo [%date% %time%] === MyBot watchdog finished === >> "%LOG%"
exit /b 0
