#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
$pathsep=":"
$env_node_path=$env:NODE_PATH
$new_node_path="C:\pnpm-fixture\global\5\.pnpm\@dbx-app+mcp-server@0.4.71\node_modules\@dbx-app\mcp-server\bin\node_modules;C:\pnpm-fixture\global\5\.pnpm\@dbx-app+mcp-server@0.4.71\node_modules\@dbx-app\mcp-server\node_modules;C:\pnpm-fixture\global\5\.pnpm\@dbx-app+mcp-server@0.4.71\node_modules\@dbx-app\node_modules;C:\pnpm-fixture\global\5\.pnpm\@dbx-app+mcp-server@0.4.71\node_modules;C:\pnpm-fixture\global\5\.pnpm\node_modules"
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
  $pathsep=";"
} else {
  $new_node_path="/pnpm-fixture/global/5/.pnpm/@dbx-app+mcp-server@0.4.71/node_modules/@dbx-app/mcp-server/bin/node_modules:/pnpm-fixture/global/5/.pnpm/@dbx-app+mcp-server@0.4.71/node_modules/@dbx-app/mcp-server/node_modules:/pnpm-fixture/global/5/.pnpm/@dbx-app+mcp-server@0.4.71/node_modules/@dbx-app/node_modules:/pnpm-fixture/global/5/.pnpm/@dbx-app+mcp-server@0.4.71/node_modules:/pnpm-fixture/global/5/.pnpm/node_modules"
}
if ([string]::IsNullOrEmpty($env_node_path)) {
  $env:NODE_PATH=$new_node_path
} else {
  $env:NODE_PATH="$new_node_path$pathsep$env_node_path"
}

$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/../global/5/.pnpm/@dbx-app+mcp-server@0.4.71/node_modules/@dbx-app/mcp-server/bin/dbx-mcp-server.js" $args
  } else {
    & "$basedir/node$exe"  "$basedir/../global/5/.pnpm/@dbx-app+mcp-server@0.4.71/node_modules/@dbx-app/mcp-server/bin/dbx-mcp-server.js" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/../global/5/.pnpm/@dbx-app+mcp-server@0.4.71/node_modules/@dbx-app/mcp-server/bin/dbx-mcp-server.js" $args
  } else {
    & "node$exe"  "$basedir/../global/5/.pnpm/@dbx-app+mcp-server@0.4.71/node_modules/@dbx-app/mcp-server/bin/dbx-mcp-server.js" $args
  }
  $ret=$LASTEXITCODE
}
$env:NODE_PATH=$env_node_path
exit $ret
