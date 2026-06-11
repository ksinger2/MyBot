#Requires -Version 5.1
<#
.SYNOPSIS
    Weekly WSL/Docker maintenance — prevents VHDX bloat and disk exhaustion.
    Register as a weekly Task Scheduler task (Sundays at 4am recommended).

.DESCRIPTION
    1. Prunes unused Docker images, build cache, and stopped containers
    2. Cleans signal-api libsignal temp leaks
    3. Runs fstrim to reclaim VHDX space
    4. Logs all actions
#>

$LogFile = "$env:USERPROFILE\mybot-maintenance.log"

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$ts] $Message" -Encoding utf8
}

# Trim log
if (Test-Path $LogFile) {
    $lines = Get-Content $LogFile -ErrorAction SilentlyContinue
    if ($lines -and $lines.Count -gt 200) {
        $lines | Select-Object -Last 200 | Set-Content $LogFile -Encoding utf8
    }
}

Write-Log "=== Weekly maintenance started ==="

# Check WSL is running
$aliveCheck = & wsl -d Ubuntu -- echo "alive" 2>&1
if ($aliveCheck -notmatch "alive") {
    Write-Log "WSL not responding — skipping maintenance"
    exit 0
}

# 1. Docker prune — unused images, build cache, dangling volumes
Write-Log "Pruning Docker..."
$pruneOutput = & wsl -d Ubuntu -- bash -c "docker system prune -af --filter 'until=72h' 2>&1 | tail -1"
Write-Log "Docker prune: $pruneOutput"

# 2. Signal-api temp cleanup
$tempCount = & wsl -d Ubuntu -- bash -c "docker exec mybot-signal-api-1 bash -c 'ls -d /tmp/libsignal* 2>/dev/null | wc -l' 2>/dev/null"
if ($tempCount -and [int]$tempCount -gt 2) {
    & wsl -d Ubuntu -- bash -c "docker exec mybot-signal-api-1 bash -c 'ls -dt /tmp/libsignal* | tail -n +3 | xargs rm -rf' 2>/dev/null"
    Write-Log "Cleaned $([int]$tempCount - 2) libsignal temp dirs"
}

# 3. WSL disk usage before fstrim
$dfBefore = & wsl -d Ubuntu -- bash -c "df -h / | tail -1 | awk '{print \`$3, \`$5}'"
Write-Log "Disk before fstrim: $dfBefore"

# 4. fstrim to reclaim VHDX space
Write-Log "Running fstrim..."
$trimResult = & wsl -d Ubuntu -- bash -c "sudo fstrim -v / 2>&1"
Write-Log "fstrim: $trimResult"

# 5. Check VHDX size
$vhdxPath = "C:\WSL\UbuntuNew\ext4.vhdx"
if (Test-Path $vhdxPath) {
    $sizeGB = [math]::Round((Get-Item $vhdxPath).Length / 1GB, 2)
    Write-Log "VHDX size: $sizeGB GB"
    if ($sizeGB -gt 150) {
        Write-Log "WARNING: VHDX is large ($sizeGB GB) — consider running diskpart compact"
    }
}

Write-Log "=== Weekly maintenance complete ==="
