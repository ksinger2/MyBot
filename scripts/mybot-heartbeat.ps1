#Requires -Version 5.1
<#
.SYNOPSIS
    Lightweight MyBot heartbeat -- checks health every minute via Task Scheduler.

.DESCRIPTION
    1. Curls http://localhost:3400/health inside WSL
    2. On success, resets failure counter and exits
    3. On 5 consecutive failures, tries docker compose up -d (NOT wsl --shutdown)
    4. On HCS_E_CONNECTION_TIMEOUT, logs and defers to auto-repair (WSL shutdown
       is too heavy for a heartbeat -- auto-repair handles wedged WSL)
    5. After any recovery, sets a 5-minute grace period to let containers start
    6. All WSL calls use timeouts to prevent infinite hangs
    7. Logs all actions to $env:USERPROFILE\mybot-heartbeat.log
    8. Trims log to 500 lines on each run
#>

# -- Config ----------------------------------------------------------------
$LogFile   = "$env:USERPROFILE\mybot-heartbeat.log"
$StateFile = "$env:USERPROFILE\mybot-heartbeat-state.txt"
$GraceFile = "$env:USERPROFILE\mybot-heartbeat-grace.txt"
$SignalWsRestartFile = "$env:USERPROFILE\mybot-signal-ws-restart.txt"
$HealthURL = "http://localhost:3400/health"
$MaxFailures = 5
$GraceMinutes = 5
$SignalWsRestartCooldownMin = 30
$ProjectDir = "/mnt/c/Users/karen/Desktop/Github Projects/MyBot"

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
    if (Test-Path $LogFile) {
        $lines = @(Get-Content $LogFile -ErrorAction SilentlyContinue)
        if ($lines.Count -gt 500) {
            $lines | Select-Object -Last 500 | Set-Content $LogFile -Encoding utf8
        }
    }
}

$LockFile = "$env:USERPROFILE\mybot-autostart.lock"

function Acquire-Lock {
    param([int]$StaleMinutes = 15)
    if (Test-Path $LockFile) {
        $lockAge = ((Get-Date) - (Get-Item $LockFile).LastWriteTime).TotalMinutes
        if ($lockAge -lt $StaleMinutes) {
            return $false
        }
        Write-Log "Stale autostart lock (${lockAge}min) -- clearing and proceeding"
        try { Remove-Item $LockFile -Force } catch {}
    }
    try {
        $fs = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $writer = New-Object System.IO.StreamWriter($fs)
        $writer.Write((Get-Date -Format o))
        $writer.Close()
        $fs.Close()
        return $true
    } catch [System.IO.IOException] {
        return $false
    }
}

function Release-Lock {
    if (Test-Path $LockFile) {
        try { Remove-Item $LockFile -Force } catch {}
    }
}

function Invoke-WslWithTimeout {
    param(
        [string]$Arguments,
        [int]$TimeoutMs = 120000
    )
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo.FileName = "wsl"
    $proc.StartInfo.Arguments = $Arguments
    $proc.StartInfo.UseShellExecute = $false
    $proc.StartInfo.RedirectStandardOutput = $true
    $proc.StartInfo.RedirectStandardError = $true
    $proc.StartInfo.CreateNoWindow = $true

    $started = $proc.Start()
    if (-not $started) {
        return @{ ExitCode = -1; Output = ""; Stderr = ""; TimedOut = $false }
    }

    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $exited = $proc.WaitForExit($TimeoutMs)

    if (-not $exited) {
        try { $proc.Kill() } catch {}
        $stdout = if ($stdoutTask.Wait(2000)) { $stdoutTask.Result } else { "" }
        $stderr = if ($stderrTask.Wait(2000)) { $stderrTask.Result } else { "" }
        return @{ ExitCode = -1; Output = $stdout; Stderr = $stderr; TimedOut = $true }
    }

    $stdout = if ($stdoutTask.Wait(5000)) { $stdoutTask.Result } else { "" }
    $stderr = if ($stderrTask.Wait(5000)) { $stderrTask.Result } else { "" }
    return @{ ExitCode = $proc.ExitCode; Output = $stdout; Stderr = $stderr; TimedOut = $false }
}

function Send-OwnerDM {
    param([string]$Message)
    try {
        $escaped = $Message -replace "'", "'\''"
        $escaped = $escaped -replace '\$', '`$'
        $result = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"'/mnt/c/Users/karen/Desktop/Github Projects/MyBot/scripts/send-signal-dm.sh' '$escaped'`"" -TimeoutMs 30000
        if ($result.ExitCode -eq 0) {
            Write-Log "Signal DM sent to owner"
        } else {
            Write-Log "Signal DM failed (exit=$($result.ExitCode), timedOut=$($result.TimedOut))"
        }
    } catch {
        Write-Log "Signal DM exception: $($_.Exception.Message)"
    }
}

