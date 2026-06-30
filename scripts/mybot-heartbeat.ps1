#Requires -Version 5.1
<#
.SYNOPSIS
    Lightweight MyBot heartbeat -- checks health every 30s (Task Scheduler interval).

.DESCRIPTION
    1. Curls http://localhost:3400/health inside WSL
    2. On success, resets failure counter and exits
    3. On 3 consecutive failures, forces wsl --shutdown and runs watchdog.sh
    4. On HCS_E_CONNECTION_TIMEOUT in stderr, immediately escalates to shutdown
    5. Logs all actions to $env:USERPROFILE\mybot-heartbeat.log
    6. Trims log to 500 lines on each run

    Register as a Task Scheduler task with 30-second repeat interval.
#>

# -- Config ----------------------------------------------------------------
$LogFile   = "$env:USERPROFILE\mybot-heartbeat.log"
$StateFile = "$env:USERPROFILE\mybot-heartbeat-state.txt"
$HealthURL = "http://localhost:3400/health"
$MaxFailures = 3
$WatchdogPath = "/mnt/c/Users/karen/Desktop/Github\ Projects/MyBot/watchdog.sh"

# -- Helpers ---------------------------------------------------------------
function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$ts] $Message" -Encoding utf8
}

function Get-FailureCount {
    if (Test-Path $StateFile) {
        $content = Get-Content $StateFile -ErrorAction SilentlyContinue
        if ($content -match '^\d+$') {
            return [int]$content
        }
    }
    return 0
}

function Set-FailureCount {
    param([int]$Count)
    Set-Content -Path $StateFile -Value $Count -Encoding utf8
}

function Trim-Log {
    # Keep only the last 500 lines
    if (Test-Path $LogFile) {
        $lines = Get-Content $LogFile -ErrorAction SilentlyContinue
        if ($lines -and $lines.Count -gt 500) {
            $lines | Select-Object -Last 500 | Set-Content $LogFile -Encoding utf8
        }
    }
}

$LockFile = "$env:USERPROFILE\mybot-autostart.lock"
$SendDmScript = "/mnt/c/Users/karen/Desktop/Github\ Projects/MyBot/scripts/send-signal-dm.sh"

function Send-OwnerDM {
    param([string]$Message)
    try {
        $result = & wsl -d Ubuntu -- bash $SendDmScript $Message 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Signal DM sent to owner"
        } else {
            Write-Log "Signal DM failed: $result"
        }
    } catch {
        Write-Log "Signal DM exception: $($_.Exception.Message)"
    }
}

function Invoke-WslShutdownAndRecover {
    param([string]$Reason)

    # Shared lock with wsl-autostart.bat -- skip if another recovery is running
    if (Test-Path $LockFile) {
        $lockAge = ((Get-Date) - (Get-Item $LockFile).LastWriteTime).TotalMinutes
        if ($lockAge -lt 15) {
            Write-Log "Recovery skipped -- autostart lock exists (${lockAge}min old)"
            Set-FailureCount 0
            return
        }
        Write-Log "Stale autostart lock (${lockAge}min) -- clearing and proceeding"
    }
    Set-Content -Path $LockFile -Value (Get-Date -Format o) -Encoding utf8

    Write-Log $Reason
    Write-Log "Forcing wsl --shutdown..."

    # Run wsl --shutdown and capture stderr for HCS errors
    $shutdownOutput = & wsl --shutdown 2>&1
    if ($shutdownOutput) {
        Write-Log "wsl --shutdown output: $shutdownOutput"
    }

    Write-Log "Waiting 15s for clean slate..."
    Start-Sleep -Seconds 15

    Write-Log "Running watchdog.sh to recover..."
    $watchdogOutput = & wsl -d Ubuntu -- bash -lc $WatchdogPath 2>&1
    if ($watchdogOutput) {
        foreach ($line in $watchdogOutput) {
            Write-Log "  watchdog: $line"
        }
    }

    # Reset counter after recovery attempt -- keep lock so subsequent heartbeat
    # runs skip recovery while the container finishes starting (ages out at 15min)
    Set-FailureCount 0
    Write-Log "Recovery sequence complete (lock retained for grace period)"

    # Notify owner via Signal DM after recovery
    Send-OwnerDM "I detected an issue and recovered automatically. Reason: $Reason -- running self-check now."
}

