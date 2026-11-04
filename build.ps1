# Запуск задач Java-трека chat-abavava.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1 check   # офлайн: компиляция + unit-тесты
#   powershell -ExecutionPolicy Bypass -File build.ps1 db      # PostgreSQL (5433)
#   powershell -ExecutionPolicy Bypass -File build.ps1 run     # API на :8082
#   powershell -ExecutionPolicy Bypass -File build.ps1 smoke   # Go-смоук против Java-API
#   powershell -ExecutionPolicy Bypass -File build.ps1 clean
#
# Примечание: упаковка jar (mvn package) требует артефактов, которых нет в
# офлайн-кэше этой машины (maven-jar-plugin и его зависимости). Поэтому run
# использует classpath, собранный из локального кэша Maven.

param(
    [ValidateSet('check', 'test', 'db', 'run', 'smoke', 'clean', 'package', 'classpath')]
    [string]$Task = 'check'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$mvn = $env:ABV_MVN

if (-not $mvn) {
    $candidates = @(
        'C:\opt\apache-maven-3.9.12\bin\mvn.cmd',
        (Join-Path $env:USERPROFILE 'apache-maven-3.9.12\bin\mvn.cmd')
    )
    $mvn = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $mvn) { $mvn = 'mvn' }
}

$cpFile = Join-Path $root 'target\classpath.txt'
$postgresJar = 'C:\Users\slaff\.m2\repository\org\postgresql\postgresql\42.7.11\postgresql-42.7.11.jar'

function Invoke-Maven([string[]]$Arguments) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location $root
        try {
            & $mvn -o @Arguments
            $code = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) { throw "maven failed: $($Arguments -join ' ')" }
}

# Собирает classpath из debug-вывода компилятора (единственный офлайн-способ,
# если maven-jar-plugin недоступен) и кладёт в target\classpath.txt.
function Get-Classpath {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location $root
        try {
            $out = & $mvn -o -X -DskipTests clean compile 2>&1 | Out-String
            $code = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) { throw 'compile failed while collecting classpath' }
    $entries = New-Object System.Collections.Generic.List[string]
    $inBlock = $false
    foreach ($line in ($out -split "`r?`n")) {
        if ($line -match '^\[DEBUG\] Classpath:$') { $inBlock = $true; continue }
        if ($inBlock) {
            if ($line -match '^\[DEBUG\]\s+(Source roots|Command line options|Classpath|Classpath Elements):') { break }
            if ($line -match '^\[DEBUG\]\s+(.+)$') {
                $candidate = $Matches[1].Trim()
                if ($candidate -match '^[A-Za-z]:\\') {
                    $entries.Add($candidate)
                }
            }
        }
    }
    if ($entries.Count -eq 0) { throw 'could not locate compiler classpath in maven output' }
    if (Test-Path $postgresJar) { $entries.Add($postgresJar) }
    $cp = ($entries | Select-Object -Unique) -join ';'
    New-Item -ItemType Directory -Force (Split-Path $cpFile) | Out-Null
    [System.IO.File]::WriteAllText($cpFile, $cp)
    return $cp
}

switch ($Task) {
    'check' { Invoke-Maven @('-q', '-DskipTests', 'compile'); Invoke-Maven @('-q', 'test') }
    'test' { Invoke-Maven @('test') }
    'package' {
        # Упаковка (исполняемый jar) скачивает недостающие артефакты плагинов
        # с Maven Central — нужен доступ к сети (один раз, далее кэш).
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            Push-Location $root
            try {
                & $mvn -DskipTests package
                $code = $LASTEXITCODE
            } finally {
                Pop-Location
            }
        } finally {
            $ErrorActionPreference = $prev
        }
        if ($code -ne 0) { throw 'maven package failed' }
    }
    'db' {
        Push-Location $root
        try { docker compose up -d postgres } finally { Pop-Location }
    }
    'run' {
        $jar = Join-Path $root 'target\chat-abavava-java-0.1.0-SNAPSHOT.jar'
        if (Test-Path $jar) {
            & java -jar $jar @args
        } else {
            $cp = Get-Classpath
            & java -cp $cp com.abavava.chat.ChatAbavavaJavaApplication @args
        }
    }
    'classpath' {
        Get-Classpath | Out-Null
        Write-Host "classpath written to $cpFile"
    }
    'smoke' {
        $goProject = Join-Path (Split-Path $root -Parent) 'chat-abavava'
        if (-not (Test-Path $goProject)) { throw "Go project not found: $goProject" }
        $base = $env:ABV_SMOKE_BASE
        if (-not $base) { $base = 'http://127.0.0.1:8082' }
        Push-Location $goProject
        try { & go run ./cmd/smoke -base $base } finally { Pop-Location }
    }
    'clean' { Invoke-Maven @('clean') }
}
