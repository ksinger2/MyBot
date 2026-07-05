#Requires -Version 5.1
<#
.SYNOPSIS
    Autonomous repair agent for MyBot/Bianca.
    Runs every 5 minutes via Task Scheduler. Checks health, escalates to
    Claude Code CLI for intelligent multi-agent repair when basic recovery fails.

.DESCRIPTION
    1. Quick health check (curl /health via WSL)
    2. If healthy, exit silently (no API cost)
    3. If unhealthy, attempt basic recovery (docker compose up / WSL restart)
    4. If basic recovery fails, launch Claude Code CLI for full diagnosis + fix
    5. After any repair, notify owner via Signal DM
    6. All WSL calls use timeouts to prevent infinite hangs
    7. Logs all actions to $env:USERPROFILE\mybot-auto-repair.log
#>

$LogFile      = "$env:USERPROFILE\mybot-auto-repair.log"
$StateFile    = "$env:USERPROFILE\mybot-auto-repair-state.json"
$LockFile     = "$env:USERPROFILE\mybot-autostart.lock"
$GraceFile    = "$env:USERPROFILE\mybot-heartbeat-grace.txt"
$ClaudeCli    = "$env:USERPROFILE\.local\bin\claude.exe"
$ProjectRoot  = "C:\Users\karen\Desktop\Github Projects\MyBot"
$ProjectDir   = "/mnt/c/Users/karen/Desktop/Github Projects/MyBot"
$SendDmScript = "/mnt/c/Users/karen/Desktop/Github Projects/MyBot/scripts/send-signal-dm.sh"

function Acquire-Lock {
    param([int]$StaleMinutes = 15)
    if (Test-Path $LockFile) {
        $lockAge = ((Get-Date) - (Get-Item $LockFile).LastWriteTime).TotalMinutes
        if ($lockAge -lt $StaleMinutes) {
            return $false
        }
        Write-Log "Stale lock (${lockAge}min) -- clearing"
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

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$ts] $Message" -Encoding utf8
}

function Trim-Log {
    if (Test-Path $LogFile) {
        $lines = @(Get-Content $LogFile -ErrorAction SilentlyContinue)
        if ($lines.Count -gt 500) {
            $lines | Select-Object -Last 500 | Set-Content $LogFile -Encoding utf8
        }
    }
}

function Get-State {
    if (Test-Path $StateFile) {
        try {
            return Get-Content $StateFile -Raw | ConvertFrom-Json
        } catch {}
    }
    return $null
}

function Set-State {
    param($State)
    $State | ConvertTo-Json -Depth 5 | Set-Content $StateFile -Encoding utf8
}

# Shared timeout wrapper for all WSL calls
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

function Test-Health {
    $script:lastHealthOutput = $null
    $result = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"curl -sf http://localhost:3400/health 2>&1`"" -TimeoutMs 15000
    if ($result.ExitCode -eq 0) {
        $script:lastHealthOutput = $result.Output
        return $true
    }
    return $false
}

function Test-SignalApi {
    # Use the /health response (already fetched by Test-Health) instead of
    # a separate docker exec call. The /health endpoint includes signal_ws
    # status which covers signal-api connectivity. The old docker exec
    # approach was flaky (3 layers: PS → WSL → docker exec → curl) and
    # caused false-positive recoveries that destabilized the bot.
    if ($script:lastHealthOutput) {
        try {
            $json = $script:lastHealthOutput | ConvertFrom-Json
            if ($json.signal_ws -and $json.signal_ws.state -ne $null) {
                return $true
            }
        } catch {}
    }
    # Fallback: direct check via Docker network (no docker exec overhead)
    $result = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"docker exec mybot-claude-api-1 curl -sf http://signal-api:8080/v1/about 2>/dev/null`"" -TimeoutMs 15000
    return ($result.ExitCode -eq 0)
}

function Test-WslAlive {
    $result = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- echo alive" -TimeoutMs 10000
    return ($result.ExitCode -eq 0)
}

