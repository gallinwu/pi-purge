<#
  Builds dist/pi-purge-editor.exe from editor/*.cs.

    powershell -ExecutionPolicy Bypass -File .\tools\build-editor.ps1

  Needs nothing but Windows: it compiles with the C# compiler bundled with
  .NET Framework 4.x, so there is no SDK, no NuGet and no Node to install.
#>
[CmdletBinding()]
param([switch] $Force)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$sources = Get-ChildItem (Join-Path $root 'editor') -Filter '*.cs' | ForEach-Object { $_.FullName }
if (-not $sources) { throw 'no sources under editor/' }

$outDir = Join-Path $root 'dist'
$exe = Join-Path $outDir 'pi-purge-editor.exe'

$csc = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'No C# compiler found (.NET Framework 4.x ships with Windows 8+).' }

if ((Test-Path $exe) -and (-not $Force)) {
  $newest = ($sources | ForEach-Object { (Get-Item $_).LastWriteTimeUtc } | Measure-Object -Maximum).Maximum
  if ((Get-Item $exe).LastWriteTimeUtc -ge $newest) { Write-Host "up to date: $exe"; exit 0 }
}

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$refs = @('System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Core.dll')
$cscArgs = @(
  '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/warn:4',
  "/out:$exe"
) + ($refs | ForEach-Object { "/reference:$_" }) + $sources

Write-Host "compiling with $csc"
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

$info = Get-Item $exe
Write-Host ("built {0} ({1:N0} bytes)" -f $info.FullName, $info.Length)
