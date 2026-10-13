param([switch]$Full, [switch]$Native)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $root
$work = Join-Path $root 'tmp/mongo-workbench'
foreach ($name in @('temp', 'npm-cache', 'vite-cache', 'cargo-target')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $work $name) | Out-Null
}
# Process-local validation output. The installed Node/Rust toolchains are unchanged.
$env:TEMP = Join-Path $work 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $work 'npm-cache'
$env:DBX_DEV_CACHE_DIR = Join-Path $work 'vite-cache'
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $work 'cargo-target' }
function Run-Node([string[]]$Arguments) {
  & node @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Validation failed: node $($Arguments -join ' ')" }
}
Run-Node @('--max-old-space-size=8192', 'node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit', '--project', 'apps/desktop/tsconfig.json')
Run-Node @('scripts/mongo-workbench-smoke.cjs')
if ($Full) {
  Run-Node @('node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'native', '--pool', 'threads', 'apps/desktop/src/lib/mongo/__tests__', 'apps/desktop/src/components/mongo/__tests__', 'apps/desktop/src/components/diff/__tests__/MongoCompareDialog.spec.ts', 'apps/desktop/src/components/diff/__tests__/MongoCompareConfigBar.spec.ts', 'apps/desktop/src/composables/__tests__/useMongoCompareConfigs.spec.ts', 'apps/desktop/src/composables/__tests__/useDialogSources.mongo.spec.ts', 'apps/desktop/src/composables/__tests__/useSidebarTreeToolRuntime.docs.spec.ts', 'apps/desktop/src/lib/backend/mongoTasks.spec.ts', 'apps/desktop/src/i18n/__tests__/mongoTasks.spec.ts', 'apps/desktop/src/lib/__tests__/imports/studio3tImport.spec.ts', 'apps/desktop/src/stores/__tests__/connectionStore.studio3t.spec.ts', 'apps/desktop/src/composables/__tests__/useDialogSources.spec.ts', 'apps/desktop/src/components/config/__tests__/ConfigConnectionSelectDialog.spec.ts')
  Run-Node @('--require', './scripts/skip-vite-network-drive-probe.cjs', 'node_modules/vite/bin/vite.js', 'build', '--config', 'apps/desktop/vite.config.ts', '--configLoader', 'native')
}
if ($Native) {
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Install the Rust toolchain before native validation.' }
  & cargo test -p dbx-driver-mongodb --lib
  if ($LASTEXITCODE -ne 0) { throw 'Mongo driver Rust tests failed' }
  & cargo test -p dbx-core --no-default-features --features sqlite-bundled --lib mongo_tasks
  if ($LASTEXITCODE -ne 0) { throw 'Mongo task Rust tests failed' }
}
Write-Output 'Requested checks passed. This does not validate browser isolation, live MongoDB behavior or native packaging.'
