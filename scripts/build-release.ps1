$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$distRoot = Join-Path $repoRoot 'dist'
$deployRoot = Join-Path $distRoot 'shiyi-deploy'

if (-not $deployRoot.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Resolved deployment directory is outside dist.'
}
New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
if (Test-Path -LiteralPath $deployRoot) { Remove-Item -LiteralPath $deployRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $deployRoot 'web') | Out-Null

Copy-Item -Path (Join-Path $repoRoot 'apps\web\*') -Destination (Join-Path $deployRoot 'web') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'deployment\docker\compose.yaml') -Destination $deployRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'deployment\docker\nginx.conf') -Destination $deployRoot

$webZip = Join-Path $distRoot 'shiyi-web.zip'
$deployTar = Join-Path $distRoot 'shiyi-deploy.tar.gz'
if (Test-Path -LiteralPath $webZip) { Remove-Item -LiteralPath $webZip -Force }
if (Test-Path -LiteralPath $deployTar) { Remove-Item -LiteralPath $deployTar -Force }
Compress-Archive -Path (Join-Path $repoRoot 'apps\web\*') -DestinationPath $webZip -CompressionLevel Optimal
tar -czf $deployTar -C $deployRoot .

if (Get-ChildItem -Path $deployRoot -Recurse | Where-Object { $_.FullName -match 'ai-service|\.env|\.db$' }) {
  throw 'Deployment artifact unexpectedly contains local AI files.'
}
Get-FileHash -Algorithm SHA256 $webZip, $deployTar | Select-Object Path, Hash
