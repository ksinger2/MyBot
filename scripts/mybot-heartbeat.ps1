#Requires -Version 5.1
<#
.SYNOPSIS
    Lightweight MyBot heartbeat — checks health every 30s (Task Scheduler interval).

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

function Invoke-WslShutdownAndRecover {
    param([string]$Reason)
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

    # Reset counter after recovery attempt
    Set-FailureCount 0
    Write-Log "Recovery sequence complete"
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

# -- WSL alive check (catches wedged state before health check hangs) ------
$aliveProc = New-Object System.Diagnostics.Process
$aliveProc.StartInfo.FileName = "wsl"
$aliveProc.StartInfo.Arguments = "-d Ubuntu -- echo alive"
$aliveProc.StartInfo.UseShellExecute = $false
$aliveProc.StartInfo.RedirectStandardOutput = $true
$aliveProc.StartInfo.RedirectStandardError = $true
$aliveProc.StartInfo.CreateNoWindow = $true
try {
    $aliveStarted = $aliveProc.Start()
    if ($aliveStarted) {
        $aliveExited = $aliveProc.WaitForExit(10000)
        $aliveOut = if ($aliveExited) { $aliveProc.StandardOutput.ReadToEnd().Trim() } else { "" }
        if (-not $aliveExited) { try { $aliveProc.Kill() } catch {} }
        if ($aliveOut -ne "alive") {
            Write-Log "WSL alive check failed (wedged or stopped) — forcing wsl --shutdown"
            & wsl --shutdown 2>&1 | Out-Null
            Start-Sleep -Seconds 10
        }
    }
} catch {
    Write-Log "WSL alive check exception: $($_.Exception.Message)"
}

# -- Disk space check (runs every heartbeat) ------------------------------
$cFreeGB = [math]::Round((Get-Volume -DriveLetter C).SizeRemaining / 1GB, 2)
if ($cFreeGB -lt 5) {
    Write-Log "DISK EMERGENCY: C: drive has $cFreeGB GB free — triggering cleanup"
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\disk-space-monitor.ps1" -EmergencyOnly
} elseif ($cFreeGB -lt 20) {
    Write-Log "DISK WARNING: C: drive has $cFreeGB GB free"
}

# Attempt health check via WSL curl
$healthOk = $false
$hcsError = $false

try {
    # Run the health check — redirect only stderr (for HCS error detection).
    # Stdout is NOT redirected to avoid a potential pipe-buffer deadlock:
    # if stdout fills its 4KB buffer while we're blocked on WaitForExit,
    # the process hangs and we'd hit the 15s timeout every time.
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo.FileName = "wsl"
    $proc.StartInfo.Arguments = "-d Ubuntu -- bash -c `"curl -sf $HealthURL`""
    $proc.StartInfo.UseShellExecute = $false
    $proc.StartInfo.RedirectStandardOutput = $false
    $proc.StartInfo.RedirectStandardError = $true
    $proc.StartInfo.CreateNoWindow = $true

    # Use a thread-safe list for async stderr collection.
    # PS 5.1 event handlers run in global scope, so use script-scope.
    $script:_stderrLines = New-Object System.Collections.ArrayList
    $proc.add_ErrorDataReceived({
        param($sender, $e)
        if ($null -ne $e.Data) { [void]$script:_stderrLines.Add($e.Data) }
    })

    $started = $proc.Start()
    if ($started) {
        $proc.BeginErrorReadLine()

        # Wait up to 15 seconds for the health check
        $exited = $proc.WaitForExit(15000)
        if ($exited) {
            # After WaitForExit(timeout) returns true, call WaitForExit()
            # (no args) to flush async output buffers
            $proc.WaitForExit()
            $stderr = $script:_stderrLines -join "`n"
            if ($proc.ExitCode -eq 0) {
                $healthOk = $true
            }
            # Check for HCS_E_CONNECTION_TIMEOUT in stderr
            if ($stderr -match "HCS_E_CONNECTION_TIMEOUT") {
                $hcsError = $true
            }
        } else {
            # Process didn't exit in 15s — likely WSL is hung
            try { $proc.Kill() } catch {}
            # Check stderr collected so far for HCS error
            $stderr = $script:_stderrLines -join "`n"
            if ($stderr -match "HCS_E_CONNECTION_TIMEOUT") {
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
    Invoke-WslShutdownAndRecover -Reason "HCS_E_CONNECTION_TIMEOUT detected — immediate escalation"
    exit 0
}

# -- Handle success -------------------------------------------------------
if ($healthOk) {
    # Reset counter on success and exit quietly
    $current = Get-FailureCount
    if ($current -gt 0) {
        Write-Log "Health check OK (was at $current consecutive failures — resetting)"
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
