param([int]$Port = 18743)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$obsoletePaths = @(
  'apps/api',
  'apps/ai-service',
  'data',
  'deployment/docker/.env.example'
)
foreach ($relativePath in $obsoletePaths) {
  if (Test-Path -LiteralPath (Join-Path $repoRoot $relativePath)) {
    throw "Obsolete backend artifact returned: $relativePath"
  }
}

node --check apps/web/src/main.js
node --check apps/web/src/core/utils.js
node --check apps/web/src/core/indexed-db.js
node --check apps/web/src/modules/assistant.js
node --check apps/web/src/modules/deepseek-client.js
node --check apps/web/src/modules/training.js
node --check apps/web/src/modules/pomodoro.js
node --check apps/web/src/modules/live-review.js
node --check apps/web/src/modules/idiom-graph.js
node --check apps/web/src/modules/idiom-taxonomy.js
node --check apps/web/src/modules/peanut800.js
node --check tests/smoke_test.mjs
node --check tests/e2e/assistant_test.mjs
node --check tests/e2e/training_test.mjs
node --check tests/e2e/pomodoro_test.mjs
node --check tests/e2e/live_review_test.mjs
node --check tests/e2e/idiom_graph_test.mjs
node --check tests/e2e/peanut800_test.mjs
node tests/unit/core_contract_test.mjs
node tests/unit/assistant_contract_test.mjs
node tests/unit/training_contract_test.mjs
node tests/unit/pomodoro_contract_test.mjs
node tests/unit/live_review_contract_test.mjs
node tests/unit/idiom_graph_contract_test.mjs
node tests/unit/idiom_taxonomy_test.mjs
node tests/unit/peanut800_contract_test.mjs

$webJob = Start-Job -ScriptBlock {
  param($root, $port)
  Set-Location $root
  python -m http.server $port --bind 127.0.0.1 --directory apps/web
} -ArgumentList $repoRoot, $Port

function Wait-HttpReady {
  param([string]$Url, [string]$Name, [int]$Attempts = 30)
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch {
      if ($attempt -eq $Attempts) { throw "$Name did not become ready at $Url" }
      Start-Sleep -Milliseconds 500
    }
  }
}

try {
  try {
    Wait-HttpReady -Url "http://127.0.0.1:$Port/" -Name 'Static test server'
  } catch {
    Receive-Job $webJob -Keep -ErrorAction SilentlyContinue | Write-Output
    throw
  }
  $env:SHIYI_URL = "http://127.0.0.1:$Port"
  node tests/smoke_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Legacy browser regression failed' }
  node tests/e2e/assistant_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Assistant browser regression failed' }
  node tests/e2e/training_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Training browser regression failed' }
  node tests/e2e/pomodoro_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Pomodoro browser regression failed' }
  node tests/e2e/live_review_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Live review browser regression failed' }
  node tests/e2e/idiom_graph_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Idiom graph browser regression failed' }
  node tests/e2e/peanut800_test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Peanut800 browser regression failed' }
} finally {
  Stop-Job $webJob -ErrorAction SilentlyContinue
  Remove-Job $webJob -Force -ErrorAction SilentlyContinue
  Remove-Item Env:SHIYI_URL -ErrorAction SilentlyContinue
}

Write-Output 'PASS: all Shiyi test layers completed'
