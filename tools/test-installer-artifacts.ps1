param([string]$MsiPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Inspect the real package and evaluate its compiled conditions without installing
# it, writing registry keys, or depending on this computer's installed applications.
if (-not $MsiPath) {
    $taskConfig = Get-Content (Join-Path $PSScriptRoot '../src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
    $MsiPath = Join-Path $PSScriptRoot "../src-tauri/target/release/bundle/msi/P2Sharer_$($taskConfig.version)_x64_en-US.msi"
}
$MsiPath = (Resolve-Path -LiteralPath $MsiPath).Path
$taskInstaller = New-Object -ComObject WindowsInstaller.Installer
$taskDatabase = $taskInstaller.OpenDatabase($MsiPath, 0)
$taskSession = $taskInstaller.OpenPackage($MsiPath, 1)

function Read-Table([string]$Query) {
    $view = $taskDatabase.OpenView($Query)
    $view.Execute() | Out-Null
    try {
        while ($record = $view.Fetch()) {
            $count = $record.GetType().InvokeMember('FieldCount', 'GetProperty', $null, $record, $null)
            $values = @()
            for ($index = 1; $index -le $count; $index++) {
                $values += $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @($index))
            }
            ,$values
        }
    } finally { $view.Close() | Out-Null }
}

function Set-Property([string]$Name, [string]$Value) {
    $taskSession.GetType().InvokeMember('Property', 'SetProperty', $null, $taskSession, @($Name, $Value)) | Out-Null
}

function Get-Property([string]$Name) {
    $taskSession.GetType().InvokeMember('Property', 'GetProperty', $null, $taskSession, @($Name))
}

function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}

$taskConditions = @{}
foreach ($row in Read-Table 'SELECT `Component`, `Condition` FROM `Component`') {
    $taskConditions[$row[0]] = $row[1]
}
$taskActions = @{}
$taskSequence = @{}
foreach ($row in Read-Table 'SELECT `Action`, `Condition`, `Sequence` FROM `InstallExecuteSequence`') {
    $taskActions[$row[0]] = $row[1]
    $taskSequence[$row[0]] = [int]$row[2]
}
foreach ($row in Read-Table 'SELECT `Action`, `Type`, `Source`, `Target` FROM `CustomAction`') {
    if ($row[0] -in @('SetNsisUserInstallDir', 'SetNsisMachineInstallDir')) {
        Assert-True ($row[1] -eq '51' -and $row[2] -eq 'INSTALLDIR') 'Directory assignment must remain a property-only action.'
    }
}
foreach ($action in @('SetNsisUserInstallDir', 'SetNsisMachineInstallDir')) {
    Assert-True ($taskSequence.AppSearch -lt $taskSequence[$action] -and $taskSequence[$action] -lt $taskSequence.CostInitialize) 'Migration directory selection must follow discovery and precede costing.'
}

$taskUpgrade = @(Read-Table 'SELECT `UpgradeCode`, `ActionProperty` FROM `Upgrade`')
Assert-True ([bool]($taskUpgrade | Where-Object { $_[0] -eq '{7B204CCF-F6BA-5DDC-A719-CDF73E84CE2D}' -and $_[1] -eq 'WIX_UPGRADE_DETECTED' })) 'The published MSI upgrade identity changed.'
foreach ($name in @('FindRelatedProducts', 'RemoveExistingProducts', 'RemoveFiles', 'RemoveRegistryValues')) {
    Assert-True ($taskActions.ContainsKey($name)) "Missing MSI action: $name"
}

function Reset-Scenario {
    foreach ($scope in @('USER', 'MACHINE')) {
        foreach ($field in @('NAME', 'PUBLISHER', 'BINARY', 'DIR')) {
            Set-Property "P2_NSIS_${scope}_$field" ''
        }
    }
    Set-Property 'Installed' ''
    Set-Property 'WIX_UPGRADE_DETECTED' ''
    Set-Property 'INSTALLDIR' 'C:\InstallerFixture\MSI\'
}

function Set-Nsis([string]$Scope) {
    Set-Property "P2_NSIS_${Scope}_NAME" 'P2Sharer'
    Set-Property "P2_NSIS_${Scope}_PUBLISHER" 'p2sharer'
    Set-Property "P2_NSIS_${Scope}_BINARY" 'p2sharer.exe'
    Set-Property "P2_NSIS_${Scope}_DIR" "C:\InstallerFixture\$Scope\"
}

