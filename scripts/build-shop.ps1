param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$inventoryProjectRoot = Split-Path $PSScriptRoot -Parent
$selectedJavaHome = $null
$jdkCandidates = @($env:JAVA_HOME) + @(Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.jdks') -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
foreach ($jdkDirectory in $jdkCandidates) {
    if (-not $jdkDirectory) { continue }
    $javaBinary = Join-Path $jdkDirectory 'bin/java.exe'
    if (-not (Test-Path -LiteralPath $javaBinary)) { continue }
    $candidateVersion = (& $javaBinary -version 2>&1 | Out-String)
    if ($candidateVersion -match 'version "(\d+)' -and [int]$Matches[1] -ge 21) { $selectedJavaHome = $jdkDirectory; break }
}
if (-not $selectedJavaHome) { throw 'Java 21 이상이 필요합니다.' }
$env:JAVA_HOME = $selectedJavaHome
$env:PATH = "$selectedJavaHome/bin;$env:PATH"
Push-Location -LiteralPath (Join-Path $inventoryProjectRoot 'frontend')
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '웹 화면 빌드 실패' }
} finally { Pop-Location }
Push-Location -LiteralPath (Join-Path $inventoryProjectRoot 'backend')
try {
    $mavenCache = Join-Path $inventoryProjectRoot '.maven-cache'
    if ($SkipTests) {
        & mvn.cmd "-Dmaven.repo.local=$mavenCache" -DskipTests package
    } else {
        # Explicit memory-only test URL prevents any inherited external test database selection.
        & mvn.cmd "-Dmaven.repo.local=$mavenCache" '-DTEST_DATABASE_URL=jdbc:h2:mem:shop-build-tests;DB_CLOSE_DELAY=-1' '-DSHOP_IMPORT_ENABLED=false' test package
    }
    if ($LASTEXITCODE -ne 0) { throw '웹/API 통합 JAR 빌드 실패' }
    Write-Output '빌드 완료: backend/target/swp-shop-0.2.0.jar (웹 화면 및 API 포함)'
} finally { Pop-Location }
