@echo off
setlocal EnableDelayedExpansion
REM MyBot watchdog — called every 1 minute by Task Scheduler AND at boot.
REM Fast path: if bot is already running, exits in <2 seconds.
REM Recovery path: boots WSL, waits for Docker, runs watchdog.sh.
REM If Docker is wedged (HCS_E_CONNECTION_TIMEOUT), forces wsl --shutdown
REM and retries. As a last resort, restarts HcsService + LxssManager.

set LOG=%USERPROFILE%\mybot-autostart.log

REM ── Fast path: check if bot is already running ────────────────────────
wsl -d Ubuntu -- bash -c "docker inspect mybot-claude-api-1 --format '{{.State.Status}}'" 2>nul | findstr /C:"running" >nul
if %errorlevel% equ 0 (
    exit /b 0
)

REM ── If we get here, either WSL is dead or the container is not running ─
echo [%date% %time%] === MyBot watchdog triggered === >> "%LOG%"

REM ── Attempt 1: Normal boot ───────────────────────────────────────────
call :boot_wsl_and_docker
if !DOCKER_READY! equ 1 goto :docker_ok

REM ── Docker failed — force WSL shutdown and retry ─────────────────────
echo [%date% %time%] Docker not ready after 120s — forcing wsl --shutdown >> "%LOG%"
wsl --shutdown >> "%LOG%" 2>&1
echo [%date% %time%] WSL terminated, waiting 15s for clean slate... >> "%LOG%"
timeout /t 15 /nobreak >nul

REM ── Attempt 2: Re-boot after shutdown ────────────────────────────────
echo [%date% %time%] Re-attempting WSL boot after shutdown... >> "%LOG%"
call :boot_wsl_and_docker
if !DOCKER_READY! equ 1 goto :docker_ok

REM ── Attempt 3: Restart Windows services + shutdown + retry ───────────
echo [%date% %time%] Docker still not ready — restarting HcsService and LxssManager >> "%LOG%"
net stop LxssManager >> "%LOG%" 2>&1
net stop HcsService >> "%LOG%" 2>&1
timeout /t 5 /nobreak >nul
net start HcsService >> "%LOG%" 2>&1
net start LxssManager >> "%LOG%" 2>&1
echo [%date% %time%] Services restarted, waiting 10s... >> "%LOG%"
timeout /t 10 /nobreak >nul

echo [%date% %time%] Forcing wsl --shutdown before final attempt... >> "%LOG%"
wsl --shutdown >> "%LOG%" 2>&1
timeout /t 15 /nobreak >nul

echo [%date% %time%] Final WSL boot attempt... >> "%LOG%"
call :boot_wsl_and_docker
if !DOCKER_READY! equ 1 goto :docker_ok

REM ── All attempts exhausted ───────────────────────────────────────────
echo [%date% %time%] ERROR: Docker not ready after 3 recovery attempts >> "%LOG%"
echo [%date% %time%] === MyBot watchdog finished (FAILED) === >> "%LOG%"
exit /b 1

:docker_ok
REM ── Run watchdog.sh with retry loop ──────────────────────────────────
set ATTEMPTS=0
set MAX_ATTEMPTS=3

:watchdog_retry
set /a ATTEMPTS+=1
echo [%date% %time%] Watchdog attempt %ATTEMPTS% of %MAX_ATTEMPTS% >> "%LOG%"
wsl -d Ubuntu -- bash -lc "/mnt/c/Users/karen/Desktop/Github\ Projects/MyBot/watchdog.sh" >> "%LOG%" 2>&1
set WD_EXIT=!errorlevel!

if !WD_EXIT! equ 0 (
    echo [%date% %time%] Watchdog succeeded on attempt %ATTEMPTS% >> "%LOG%"
    goto watchdog_done
)

REM Exit code 2 from watchdog.sh means Docker socket is unresponsive —
REM force WSL shutdown and retry the whole boot sequence
if !WD_EXIT! equ 2 (
    echo [%date% %time%] Watchdog exit 2: Docker socket unresponsive — forcing wsl --shutdown >> "%LOG%"
    wsl --shutdown >> "%LOG%" 2>&1
    timeout /t 15 /nobreak >nul
    call :boot_wsl_and_docker
    if !DOCKER_READY! equ 0 (
        echo [%date% %time%] ERROR: Docker still dead after shutdown triggered by watchdog >> "%LOG%"
        goto watchdog_done
    )
    echo [%date% %time%] Docker recovered after exit-2 shutdown — re-running watchdog >> "%LOG%"
    goto watchdog_retry
)

echo [%date% %time%] Watchdog failed on attempt %ATTEMPTS% (exit code !WD_EXIT!) >> "%LOG%"

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

REM ======================================================================
REM Subroutine: boot WSL and wait for Docker daemon (up to 120s)
REM Sets DOCKER_READY=1 on success, DOCKER_READY=0 on failure
REM ======================================================================
:boot_wsl_and_docker
set DOCKER_READY=0

echo [%date% %time%] Ensuring WSL is running... >> "%LOG%"
wsl -d Ubuntu -- echo "WSL up" >> "%LOG%" 2>&1
echo [%date% %time%] WSL boot complete >> "%LOG%"

echo [%date% %time%] Waiting for Docker daemon... >> "%LOG%"
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
goto :eof
