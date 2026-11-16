<#
.SYNOPSIS
    Деплой pihomecontrol на Raspberry Pi по SSH.

.DESCRIPTION
    Заходит на Pi и запускает tools/deploy.sh: git pull, npm ci, перезапуск
    systemd-сервиса и проверка /login. Пароль sudo спросит в терминале.

.EXAMPLE
    .\deploy\deploy.ps1 -Target pi@192.168.1.50

.EXAMPLE
    .\deploy\deploy.ps1 -Target pi@raspberrypi.local -NoInstall
#>
[CmdletBinding()]
param(
    [string]$Target = "pi@raspberrypi.local",
    [string]$AppDir = "/home/pi/pihomecontrol",
    [switch]$NoPull,
    [switch]$NoInstall
)

$ErrorActionPreference = "Stop"

$flags = @()
if ($NoPull) { $flags += "--no-pull" }
if ($NoInstall) { $flags += "--no-install" }

$remoteCommand = "cd '$AppDir' && bash tools/deploy.sh"
if ($flags.Count -gt 0) {
    $remoteCommand += " " + ($flags -join " ")
}

Write-Host "Деплой на $Target ($AppDir)..."
& ssh -t -o ConnectTimeout=10 $Target $remoteCommand
if ($LASTEXITCODE -ne 0) {
    throw "Деплой не удался (код $LASTEXITCODE). Проверьте SSH-доступ и путь $AppDir."
}

Write-Host "Готово."
