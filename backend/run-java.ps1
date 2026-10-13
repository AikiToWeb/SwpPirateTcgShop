param([switch]$Build)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$selectedJavaHome = $null
$jdkCandidates = @($env:JAVA_HOME) + @(Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.jdks') -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
foreach ($jdkDirectory in $jdkCandidates) {
    if (-not $jdkDirectory) { continue }
    $javaBinary = Join-Path $jdkDirectory 'bin/java.exe'
    if (-not (Test-Path -LiteralPath $javaBinary)) { continue }
    $candidateVersion = (& $javaBinary -version 2>&1 | Out-String)
    if ($candidateVersion -match 'version "(\d+)' -and [int]$Matches[1] -ge 21) { $selectedJavaHome = $jdkDirectory; break }
}
if ($selectedJavaHome) { $env:JAVA_HOME = $selectedJavaHome; $env:PATH = "$selectedJavaHome/bin;$env:PATH" }
$versionText = (& java -version 2>&1 | Out-String)
if (-not ($versionText -match 'version "(\d+)') -or [int]$Matches[1] -lt 21) { throw 'Java 21 이상을 설치하고 JAVA_HOME을 설정하세요.' }
$jarFile = Join-Path $PSScriptRoot 'target/swp-shop-0.2.0.jar'
if ($Build -or -not (Test-Path -LiteralPath $jarFile)) {
    $cacheDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) '.maven-cache'
    & mvn.cmd "-Dmaven.repo.local=$cacheDirectory" -DskipTests package
    if ($LASTEXITCODE -ne 0) { throw 'Java 빌드 실패' }
}
& java -jar $jarFile
