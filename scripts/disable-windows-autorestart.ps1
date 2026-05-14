#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Prevents Windows from automatically restarting for updates.

.DESCRIPTION
    Sets all necessary registry policies and disables scheduled tasks to prevent
    Windows Update from forcing an automatic restart. Must be run as Administrator.

    Background: NoAutoUpdate=1 only prevents auto-downloading of updates.
    It does NOT prevent auto-restart for already-downloaded updates.
    MoUsoCoreWorker.exe and TrustedInstaller.exe can still initiate planned
    restarts via the UpdateOrchestrator scheduled tasks.

    This script addresses every layer of the forced-restart mechanism:
    1. Group Policy registry keys under WindowsUpdate\AU
    2. UX Settings for active hours
    3. The UpdateOrchestrator "Reboot" scheduled task

.NOTES
    Run from an elevated PowerShell prompt:
        powershell -ExecutionPolicy Bypass -File disable-windows-autorestart.ps1
#>

# --- Check for Administrator privileges ---
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ""
    Write-Host "ERROR: This script must be run as Administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as administrator', then re-run this script." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "=== Disabling Windows Update Auto-Restart ===" -ForegroundColor Cyan
Write-Host ""

$changes = @()

# ---------------------------------------------------------------------------
# 1. Group Policy: Windows Update AU registry keys
# ---------------------------------------------------------------------------
$auPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"

# Ensure the registry path exists
if (-not (Test-Path $auPath)) {
    New-Item -Path $auPath -Force | Out-Null
    Write-Host "[Created] Registry path: $auPath" -ForegroundColor DarkGray
}

# NoAutoRebootWithLoggedOnUsers = 1
# Prevents restart while any user is logged on
Set-ItemProperty -Path $auPath -Name "NoAutoRebootWithLoggedOnUsers" -Value 1 -Type DWord -Force
$changes += "NoAutoRebootWithLoggedOnUsers = 1  (no restart while user is logged on)"

# AUOptions = 2
# Notify for download AND install -- never auto-install
Set-ItemProperty -Path $auPath -Name "AUOptions" -Value 2 -Type DWord -Force
$changes += "AUOptions = 2  (notify for download and install, never auto-install)"

# AlwaysAutoRebootAtScheduledTime = 0
# Do not force restart at a scheduled time
Set-ItemProperty -Path $auPath -Name "AlwaysAutoRebootAtScheduledTime" -Value 0 -Type DWord -Force
$changes += "AlwaysAutoRebootAtScheduledTime = 0  (no forced scheduled restart)"

# ---------------------------------------------------------------------------
# 2. Group Policy: Active Hours (maximum 18-hour window)
# ---------------------------------------------------------------------------
$wuPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate"

# Ensure the registry path exists
if (-not (Test-Path $wuPath)) {
    New-Item -Path $wuPath -Force | Out-Null
    Write-Host "[Created] Registry path: $wuPath" -ForegroundColor DarkGray
}

# SetActiveHours = 1  (enable active hours policy)
Set-ItemProperty -Path $wuPath -Name "SetActiveHours" -Value 1 -Type DWord -Force
$changes += "SetActiveHours = 1  (active hours policy enabled)"

# ActiveHoursStart = 8  (8 AM)
Set-ItemProperty -Path $wuPath -Name "ActiveHoursStart" -Value 8 -Type DWord -Force
$changes += "ActiveHoursStart = 8  (8:00 AM)"

# ActiveHoursEnd = 2  (2 AM next day -- gives 18-hour protected window)
Set-ItemProperty -Path $wuPath -Name "ActiveHoursEnd" -Value 2 -Type DWord -Force
$changes += "ActiveHoursEnd = 2  (2:00 AM -- 18-hour window: 8 AM to 2 AM)"

# ---------------------------------------------------------------------------
# 3. UX Settings: Active Hours for Update Orchestrator
# ---------------------------------------------------------------------------
$uxPath = "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings"

if (-not (Test-Path $uxPath)) {
    New-Item -Path $uxPath -Force | Out-Null
    Write-Host "[Created] Registry path: $uxPath" -ForegroundColor DarkGray
}

Set-ItemProperty -Path $uxPath -Name "IsActiveHoursEnabled" -Value 1 -Type DWord -Force
$changes += "IsActiveHoursEnabled = 1  (UX active hours enabled)"

Set-ItemProperty -Path $uxPath -Name "ActiveHoursStart" -Value 8 -Type DWord -Force
$changes += "UX ActiveHoursStart = 8  (8:00 AM)"

Set-ItemProperty -Path $uxPath -Name "ActiveHoursEnd" -Value 2 -Type DWord -Force
$changes += "UX ActiveHoursEnd = 2  (2:00 AM)"

