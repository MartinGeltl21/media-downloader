# Builds the desktop app from source, installs it for the current user, and creates Start menu and
# desktop shortcuts. Autostart and the mp3/video console commands are switched on through the app itself,
# the same way as from its tray menu. Pass -NoAutostart or -NoCommands to skip them.
param(
  [switch]$NoAutostart,
  [switch]$NoCommands
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Downloader'
$exePath = Join-Path $installDir 'Downloader.exe'

Get-Process -Name 'Downloader' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $exePath } |
  Stop-Process -Force

Push-Location $root
try {
  node scripts/package.js
  if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
} finally {
  Pop-Location
}

$buildDir = Join-Path $root 'dist\Downloader-win32-x64'
robocopy $buildDir $installDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying to $installDir failed (robocopy exit code $LASTEXITCODE)." }

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $shortcut = $shell.CreateShortcut((Join-Path $dir 'Downloader.lnk'))
  $shortcut.TargetPath = $exePath
  $shortcut.WorkingDirectory = $installDir
  $shortcut.IconLocation = "$exePath,0"
  $shortcut.Description = 'Download videos as MP4 or audio as MP3/WAV'
  $shortcut.Save()
}

# Earlier versions autostarted through a Startup folder shortcut; the app now uses the login items instead.
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'Downloader.lnk') -ErrorAction SilentlyContinue

$arguments = @('--hidden')
if (-not $NoAutostart) { $arguments += '--enable-autostart' }
if (-not $NoCommands) { $arguments += '--enable-commands' }
Start-Process -FilePath $exePath -ArgumentList $arguments

Write-Host "Installed to $installDir"
if (-not $NoAutostart) { Write-Host 'Downloader starts with Windows and waits in the tray.' }
if (-not $NoCommands) { Write-Host 'Open a new terminal and type "mp3" or "video" to open it.' }