function Invoke-BasicRecovery {
    param([string]$Reason)

    if (-not (Acquire-Lock)) {
        Write-Log "Recovery skipped -- lock held by another script"
        return "skipped"
    }

    try {
        Write-Log "Basic recovery: $Reason"

        # Try restarting unhealthy containers first (docker compose up -d does
        # nothing for containers already "Running" — restart actually cycles them)
        Write-Log "Restarting containers..."
        $composeResult = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"cd '$ProjectDir' && docker compose restart claude-api signal-api 2>&1`"" -TimeoutMs 120000
        if ($composeResult.TimedOut) {
            Write-Log "docker compose up TIMED OUT -- WSL may be wedged, skipping to shutdown"
        } else {
            Start-Sleep -Seconds 20
            if (Test-Health) {
                Write-Log "Basic recovery succeeded (docker compose up)"
                return "fixed"
            }
        }

        # Docker compose didn't help -- try restarting Docker
        Write-Log "docker compose up didn't fix it -- restarting Docker service..."
        Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"sudo service docker restart`"" -TimeoutMs 30000 | Out-Null
        Start-Sleep -Seconds 15

        Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"cd '$ProjectDir' && docker compose up -d 2>&1`"" -TimeoutMs 120000 | Out-Null
        Start-Sleep -Seconds 20

        if (Test-Health) {
            Write-Log "Basic recovery succeeded (Docker restart + compose up)"
            return "fixed"
        }

        # Docker restart didn't help -- WSL might be wedged
        if (-not (Test-WslAlive)) {
            Write-Log "WSL is unresponsive -- forcing wsl --shutdown"
            & wsl --shutdown 2>&1 | Out-Null
            Start-Sleep -Seconds 15

            Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"sudo service docker start && sleep 10 && cd '$ProjectDir' && docker compose up -d 2>&1`"" -TimeoutMs 120000 | Out-Null
            Start-Sleep -Seconds 30

            if (Test-Health) {
                Write-Log "Basic recovery succeeded (WSL shutdown + reboot)"
                return "fixed"
            }
        }

        Write-Log "Basic recovery FAILED -- escalating to Claude Code"
        return "failed"
    } finally {
        Release-Lock
    }
}