function Matches([string]$Condition) {
    # Windows Installer returns 1 for true and 0 for false, 2/3 for absent/error.
    $result = $taskSession.EvaluateCondition($Condition)
    Assert-True ($result -in @(0, 1)) "Invalid compiled MSI condition: $Condition"
    $result -eq 1
}

Reset-Scenario
Assert-True (-not (Matches $taskConditions.MigrateNsisUser)) 'A clean install must not migrate a user installation.'
Assert-True (-not (Matches $taskConditions.MigrateNsisMachine)) 'A clean install must not migrate a machine installation.'

foreach ($scope in @('USER', 'MACHINE')) {
    Reset-Scenario
    Set-Nsis $scope
    $component = if ($scope -eq 'USER') { 'MigrateNsisUser' } else { 'MigrateNsisMachine' }
    $action = if ($scope -eq 'USER') { 'SetNsisUserInstallDir' } else { 'SetNsisMachineInstallDir' }
    Assert-True (Matches $taskConditions[$component]) "$scope NSIS registration was not recognized."
    Assert-True (Matches $taskActions[$action]) "$scope NSIS install directory was not selected."
    $taskSession.DoAction($action) | Out-Null
    Assert-True ((Get-Property 'INSTALLDIR') -eq "C:\InstallerFixture\$scope\") 'The compiled directory assignment did not preserve the old location.'
    foreach ($field in @('NAME', 'PUBLISHER', 'BINARY', 'DIR')) {
        Reset-Scenario
        Set-Nsis $scope
        Set-Property "P2_NSIS_${scope}_$field" ''
        Assert-True (-not (Matches $taskConditions[$component])) "Missing $field allowed unrelated registration cleanup."
        Assert-True (-not (Matches $taskActions[$action])) "Missing $field allowed directory adoption."
    }
    Reset-Scenario
    Set-Nsis $scope
    Set-Property "P2_NSIS_${scope}_PUBLISHER" 'Other publisher'
    Assert-True (-not (Matches $taskConditions[$component])) 'An unrelated publisher must not be migrated.'
    Set-Nsis $scope
    Set-Property 'WIX_UPGRADE_DETECTED' '{00000000-0000-0000-0000-000000000001}'
    Assert-True (-not (Matches $taskActions[$action])) 'An MSI upgrade must retain its own installation directory.'
    Set-Property 'WIX_UPGRADE_DETECTED' ''
    Set-Property 'Installed' '1'
    Assert-True (-not (Matches $taskActions[$action])) 'MSI maintenance must not change its installation directory.'
}

Reset-Scenario
Set-Nsis 'USER'
Set-Nsis 'MACHINE'
Assert-True (Matches $taskActions.SetNsisUserInstallDir) 'User installation should take priority when both NSIS scopes exist.'
Assert-True (-not (Matches $taskActions.SetNsisMachineInstallDir)) 'Both NSIS directory assignments must not run together.'

$taskRemoval = @(Read-Table 'SELECT `Component_`, `FileName`, `DirProperty`, `InstallMode` FROM `RemoveFile`')
$taskMigrationRemoval = @($taskRemoval | Where-Object { $_[0] -in @('MigrateNsisUser', 'MigrateNsisMachine') })
Assert-True ($taskMigrationRemoval.Count -eq 8) 'Expected exact binary, uninstaller and shortcut cleanup in both scopes.'
foreach ($row in $taskMigrationRemoval) {
    $fileName = ($row[1] -split '\|')[-1]
    Assert-True ($fileName -in @('p2sharer.exe', 'uninstall.exe', 'P2Sharer.lnk')) 'Migration must not remove profiles or arbitrary files.'
    Assert-True ($row[3] -eq '1') 'Legacy files must only be removed when installing the migration component.'
}
$taskRegistryRemoval = @(Read-Table 'SELECT `Root`, `Key`, `Component_` FROM `RemoveRegistry`')
foreach ($scope in @(@('1', 'MigrateNsisUser'), @('2', 'MigrateNsisMachine'))) {
    Assert-True ([bool]($taskRegistryRemoval | Where-Object { $_[0] -eq $scope[0] -and $_[1] -eq 'Software\Microsoft\Windows\CurrentVersion\Uninstall\P2Sharer' -and $_[2] -eq $scope[1] })) 'Missing legacy uninstall registration cleanup.'
}
Write-Output 'Installer artifact checks passed: stable upgrade identity, compiled migration conditions, directory selection and restricted cleanup. No installation was performed.'
