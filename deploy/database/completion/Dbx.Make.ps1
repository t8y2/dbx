# Dot-source this file to complete DBX database Make targets and DB=<product>@<version> values.

$script:DbxMakeRepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

function Get-DbxMakeDatabaseSelector {
    & node (Join-Path $script:DbxMakeRepositoryRoot 'scripts\database-env.mjs') selectors 2>$null
}

function Get-DbxMakeTarget {
    & node (Join-Path $script:DbxMakeRepositoryRoot 'scripts\database-env.mjs') make-targets 2>$null
}

function New-DbxMakeCompletionResult {
    param([string]$Value, [string]$ToolTip = $Value)
    [System.Management.Automation.CompletionResult]::new(
        $Value,
        $Value,
        [System.Management.Automation.CompletionResultType]::ParameterValue,
        $ToolTip
    )
}

$script:DbxMakeDatabaseTargets = @('db', 'db-verify', 'db-down', 'db-reset')

$script:DbxMakeNativeCompleter = {
    param($wordToComplete, $commandAst, $cursorPosition)

    $elements = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
    $target = if ($elements.Count -gt 1) { $elements[1] } else { '' }
    $currentPath = (Resolve-Path -LiteralPath (Get-Location)).Path

    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($currentPath, $script:DbxMakeRepositoryRoot)) { return }

    if ($elements.Count -le 2) {
        Get-DbxMakeTarget |
            Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { New-DbxMakeCompletionResult $_ 'Make target' }
        return
    }

    if ($target -notin $script:DbxMakeDatabaseTargets) { return }
    if ($wordToComplete -like 'DB=*') {
        $prefix = 'DB='
        Get-DbxMakeDatabaseSelector |
            Where-Object { "$prefix$_" -like "$wordToComplete*" } |
            ForEach-Object { New-DbxMakeCompletionResult "$prefix$_" 'Database recipe' }
        return
    }
    if ($wordToComplete -like 'CONFIRM=*') {
        New-DbxMakeCompletionResult 'CONFIRM=1' 'Required by db-reset'
        return
    }

    $parameters = @('DB=', 'DB_BIND_ADDRESS=', 'DB_PORT=', 'DB_PASSWORD=')
    if ($target -eq 'db-reset') { $parameters += 'CONFIRM=1' }
    $parameters |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { New-DbxMakeCompletionResult $_ 'DBX database parameter' }
}

$register = Get-Command Register-ArgumentCompleter
if ($register.Parameters.ContainsKey('Native')) {
    Register-ArgumentCompleter -Native -CommandName make -ScriptBlock $script:DbxMakeNativeCompleter
} else {
    Register-ArgumentCompleter -CommandName make -ScriptBlock {
        param($commandName, $parameterName, $wordToComplete, $commandAst, $fakeBoundParameters)
        & $script:DbxMakeNativeCompleter $wordToComplete $commandAst $null
    }
}
