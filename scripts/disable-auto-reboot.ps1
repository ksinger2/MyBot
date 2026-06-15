#Requires -RunAsAdministrator
# disable-auto-reboot.ps1 - Prevents Windows Update from rebooting the machine
# Run as Administrator: right-click PowerShell, Run as Administrator, paste path

$ErrorActionPreference = 'Stop'

Write-Host "`n=== Disabling Windows Update auto-reboot ===" -ForegroundColor Cyan

# 1. Registry: prevent auto-reboot and auto-install
$auPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
if (-not (Test-Path $auPath)) {
    New-Item -Path $auPath -Force | Out-Null
    Write-Host "  Created registry path: $auPath"
}
Set-ItemProperty -Path $auPath -Name 'NoAutoUpdate' -Value 1 -Type DWord
Set-ItemProperty -Path $auPath -Name 'NoAutoRebootWithLoggedOnUsers' -Value 1 -Type DWord
Set-ItemProperty -Path $auPath -Name 'AUOptions' -Value 2 -Type DWord
Write-Host "  Registry: NoAutoUpdate=1, NoAutoReboot=1, AUOptions=2 (notify only)" -ForegroundColor Green

# 2. Active hours: 0-23 (protect entire day)
$uxPath = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
if (Test-Path $uxPath) {
    Set-ItemProperty -Path $uxPath -Name 'ActiveHoursStart' -Value 0 -Type DWord
    Set-ItemProperty -Path $uxPath -Name 'ActiveHoursEnd' -Value 23 -Type DWord
    Set-ItemProperty -Path $uxPath -Name 'IsActiveHoursEnabled' -Value 1 -Type DWord
    Write-Host "  Active hours: 0:00 - 23:00 (all day)" -ForegroundColor Green
}

# 3. Disable UsoSvc (Update Session Orchestrator)
# This is the service whose MoUsoCoreWorker.exe force-rebooted at 3:29am
try {
    Stop-Service UsoSvc -Force -ErrorAction SilentlyContinue
    Set-Service UsoSvc -StartupType Disabled
    Write-Host "  UsoSvc: Disabled" -ForegroundColor Green
} catch {
    Write-Host ("  UsoSvc: Failed - " + $_.Exception.Message) -ForegroundColor Yellow
}

# 4. Disable WaaSMedicSvc (re-enables update services after you disable them)
# Protected by Windows, so we use the registry override
try {
    $medicPath = 'HKLM:\SYSTEM\CurrentControlSet\Services\WaaSMedicSvc'
    Set-ItemProperty -Path $medicPath -Name 'Start' -Value 4 -Type DWord
    Write-Host "  WaaSMedicSvc: Disabled via registry" -ForegroundColor Green
} catch {
    Write-Host ("  WaaSMedicSvc: Failed - " + $_.Exception.Message) -ForegroundColor Yellow
}

# 5. Verify
Write-Host "`n=== Verification ===" -ForegroundColor Cyan
Get-ItemProperty $auPath | Select-Object NoAutoUpdate,NoAutoRebootWithLoggedOnUsers,AUOptions | Format-List
Get-Service UsoSvc,WaaSMedicSvc 2>$null | Select-Object Name,Status,StartType | Format-Table -AutoSize

Write-Host "Done. Windows Update will no longer auto-install or reboot." -ForegroundColor Green
Write-Host "Defender definitions will still update manually via Windows Security." -ForegroundColor Gray
