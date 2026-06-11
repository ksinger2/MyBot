#Requires -Version 5.1
<#
.SYNOPSIS
    Disk space monitor with tiered automated cleanup.

.DESCRIPTION
    Runs every 5 minutes via Task Scheduler. Also callable from
    wsl-autostart.bat and mybot-heartbeat.ps1 with -EmergencyOnly.

    Thresholds (C: drive):
      < 20 GB  → warning log
      < 10 GB  → standard cleanup (temp, orphaned swaps, Docker cache)
      < 5 GB   → aggressive cleanup (old node_modules, build dirs, Downloads)

    Also checks D: drive presence (WSL VHDX lives there).
#>
param(
    [switch]$EmergencyOnly
)

$LogFile = "$env:USERPROFILE\disk-monitor.log"
$WslVhdxPath = "C:\WSL\UbuntuNew\ext4.vhdx"

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$ts] $Message" -Encoding utf8
}

function Trim-Log {
    if (Test-Path $LogFile) {
        $lines = Get-Content $LogFile -ErrorAction SilentlyContinue
        if ($lines -and $lines.Count -gt 500) {
            $lines | Select-Object -Last 500 | Set-Content $LogFile -Encoding utf8
        }
    }
}

function Get-CDriveFreeGB {
    [math]::Round((Get-Volume -DriveLetter C).SizeRemaining / 1GB, 2)
}

function Invoke-StandardCleanup {
    Write-Log "Running standard cleanup..."
    $freed = 0

    # Orphaned WSL swap VHDXs
    $swaps = Get-ChildItem "$env:LOCALAPPDATA\Temp" -Filter "swap.vhdx" -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($s in $swaps) {
        $size = $s.Length
        try { Remove-Item $s.FullName -Force -ErrorAction Stop; $freed += $size } catch {}
    }

    # Temp files older than 7 days
    Get-ChildItem "$env:LOCALAPPDATA\Temp" -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { -not $_.PSIsContainer -and $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
        ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop; $freed += $_.Length } catch {} }

    # Windows Temp
    Get-ChildItem "C:\Windows\Temp" -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { -not $_.PSIsContainer -and $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
        ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop; $freed += $_.Length } catch {} }

    # npm cache
    $npmCache = "$env:APPDATA\npm-cache"
    if (Test-Path $npmCache) {
        $cacheSize = (Get-ChildItem $npmCache -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
        if ($cacheSize -gt 500MB) {
            try { Remove-Item "$npmCache\*" -Recurse -Force -ErrorAction SilentlyContinue; $freed += $cacheSize } catch {}
        }
    }

    # Docker build cache prune (if WSL is running)
    try {
        $wslState = wsl -l -v 2>&1 | Select-String "Running"
        if ($wslState) {
            wsl -d Ubuntu -- bash -c "docker builder prune -f --filter 'until=24h' 2>/dev/null; docker image prune -f 2>/dev/null" 2>$null
        }
    } catch {}

    Write-Log "Standard cleanup freed $([math]::Round($freed/1GB, 2)) GB"
}

function Invoke-AggressiveCleanup {
    Write-Log "Running AGGRESSIVE cleanup..."
    Invoke-StandardCleanup
    $freed = 0

    # node_modules in non-MyBot projects
    $projectsDir = "C:\Users\karen\Desktop\Github Projects"
    Get-ChildItem $projectsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "MyBot" } |
        ForEach-Object {
            $nm = Join-Path $_.FullName "node_modules"
            if (Test-Path $nm) {
                $size = (Get-ChildItem $nm -Recurse -Force -ErrorAction SilentlyContinue |
                    Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
                try { Remove-Item $nm -Recurse -Force -ErrorAction Stop; $freed += $size; Write-Log "  Removed $nm ($([math]::Round($size/1MB,0)) MB)" } catch {}
            }
        }

    # Build output directories in non-MyBot projects
    $buildDirs = @(".next", "dist", "build", ".turbo", ".cache")
    Get-ChildItem $projectsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "MyBot" } |
        ForEach-Object {
            foreach ($bd in $buildDirs) {
                $target = Join-Path $_.FullName $bd
                if (Test-Path $target) {
                    $size = (Get-ChildItem $target -Recurse -Force -ErrorAction SilentlyContinue |
                        Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
                    try { Remove-Item $target -Recurse -Force -ErrorAction Stop; $freed += $size } catch {}
                }
            }
        }

    # Downloads files older than 14 days
    Get-ChildItem "C:\Users\karen\Downloads" -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
        ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop; $freed += $_.Length } catch {} }

    # pip cache
    $pipCache = "$env:LOCALAPPDATA\pip\cache"
    if (Test-Path $pipCache) {
        try { Remove-Item "$pipCache\*" -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }

    # Trim all log files in USERPROFILE to 100 lines
    Get-ChildItem $env:USERPROFILE -Filter "*.log" -File -ErrorAction SilentlyContinue | ForEach-Object {
        $lines = Get-Content $_.FullName -ErrorAction SilentlyContinue
        if ($lines -and $lines.Count -gt 100) {
            $lines | Select-Object -Last 100 | Set-Content $_.FullName -Encoding utf8
        }
    }

    Write-Log "Aggressive cleanup freed additional $([math]::Round($freed/1GB, 2)) GB"
}

# ── Main ──────────────────────────────────────────────────────────────────

Trim-Log

# Check VHDX presence (now on C: — no USB dependency)
if (-not (Test-Path $WslVhdxPath)) {
    Write-Log "CRITICAL: WSL VHDX not found at $WslVhdxPath"
}

# Check C: drive free space
$freeGB = Get-CDriveFreeGB

if ($EmergencyOnly) {
    if ($freeGB -lt 5) {
        Invoke-AggressiveCleanup
    } elseif ($freeGB -lt 10) {
        Invoke-StandardCleanup
    }
    exit 0
}

if ($freeGB -lt 5) {
    Write-Log "EMERGENCY: C: drive has $freeGB GB free — running aggressive cleanup"
    Invoke-AggressiveCleanup
    $freeGB = Get-CDriveFreeGB
    Write-Log "After cleanup: C: has $freeGB GB free"
} elseif ($freeGB -lt 10) {
    Write-Log "CRITICAL: C: drive has $freeGB GB free — running standard cleanup"
    Invoke-StandardCleanup
    $freeGB = Get-CDriveFreeGB
    Write-Log "After cleanup: C: has $freeGB GB free"
} elseif ($freeGB -lt 20) {
    Write-Log "WARNING: C: drive has $freeGB GB free"
}

exit 0