# ---------------------------------------------------------------------------
# 4. Disable UpdateOrchestrator "Reboot" scheduled task
#    This is the task that MoUsoCoreWorker.exe uses to force the actual restart.
# ---------------------------------------------------------------------------
Write-Host "[Task Scheduler] Disabling UpdateOrchestrator Reboot tasks..." -ForegroundColor DarkGray

$rebootTasks = @(
    "\Microsoft\Windows\UpdateOrchestrator\Reboot"
    "\Microsoft\Windows\UpdateOrchestrator\Reboot_AC"
    "\Microsoft\Windows\UpdateOrchestrator\Reboot_Battery"
)

foreach ($taskName in $rebootTasks) {
    try {
        $task = Get-ScheduledTask -TaskPath ($taskName -replace '[^\\]*$', '') `
                                   -TaskName ($taskName -replace '.*\\', '') `
                                   -ErrorAction SilentlyContinue
        if ($task) {
            Disable-ScheduledTask -TaskPath ($taskName -replace '[^\\]*$', '') `
                                  -TaskName ($taskName -replace '.*\\', '') `
                                  -ErrorAction Stop | Out-Null
            $changes += "Disabled scheduled task: $taskName"
        } else {
            $changes += "Scheduled task not found (OK to skip): $taskName"
        }
    } catch {
        $changes += "WARNING: Could not disable task $taskName -- $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# 5. Take ownership of Reboot task file to prevent Windows from re-enabling it
#    Windows often re-enables the Reboot task after updates. Taking ownership
#    and setting permissions on the task XML prevents this.
# ---------------------------------------------------------------------------
$rebootTaskFile = "$env:SystemRoot\System32\Tasks\Microsoft\Windows\UpdateOrchestrator\Reboot"
if (Test-Path $rebootTaskFile) {
    try {
        # Take ownership
        & takeown /F $rebootTaskFile /A 2>&1 | Out-Null
        # Grant Administrators full control
        & icacls $rebootTaskFile /grant "Administrators:F" 2>&1 | Out-Null
        # Remove SYSTEM write access so Windows cannot re-enable it
        & icacls $rebootTaskFile /deny "SYSTEM:(W)" 2>&1 | Out-Null
        $changes += "Locked Reboot task file permissions (prevents Windows from re-enabling)"
    } catch {
        $changes += "WARNING: Could not lock Reboot task file -- $($_.Exception.Message)"
    }
} else {
    $changes += "Reboot task file not found at expected path (may already be removed)"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Green
Write-Host ""
foreach ($change in $changes) {
    if ($change -like "WARNING:*") {
        Write-Host "  [!] $change" -ForegroundColor Yellow
    } elseif ($change -like "Scheduled task not found*") {
        Write-Host "  [-] $change" -ForegroundColor DarkGray
    } else {
        Write-Host "  [+] $change" -ForegroundColor White
    }
}

Write-Host ""
Write-Host "=== Verification ===" -ForegroundColor Cyan

# Verify AU registry values
Write-Host ""
Write-Host "  Group Policy AU keys:" -ForegroundColor Gray
Get-ItemProperty -Path $auPath | Format-List NoAutoRebootWithLoggedOnUsers, AUOptions, AlwaysAutoRebootAtScheduledTime | Out-String | ForEach-Object { $_.Trim() } | Write-Host

Write-Host "  Active Hours policy keys:" -ForegroundColor Gray
Get-ItemProperty -Path $wuPath | Format-List SetActiveHours, ActiveHoursStart, ActiveHoursEnd | Out-String | ForEach-Object { $_.Trim() } | Write-Host

Write-Host "  UX Settings keys:" -ForegroundColor Gray
Get-ItemProperty -Path $uxPath | Format-List IsActiveHoursEnabled, ActiveHoursStart, ActiveHoursEnd | Out-String | ForEach-Object { $_.Trim() } | Write-Host

# Verify scheduled task status
Write-Host "  UpdateOrchestrator Reboot task status:" -ForegroundColor Gray
foreach ($taskName in $rebootTasks) {
    $tn = $taskName -replace '.*\\', ''
    $tp = $taskName -replace '[^\\]*$', ''
    $task = Get-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction SilentlyContinue
    if ($task) {
        $stateColor = if ($task.State -eq "Disabled") { "Green" } else { "Red" }
        Write-Host "    $taskName : $($task.State)" -ForegroundColor $stateColor
    } else {
        Write-Host "    $taskName : Not Found" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Done. Windows will no longer auto-restart for updates." -ForegroundColor Green
Write-Host "You will still receive notifications and can install updates manually." -ForegroundColor Gray
Write-Host ""
Write-Host "NOTE: A 'gpupdate /force' is recommended to ensure Group Policy picks up the changes:" -ForegroundColor Yellow
Write-Host "    gpupdate /force" -ForegroundColor White
Write-Host ""
