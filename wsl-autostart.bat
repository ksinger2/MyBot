@echo off
setlocal EnableDelayedExpansion
REM MyBot watchdog — called every 1 minute by Task Scheduler AND at boot.
REM Fast path: if bot is already running, exits in <2 seconds.
REM Recovery path: boots WSL, waits for Docker, runs watchdog.sh.
REM If Docker is wedged (HCS_E_CONNECTION_TIMEOUT), forces wsl --shutdown
REM and retries. As a last resort, restarts HcsService + LxssManager.

set LOG=%USERPROFILE%\mybot-autostart.log

REM ── Log rotation: keep last 500 lines ─────────────────────────────
powershell -NoProfile -Command "if (Test-Path '%LOG%') { $l = Get-Content '%LOG%'; if ($l.Count -gt 500) { $l | Select-Object -Last 500 | Set-Content '%LOG%' -Encoding utf8 } }"

REM ── Fast path: check if bot is already running ────────────────────────
REM Use timeout to prevent wedged WSL from blocking the check for minutes.
REM 15s is generous — docker inspect returns in <1s when healthy.
wsl -d Ubuntu -- bash -c "timeout 10 docker inspect mybot-claude-api-1 --format '{{.State.Status}}' 2>/dev/null" 2>nul | findstr /C:"running" >nul
if %errorlevel% equ 0 (
    exit /b 0
)

REM ── If we get here, either WSL is dead or the container is not running ─
echo [%date% %time%] === MyBot watchdog triggered === >> "%LOG%"

REM ── VHDX presence check (WSL VHDX now lives on C:\WSL) ─────────────
if not exist "C:\WSL\UbuntuNew\ext4.vhdx" (
    echo [%date% %time%] CRITICAL: C:\WSL\UbuntuNew\ext4.vhdx not found >> "%LOG%"
    exit /b 1
)

REM ── Disk space pre-check ────────────────────────────────────────────
powershell -NoProfile -Command "$free = (Get-Volume -DriveLetter C).SizeRemaining; if ($free -lt 2GB) { exit 1 } else { exit 0 }"
if %errorlevel% neq 0 (
    echo [%date% %time%] DISK EMERGENCY: C: drive has less than 2 GB free — running cleanup >> "%LOG%"
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\disk-space-monitor.ps1" -EmergencyOnly >> "%LOG%" 2>&1
    powershell -NoProfile -Command "$free = (Get-Volume -DriveLetter C).SizeRemaining; if ($free -lt 2GB) { exit 1 } else { exit 0 }"
    if %errorlevel% neq 0 (
        echo [%date% %time%] FATAL: Cleanup failed to free enough space. Manual intervention required. >> "%LOG%"
        exit /b 1
    )
    echo [%date% %time%] Disk cleanup freed enough space to proceed >> "%LOG%"
)

REM ── Wedged state detection ──────────────────────────────────────────
REM Previous approach used `wsl -l -v | findstr "Running"` but that never
REM matched because wsl -l outputs UTF-16 which findstr can't parse.
REM New approach: directly test if WSL responds. If the echo fails, WSL is
REM either stopped or wedged — either way, wsl --shutdown clears it safely.
wsl -d Ubuntu -- echo "alive" 2>nul | findstr /C:"alive" >nul
if !errorlevel! neq 0 (
    echo [%date% %time%] WSL command test failed — clearing wedged state via wsl --shutdown >> "%LOG%"
    wsl --shutdown >> "%LOG%" 2>&1
    timeout /t 15 /nobreak >nul
)

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
REM ── Quick Docker cleanup on recovery (prevents VHDX bloat) ─────────
wsl -d Ubuntu -- bash -c "docker image prune -f >/dev/null 2>&1"

REM ── Ensure Docker service is started ────────────────────────────────
wsl -d Ubuntu -- bash -c "sudo service docker start >/dev/null 2>&1"

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
REM ── Blockbuster PM2 health check ────────────────────────────────────
REM Ensure PM2 services (Blockbuster frontend, backend, tunnel) are running.
set NODE=/home/karen/.nvm/versions/node/v24.14.1/bin/node
set PM2BIN=/home/karen/.nvm/versions/node/v24.14.1/lib/node_modules/pm2/bin/pm2
wsl -d Ubuntu -- %NODE% %PM2BIN% ping 2>nul | findstr /C:"pong" >nul
if !errorlevel! neq 0 (
    echo [%date% %time%] PM2 daemon not running — starting Blockbuster services >> "%LOG%"
    wsl -d Ubuntu -- %NODE% %PM2BIN% resurrect >> "%LOG%" 2>&1
    if !errorlevel! neq 0 (
        echo [%date% %time%] PM2 resurrect failed — starting from ecosystem config >> "%LOG%"
        wsl -d Ubuntu -- %NODE% %PM2BIN% start "/mnt/c/Users/karen/Desktop/Github Projects/Blockbuster/ecosystem.config.js" >> "%LOG%" 2>&1
    )
) else (
    REM PM2 is alive — check if cloudflare-tunnel is running
    wsl -d Ubuntu -- %NODE% %PM2BIN% describe cloudflare-tunnel 2>nul | findstr /C:"online" >nul
    if !errorlevel! neq 0 (
        echo [%date% %time%] Blockbuster cloudflare-tunnel is down — restarting >> "%LOG%"
        wsl -d Ubuntu -- %NODE% %PM2BIN% restart cloudflare-tunnel >> "%LOG%" 2>&1
    )
)
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

REM Explicitly start Docker — systemd sometimes fails on WSL boot
REM ("Failed to start the systemd user session" seen in logs)
wsl -d Ubuntu -- bash -c "sudo service docker start >/dev/null 2>&1"

echo [%date% %time%] Waiting for Docker daemon... >> "%LOG%"
for /L %%i in (1,1,24) do (
    if !DOCKER_READY! equ 0 (
        wsl -d Ubuntu -- bash -c "docker info > /dev/null 2>&1"
        if !errorlevel! equ 0 (
            set DOCKER_READY=1
            echo [%date% %time%] Docker ready after %%i checks >> "%LOG%"
        ) else (
            REM Retry Docker service start every 3rd check
            set /a MOD=%%i %% 3
            if !MOD! equ 0 (
                wsl -d Ubuntu -- bash -c "sudo service docker start >/dev/null 2>&1"
            )
            timeout /t 5 /nobreak >nul
        )
    )
)
goto :eof