function Send-OwnerDM {
    param([string]$Message)
    try {
        $escaped = $Message -replace "'", "'\''"
        $escaped = $escaped -replace '\$', '`$'
        $result = Invoke-WslWithTimeout -Arguments "-d Ubuntu -- bash -c `"'$SendDmScript' '$escaped'`"" -TimeoutMs 30000
        if ($result.ExitCode -eq 0) {
            Write-Log "Signal DM sent to owner"
        } else {
            Write-Log "Signal DM send failed (exit=$($result.ExitCode), timedOut=$($result.TimedOut))"
        }
    } catch {
        Write-Log "Signal DM exception: $($_.Exception.Message)"
    }
}

function Invoke-ClaudeRepair {
    param([string]$Reason)

    if (-not (Test-Path $ClaudeCli)) {
        Write-Log "CRITICAL: Claude Code CLI not found at $ClaudeCli"
        return $false
    }

    Write-Log "Launching Claude Code CLI for intelligent repair..."

    # Sanitize reason to prevent prompt injection from error messages
    $safeReason = $Reason -replace '[^\w\s\-;:.()/]', '' | Select-Object -First 1
    if ($safeReason.Length -gt 200) { $safeReason = $safeReason.Substring(0, 200) }

    $prompt = @"
You are an autonomous repair agent for Bianca (a Signal bot). Something is wrong and basic recovery failed. You have FULL access to this Windows machine, WSL, Docker, and all code.

FAILURE REASON: $safeReason

## RULES -- READ THESE FIRST
- Be THOROUGH and METHODICAL. Never take shortcuts.
- Read actual code. Understand actual errors. Trace actual code paths.
- VERIFY every fix before reporting success.
- Do NOT guess. Do NOT assume. CHECK.

## Step 1: Diagnose
Run ALL of these and analyze the output:
- wsl -d Ubuntu -- docker compose ps
- wsl -d Ubuntu -- docker compose logs --tail 100 claude-api
- wsl -d Ubuntu -- docker compose logs --tail 100 signal-api
- wsl -d Ubuntu -- docker inspect mybot-claude-api-1 --format '{{.State.Status}} {{.State.Error}} restarts={{.RestartCount}}'
- wsl -d Ubuntu -- docker inspect mybot-signal-api-1 --format '{{.State.Status}} {{.State.Error}} restarts={{.RestartCount}}'
- Check C: disk space
- Check WSL disk space: wsl -d Ubuntu -- df -h /

## Step 2: Fix Infrastructure
If containers are crash-looping, read the logs to understand WHY.
If it is a code error (syntax, missing module, runtime crash), read the source file, fix the bug, and rebuild:
  wsl -d Ubuntu -- bash -c "cd '/mnt/c/Users/karen/Desktop/Github Projects/MyBot' && docker compose up -d --build claude-api"
If it is a Docker/WSL issue, fix at that level.
If disk is full, clean up.

## Step 3: Verify
After fixing, wait 30 seconds, then re-check:
- wsl -d Ubuntu -- docker compose ps
- wsl -d Ubuntu -- docker exec mybot-claude-api-1 curl -sf http://localhost:3400/health
- wsl -d Ubuntu -- docker exec mybot-signal-api-1 curl -sf http://localhost:8080/v1/about

If still broken, try a different approach. Maximum 3 attempts.

## Step 4: Report
At the very end, output EXACTLY one of these lines (this is how the calling script knows the result):
REPAIR_STATUS: SUCCESS -- <one line description of what was fixed>
REPAIR_STATUS: FAILED -- <one line description of what is still broken>

Commit any code fixes with a clear git commit message.
"@

    # Run with 25-min timeout (Task Scheduler limit is 30min, leave 5min for cleanup)
    $cliTimeoutMs = 25 * 60 * 1000

    try {
        $job = Start-Job -ScriptBlock {
            param($cli, $p, $root)
            & $cli -p $p --output-format text --max-turns 20 --cwd $root 2>&1
        } -ArgumentList $ClaudeCli, $prompt, $ProjectRoot

        $completed = $job | Wait-Job -Timeout ([math]::Floor($cliTimeoutMs / 1000))

        if (-not $completed) {
            Write-Log "Claude CLI TIMED OUT after 25 minutes -- killing"
            $job | Stop-Job -PassThru | Remove-Job -Force
            Send-OwnerDM "[Auto-Repair] Claude Code timed out after 25min on: $safeReason. Manual intervention needed."
            return $false
        }

        $resultText = ($job | Receive-Job) -join "`n"
        $job | Remove-Job -Force

        if ($resultText -match "REPAIR_STATUS:\s*SUCCESS\s*--\s*(.+)") {
            $fixDesc = $Matches[1].Trim()
            Write-Log "Claude repair SUCCEEDED: $fixDesc"
            Send-OwnerDM "[Auto-Repair] Detected: $safeReason. Fixed: $fixDesc. All systems restored."
            return $true
        } elseif ($resultText -match "REPAIR_STATUS:\s*FAILED\s*--\s*(.+)") {
            $failDesc = $Matches[1].Trim()
            Write-Log "Claude repair FAILED: $failDesc"
            Send-OwnerDM "[Auto-Repair] Detected: $safeReason. Claude attempted repair but FAILED: $failDesc. Manual intervention needed."
            return $false
        } else {
            Write-Log "Claude repair completed but no status line found. Output tail: $($resultText.Substring([Math]::Max(0, $resultText.Length - 500)))"
            if (Test-Health) {
                Write-Log "Post-repair health check: PASSING"
                Send-OwnerDM "[Auto-Repair] Detected: $safeReason. Claude ran repair and health checks are now passing."
                return $true
            } else {
                Write-Log "Post-repair health check: FAILING"
                Send-OwnerDM "[Auto-Repair] Detected: $safeReason. Claude attempted repair but health checks still failing. Manual intervention needed."
                return $false
            }
        }
    } catch {
        Write-Log "Claude CLI error: $($_.Exception.Message)"
        Send-OwnerDM "[Auto-Repair] Detected: $safeReason. Claude Code CLI crashed: $($_.Exception.Message). Manual intervention needed."
        return $false
    }
}

