#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Consolidates all WSL/MyBot scheduled tasks into a single robust watchdog.

.DESCRIPTION
    Deletes the 4 broken tasks (SSH Watchdog, SSH Autostart, Tailscale Autostart,
    Graceful Shutdown) that run as SYSTEM (cannot access karen WSL) and recreates
    "MyBot Autostart" with:
      - AtStartup trigger (60s delay) for reboots
      - Daily trigger with 5-minute repeat for WSL crash recovery
      - Runs as karen, whether logged on or not
      - Battery restrictions disabled

    Run from an elevated PowerShell:
      powershell -ExecutionPolicy Bypass -File .\scripts\fix-autostart-task.ps1
#>

$ErrorActionPreference = "Stop"

# -- Config --------------------------------------------------------------
$TaskName       = "MyBot Autostart"
$BatPath        = "C:\Users\karen\Desktop\Github Projects\MyBot\wsl-autostart.bat"
$UserName       = "karen"
$StartupDelay   = "PT60S"
$ExecTimeLimit  = "PT10M"
$RestartCount   = 3
$RestartInterval = "PT5M"

$ObsoleteTasks = @(
    "WSL SSH Watchdog",
    "WSL SSH Autostart",
    "WSL Tailscale Autostart",
    "WSL Graceful Shutdown"
)

# -- Admin check ---------------------------------------------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  MyBot Watchdog --Task Consolidation"       -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# -- Step 1: Delete obsolete tasks ---------------------------------------
Write-Host "[1/4] Removing obsolete tasks..." -ForegroundColor White
foreach ($name in $ObsoleteTasks) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "  Deleted: $name" -ForegroundColor Yellow
    } else {
        Write-Host "  Not found (skip): $name" -ForegroundColor Gray
    }
}
Write-Host ""

# -- Step 2: Delete existing MyBot Autostart -----------------------------
Write-Host "[2/4] Removing existing '$TaskName'..." -ForegroundColor White
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    $trigger = $existing.Triggers | Select-Object -First 1
    Write-Host "  Old trigger: $($trigger.CimClass.CimClassName)" -ForegroundColor Yellow
    Write-Host "  Old logon type: $($existing.Principal.LogonType)" -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  Deleted." -ForegroundColor Yellow
} else {
    Write-Host "  Not found --will create fresh." -ForegroundColor Gray
}
Write-Host ""

# -- Step 3: Build new task ----------------------------------------------
Write-Host "[3/4] Building new task..." -ForegroundColor White
Write-Host "  Triggers: AtStartup (60s delay) + Daily repeat every 5 min" -ForegroundColor Green
Write-Host "  User: $UserName (run whether logged on or not)" -ForegroundColor Green
Write-Host "  Battery: allowed on battery, won't stop on battery" -ForegroundColor Green
Write-Host ""

# Trigger 1: AtStartup with delay
$triggerStartup = New-ScheduledTaskTrigger -AtStartup
$triggerStartup.Delay = $StartupDelay

# Trigger 2: Daily at midnight with 5-minute repetition indefinitely
$triggerDaily = New-ScheduledTaskTrigger -Daily -At "12:00AM"
$rep = New-CimInstance -CimClass (Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskRepetitionPattern) -ClientOnly
$rep.Interval = "PT5M"
$rep.StopAtDurationEnd = $false
$triggerDaily.Repetition = $rep

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatPath`""

$principal = New-ScheduledTaskPrincipal -UserId $UserName -RunLevel Highest -LogonType Password

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount $RestartCount `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

# -- Step 4: Register ---------------------------------------------------
Write-Host "[4/4] Registering task (you will be prompted for ${UserName} password)..." -ForegroundColor White
Write-Host ""

$task = New-ScheduledTask -Action $action -Trigger $triggerStartup, $triggerDaily -Principal $principal -Settings $settings
$task.Author = "MyBot fix-autostart-task.ps1"
$task.Description = "Watchdog: checks MyBot every 5 min, boots WSL + Docker if needed. Also runs at startup."

$cred = Get-Credential -UserName $UserName -Message "Enter password for '$UserName' to register the scheduled task"
$plainPassword = $cred.GetNetworkCredential().Password

Register-ScheduledTask -TaskName $TaskName -InputObject $task -User $UserName -Password $plainPassword

$plainPassword = $null
[System.GC]::Collect()

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Task registered successfully!"              -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""

# -- Verify --------------------------------------------------------------
$verify = Get-ScheduledTask -TaskName $TaskName
$verifyInfo = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "[VERIFY]" -ForegroundColor Cyan
Write-Host "  Status        : $($verify.State)" -ForegroundColor Cyan
Write-Host "  Triggers      : $($verify.Triggers.Count)" -ForegroundColor Cyan
foreach ($t in $verify.Triggers) {
    $rep = $(if ($t.Repetition.Interval) { " (repeat every $($t.Repetition.Interval))" } else { "" })
    Write-Host "    - $($t.CimClass.CimClassName)$rep" -ForegroundColor Cyan
}
Write-Host "  Run level     : $($verify.Principal.RunLevel)" -ForegroundColor Cyan
Write-Host "  Logon type    : $($verify.Principal.LogonType)" -ForegroundColor Cyan
$vSettings = $verify.Settings
Write-Host "  DisallowOnBatt: $($vSettings.DisallowStartIfOnBatteries)" -ForegroundColor Cyan
Write-Host "  StopOnBatt    : $($vSettings.StopIfGoingOnBatteries)" -ForegroundColor Cyan
Write-Host "  Next run      : $($verifyInfo.NextRunTime)" -ForegroundColor Cyan
Write-Host ""

# -- Remaining tasks -----------------------------------------------------
Write-Host "[REMAINING TASKS]" -ForegroundColor White
$allTasks = Get-ScheduledTask | Where-Object { $_.TaskName -like '*wsl*' -or $_.TaskName -like '*WSL*' -or $_.TaskName -like '*MyBot*' -or $_.TaskName -like '*docker*' }
foreach ($t in $allTasks) {
    Write-Host "  $($t.TaskName) [$($t.State)]" -ForegroundColor White
}
Write-Host ""
Write-Host "To test now:  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
Write-Host "To verify:    taskschd.msc" -ForegroundColor White
Write-Host ""
