#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Fixes the "MyBot Autostart" scheduled task to use an AtStartup trigger
    instead of AtLogon, so Bianca starts even when no user is logged in.

.DESCRIPTION
    The old task used a LOGON trigger, which meant Bianca stayed offline from
    the time Windows auto-restarted (e.g. 3 AM for updates) until someone
    physically logged in hours later.

    This script:
      1. Removes the existing "MyBot Autostart" task
      2. Recreates it with an AtStartup trigger (60s delay)
      3. Sets it to run whether the user is logged on or not
      4. Disables battery restrictions
      5. Enables StartWhenAvailable so missed triggers run ASAP
      6. Configures 3 retries at 5-minute intervals on failure

    NOTE: Because the task runs whether the user is logged on or not,
    Windows will prompt for the karen user's password during registration.

.NOTES
    Run from an elevated (Administrator) PowerShell prompt:
      powershell -ExecutionPolicy Bypass -File .\scripts\fix-autostart-task.ps1
#>

$ErrorActionPreference = "Stop"

# ── Config ──────────────────────────────────────────────────────────────
$TaskName       = "MyBot Autostart"
$BatPath        = "C:\Users\karen\Desktop\Github Projects\MyBot\wsl-autostart.bat"
$UserName       = "karen"
$StartupDelay   = "PT60S"       # 60-second delay after startup
$ExecTimeLimit  = "PT2H"        # 2-hour max runtime
$RestartCount   = 3
$RestartInterval = "PT5M"       # 5 minutes between retries

# ── Admin check ─────────────────────────────────────────────────────────
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator. Right-click PowerShell > Run as Administrator."
    exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  MyBot Autostart — Task Scheduler Fix"      -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Show current state ──────────────────────────────────────────────────
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[CURRENT] Found existing task:" -ForegroundColor Yellow
    $trigger = $existing.Triggers | Select-Object -First 1
    Write-Host "  Trigger type  : $($trigger.CimClass.CimClassName)" -ForegroundColor Yellow
    Write-Host "  Run level     : $($existing.Principal.RunLevel)" -ForegroundColor Yellow
    Write-Host "  Logon type    : $($existing.Principal.LogonType)" -ForegroundColor Yellow
    $settings = $existing.Settings
    Write-Host "  DisallowOnBatt: $($settings.DisallowStartIfOnBatteries)" -ForegroundColor Yellow
    Write-Host "  StopOnBatt    : $($settings.StopIfGoingOnBatteries)" -ForegroundColor Yellow
    Write-Host "  StartWhenAvail: $($settings.StartWhenAvailable)" -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "[INFO] No existing '$TaskName' task found — will create fresh." -ForegroundColor Gray
    Write-Host ""
}

# ── Show what we're applying ────────────────────────────────────────────
Write-Host "[NEW] Configuration:" -ForegroundColor Green
Write-Host "  Trigger       : AtStartup (${StartupDelay} delay)" -ForegroundColor Green
Write-Host "  Action        : $BatPath" -ForegroundColor Green
Write-Host "  Principal     : $UserName, Highest privileges, run whether logged on or not" -ForegroundColor Green
Write-Host "  DisallowOnBatt: False" -ForegroundColor Green
Write-Host "  StopOnBatt    : False" -ForegroundColor Green
Write-Host "  StartWhenAvail: True" -ForegroundColor Green
Write-Host "  ExecTimeLimit : $ExecTimeLimit" -ForegroundColor Green
Write-Host "  Restart       : ${RestartCount}x every ${RestartInterval} on failure" -ForegroundColor Green
Write-Host "  MultiInstance : IgnoreNew" -ForegroundColor Green
Write-Host ""

# ── Remove existing task ────────────────────────────────────────────────
if ($existing) {
    Write-Host "[1/3] Removing existing task..." -ForegroundColor White
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  Done." -ForegroundColor Gray
} else {
    Write-Host "[1/3] No existing task to remove — skipping." -ForegroundColor Gray
}

# ── Build new task ──────────────────────────────────────────────────────
Write-Host "[2/3] Building new task definition..." -ForegroundColor White

# Trigger: AtStartup with delay
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = $StartupDelay

# Action: run the bat file
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatPath`""

# Principal: run as karen, highest privileges, run whether logged on or not
# LogonType S4U = run whether user is logged on or not (no stored password needed for some cases)
# We use Password logon type via Register-ScheduledTask -Password instead
$principal = New-ScheduledTaskPrincipal -UserId $UserName -RunLevel Highest -LogonType Password

# Settings
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -RestartCount $RestartCount `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

Write-Host "  Done." -ForegroundColor Gray

# ── Register ────────────────────────────────────────────────────────────
Write-Host "[3/3] Registering task (you will be prompted for $UserName's password)..." -ForegroundColor White
Write-Host ""

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
$task.Author = "MyBot fix-autostart-task.ps1"
$task.Description = "Starts WSL + Docker + MyBot container on system startup. Runs whether user is logged on or not."

# Prompt for password — required for "run whether user is logged on or not"
$cred = Get-Credential -UserName $UserName -Message "Enter password for '$UserName' to register the scheduled task"
$plainPassword = $cred.GetNetworkCredential().Password

Register-ScheduledTask -TaskName $TaskName -InputObject $task -User $UserName -Password $plainPassword

# Clear password from memory
$plainPassword = $null
[System.GC]::Collect()

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Task registered successfully!"              -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""

# ── Verify ──────────────────────────────────────────────────────────────
$verify = Get-ScheduledTask -TaskName $TaskName
Write-Host "[VERIFY] Task state:" -ForegroundColor Cyan
Write-Host "  Status        : $($verify.State)" -ForegroundColor Cyan
$vTrigger = $verify.Triggers | Select-Object -First 1
Write-Host "  Trigger type  : $($vTrigger.CimClass.CimClassName)" -ForegroundColor Cyan
Write-Host "  Trigger delay : $($vTrigger.Delay)" -ForegroundColor Cyan
Write-Host "  Run level     : $($verify.Principal.RunLevel)" -ForegroundColor Cyan
Write-Host "  Logon type    : $($verify.Principal.LogonType)" -ForegroundColor Cyan
$vSettings = $verify.Settings
Write-Host "  DisallowOnBatt: $($vSettings.DisallowStartIfOnBatteries)" -ForegroundColor Cyan
Write-Host "  StopOnBatt    : $($vSettings.StopIfGoingOnBatteries)" -ForegroundColor Cyan
Write-Host "  StartWhenAvail: $($vSettings.StartWhenAvailable)" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  - The task will run automatically 60s after the next system startup." -ForegroundColor White
Write-Host "  - To test immediately:  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
Write-Host "  - To view in GUI:       taskschd.msc" -ForegroundColor White
Write-Host ""