# -- Main ------------------------------------------------------------------

Trim-Log

# Quick health check -- if healthy, exit immediately (no cost, no logging)
$healthOk = Test-Health
$signalOk = Test-SignalApi

if ($healthOk -and $signalOk) {
    $state = Get-State
    if ($state -and $state.repairing) {
        Set-State @{ repairing = $false; lastRepairAt = $null; consecutiveFailures = 0 }
    }
    exit 0
}

# If heartbeat recently ran recovery, give it time to take effect
if (Test-Path $GraceFile) {
    try {
        $graceAge = ((Get-Date) - (Get-Item $GraceFile).LastWriteTime).TotalMinutes
        if ($graceAge -lt 5) {
            Write-Log "Heartbeat recovery in progress (grace file is ${graceAge}min old) -- deferring"
            exit 0
        }
    } catch {
        Write-Log "Grace file check failed: $($_.Exception.Message)"
    }
}

# Something is wrong -- reuse cached results, only check WSL separately
$wslOk = Test-WslAlive

$issues = @()
if (-not $wslOk) { $issues += "WSL unresponsive" }
if (-not $healthOk) { $issues += "claude-api health check failed" }
if (-not $signalOk) { $issues += "signal-api unreachable" }
$reason = $issues -join "; "

Write-Log "Issues detected: $reason"

# Load state
$state = Get-State
if (-not $state) {
    $state = @{ repairing = $false; lastRepairAt = $null; consecutiveFailures = 0; lastClaudeRepairAt = $null }
}

$state.consecutiveFailures = ($state.consecutiveFailures -as [int]) + 1
Write-Log "Consecutive failures: $($state.consecutiveFailures)"

# Don't escalate on first failure -- heartbeat (every 1min) may fix it
if ($state.consecutiveFailures -lt 2) {
    Set-State $state
    Write-Log "Waiting for next check before escalating (failure $($state.consecutiveFailures)/2)"
    exit 0
}

# Attempt basic recovery
$recoveryResult = Invoke-BasicRecovery -Reason $reason

if ($recoveryResult -eq "fixed") {
    Send-OwnerDM "[Auto-Repair] Detected: $reason. Basic recovery fixed it -- all systems back online."
    $state.consecutiveFailures = 0
    $state.repairing = $false
    Set-State $state
    exit 0
}

if ($recoveryResult -eq "skipped") {
    Set-State $state
    exit 0
}

# Basic recovery failed -- check Claude cooldown (don't spam expensive API calls)
$claudeCooldownMin = 30
if ($state.lastClaudeRepairAt) {
    $lastRepair = [DateTime]::Parse($state.lastClaudeRepairAt)
    $minutesSinceRepair = ((Get-Date) - $lastRepair).TotalMinutes
    if ($minutesSinceRepair -lt $claudeCooldownMin) {
        Write-Log "Claude repair on cooldown (${minutesSinceRepair}min since last, cooldown=${claudeCooldownMin}min)"
        Set-State $state
        exit 0
    }
}

# Escalate to Claude Code CLI
$state.repairing = $true
$state.lastClaudeRepairAt = (Get-Date -Format o)
Set-State $state

$success = Invoke-ClaudeRepair -Reason $reason

if ($success) {
    $state.consecutiveFailures = 0
    $state.repairing = $false
} else {
    Write-Log "Claude repair did not resolve the issue"
}

Set-State $state
exit 0