# -- Main ------------------------------------------------------------------

# Trim log on every run to prevent unbounded growth
Trim-Log

# -- VHDX presence check ---------------------------------------------------
$WslVhdxPath = "C:\WSL\UbuntuNew\ext4.vhdx"
if (-not (Test-Path $WslVhdxPath)) {
    Write-Log "CRITICAL: WSL VHDX not found at $WslVhdxPath"
    exit 0
}

# -- WSL alive check removed: the health check's 15s timeout + 3-failure
# -- threshold handles unresponsive WSL without false positives. The old
# -- 10s alive check triggered spurious wsl --shutdown under load.

# -- Disk space check (runs every heartbeat) ------------------------------
$cFreeGB = [math]::Round((Get-Volume -DriveLetter C).SizeRemaining / 1GB, 2)
if ($cFreeGB -lt 5) {
    Write-Log "DISK EMERGENCY: C: drive has $cFreeGB GB free -- triggering cleanup"
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\disk-space-monitor.ps1" -EmergencyOnly
} elseif ($cFreeGB -lt 20) {
    Write-Log "DISK WARNING: C: drive has $cFreeGB GB free"
}

# Attempt health check via WSL curl
$healthOk = $false
$hcsError = $false

try {
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo.FileName = "wsl"
    $proc.StartInfo.Arguments = "-d Ubuntu -- bash -c `"curl -sf $HealthURL 2>&1`""
    $proc.StartInfo.UseShellExecute = $false
    $proc.StartInfo.RedirectStandardOutput = $true
    $proc.StartInfo.RedirectStandardError = $false
    $proc.StartInfo.CreateNoWindow = $true

    $started = $proc.Start()
    if ($started) {
        $output = ""
        $readTask = $proc.StandardOutput.ReadToEndAsync()
        $exited = $proc.WaitForExit(15000)
        if ($exited) {
            if ($readTask.Wait(5000)) { $output = $readTask.Result }
            if ($proc.ExitCode -eq 0) {
                $healthOk = $true
            }
            if ($output -match "HCS_E_CONNECTION_TIMEOUT") {
                $hcsError = $true
            }
        } else {
            try { $proc.Kill() } catch {}
            if ($readTask.Wait(1000)) { $output = $readTask.Result }
            if ($output -match "HCS_E_CONNECTION_TIMEOUT") {
                $hcsError = $true
            }
            Write-Log "Health check timed out after 15s"
        }
    }
} catch {
    Write-Log "Health check exception: $($_.Exception.Message)"
}

# -- Handle HCS_E_CONNECTION_TIMEOUT immediately --------------------------
if ($hcsError) {
    Invoke-WslShutdownAndRecover -Reason "HCS_E_CONNECTION_TIMEOUT detected -- immediate escalation"
    exit 0
}

# -- Handle success -------------------------------------------------------
if ($healthOk) {
    # Reset counter on success and exit quietly
    $current = Get-FailureCount
    if ($current -gt 0) {
        Write-Log "Health check OK (was at $current consecutive failures -- resetting)"
        Set-FailureCount 0
    }
    exit 0
}

# -- Handle failure -------------------------------------------------------
$failures = (Get-FailureCount) + 1
Set-FailureCount $failures
Write-Log "Health check FAILED (consecutive failures: $failures/$MaxFailures)"

if ($failures -ge $MaxFailures) {
    Invoke-WslShutdownAndRecover -Reason "WSL/MyBot unresponsive for $failures checks -- forcing WSL shutdown"
}

exit 0