function Invoke-ContainerRecovery {
    param([string]$Reason)

    if (-not (Acquire-Lock)) {
        Write-Log "Recovery skipped -- lock held by another script"
        Set-FailureCount 0
        Set-Content -Path $GraceFile -Value (Get-Date -Format o) -Encoding utf8
        return
    }

    try {
        Write-Log $Reason
        Write-Log "Running docker compose up -d (light recovery -- NOT wsl --shutdown)..."

        $result = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"cd '$ProjectDir' && docker compose up -d 2>&1`"" -TimeoutMs 120000

        if ($result.TimedOut) {
            Write-Log "docker compose up -d TIMED OUT after 120s -- deferring to auto-repair"
        } elseif ($result.Output) {
            foreach ($line in ($result.Output -split "`n")) {
                if ($line.Trim()) { Write-Log "  compose: $line" }
            }
        }

        Set-FailureCount 0
        Set-Content -Path $GraceFile -Value (Get-Date -Format o) -Encoding utf8
        Write-Log "Recovery attempted -- grace period set (${GraceMinutes}min). Auto-repair will escalate if this doesn't fix it."

        Send-OwnerDM "Health check failed ($Reason). Restarted containers. Will escalate if it doesn't recover."
    } finally {
        Release-Lock
    }
}

# -- Main ------------------------------------------------------------------

Trim-Log

# -- Grace period check: skip if we recently recovered --------------------
if (Test-Path $GraceFile) {
    $graceAge = ((Get-Date) - (Get-Item $GraceFile).LastWriteTime).TotalMinutes
    if ($graceAge -lt $GraceMinutes) {
        exit 0
    }
    Remove-Item $GraceFile -Force
    Write-Log "Grace period expired -- resuming health checks"
}

# -- VHDX presence check ---------------------------------------------------
$WslVhdxPath = "C:\WSL\UbuntuNew\ext4.vhdx"
if (-not (Test-Path $WslVhdxPath)) {
    Write-Log "CRITICAL: WSL VHDX not found at $WslVhdxPath"
    exit 0
}

# -- Disk space check (runs every heartbeat) ------------------------------
$cFreeGB = [math]::Round((Get-Volume -DriveLetter C).SizeRemaining / 1GB, 2)
if ($cFreeGB -lt 5) {
    Write-Log "DISK EMERGENCY: C: drive has $cFreeGB GB free -- triggering cleanup"
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\disk-space-monitor.ps1" -EmergencyOnly
} elseif ($cFreeGB -lt 20) {
    Write-Log "DISK WARNING: C: drive has $cFreeGB GB free"
}

# Attempt health check via WSL curl (15s timeout, captures both stdout and stderr)
$healthResult = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"curl -sf $HealthURL 2>&1`"" -TimeoutMs 15000

$healthOk = ($healthResult.ExitCode -eq 0)
$hcsError = ($healthResult.Output -match "HCS_E_CONNECTION_TIMEOUT") -or ($healthResult.Stderr -match "HCS_E_CONNECTION_TIMEOUT")

# -- Handle HCS_E_CONNECTION_TIMEOUT -- log and defer to auto-repair ------
if ($hcsError) {
    Write-Log "HCS_E_CONNECTION_TIMEOUT detected -- WSL is wedged. Deferring to auto-repair (heartbeat does NOT do wsl --shutdown)."
    Set-FailureCount ($MaxFailures)
    exit 0
}

if ($healthResult.TimedOut) {
    Write-Log "Health check timed out after 15s"
}

# -- Handle success -------------------------------------------------------
if ($healthOk) {
    $current = Get-FailureCount
    if ($current -gt 0) {
        Write-Log "Health check OK (was at $current consecutive failures -- resetting)"
        Set-FailureCount 0
    }

    # Check if Signal WebSocket is dead (internal watchdog gave up)
    # The container is "healthy" but can't receive messages — external intervention needed
    try {
        $healthJson = $healthResult.Output | ConvertFrom-Json
        if ($healthJson.signal_ws -and $healthJson.signal_ws.state -eq 'dead') {
            $shouldRestart = $true
            if (Test-Path $SignalWsRestartFile) {
                $lastWsRestart = (Get-Item $SignalWsRestartFile).LastWriteTime
                if (((Get-Date) - $lastWsRestart).TotalMinutes -lt $SignalWsRestartCooldownMin) {
                    $shouldRestart = $false
                }
            }
            if ($shouldRestart) {
                Write-Log "Signal WebSocket is DEAD (internal watchdog exhausted) -- force-restarting signal-api from outside"
                $restartResult = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"cd '$ProjectDir' && docker compose restart signal-api 2>&1`"" -TimeoutMs 60000
                Set-Content -Path $SignalWsRestartFile -Value (Get-Date -Format o) -Encoding utf8
                if ($restartResult.ExitCode -eq 0) {
                    Write-Log "signal-api restarted successfully -- WebSocket should reconnect"
                    Send-OwnerDM "Signal WebSocket was dead (watchdog gave up). Force-restarted signal-api from outside."
                } else {
                    Write-Log "signal-api restart FAILED (exit=$($restartResult.ExitCode))"
                }
            }
        }
    } catch {}

    exit 0
}

# -- Handle failure -------------------------------------------------------
$failures = (Get-FailureCount) + 1
Set-FailureCount $failures
Write-Log "Health check FAILED (consecutive failures: $failures/$MaxFailures)"

if ($failures -ge $MaxFailures) {
    Invoke-ContainerRecovery -Reason "MyBot unhealthy for $failures consecutive checks -- restarting containers"
}

exit 0
