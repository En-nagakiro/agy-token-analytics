#Requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PluginDir = Join-Path $HOME '.gemini\config\plugins\agy-token-analytics'

Write-Host "==> Project Root : $ProjectRoot" -ForegroundColor Cyan
Write-Host "==> Target Plugin: $PluginDir" -ForegroundColor Cyan

Push-Location $ProjectRoot
try {
    if (-not $SkipTests) {
        Write-Host "`n[1/4] Running Python parser unit & integration tests..." -ForegroundColor Yellow
        python "$ProjectRoot\parser\test_engine.py"
        if ($LASTEXITCODE -ne 0) { throw "Parser tests failed with exit code $LASTEXITCODE" }
    }

    if (-not $SkipBuild) {
        Write-Host "`n[2/4] Building single-file MCP App UI & Node MCP Server..." -ForegroundColor Yellow
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    }

    Write-Host "`n[3/4] Syncing release bundle to $PluginDir..." -ForegroundColor Yellow
    $dirs = @(
        $PluginDir,
        (Join-Path $PluginDir 'assets'),
        (Join-Path $PluginDir 'parser'),
        (Join-Path $PluginDir 'skills\update-pricing'),
        (Join-Path $PluginDir 'dist'),
        (Join-Path $PluginDir 'dist\ui')
    )
    foreach ($d in $dirs) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }

    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'plugin.json') -Destination $PluginDir -Force
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'mcp_config.json') -Destination $PluginDir -Force
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'README.md') -Destination $PluginDir -Force
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'assets\logo.svg') -Destination (Join-Path $PluginDir 'assets\logo.svg') -Force
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'parser\engine.py') -Destination (Join-Path $PluginDir 'parser\engine.py') -Force
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'skills\update-pricing\SKILL.md') -Destination (Join-Path $PluginDir 'skills\update-pricing\SKILL.md') -Force
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'dist\server.cjs') -Destination (Join-Path $PluginDir 'dist\server.cjs') -Force
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'dist\ui\index.html') -Destination (Join-Path $PluginDir 'dist\ui\index.html') -Force

    Write-Host "`n[4/4] Checking Antigravity Language Server live reload..." -ForegroundColor Yellow
    if ($env:ANTIGRAVITY_LS_ADDRESS -and $env:ANTIGRAVITY_CSRF_TOKEN) {
        $addr = $env:ANTIGRAVITY_LS_ADDRESS.Trim()
        if ($addr -notmatch '^https?://') { $addr = "http://$addr" }
        $headers = @{
            'Content-Type'             = 'application/json'
            'Connect-Protocol-Version' = '1'
            'x-codeium-csrf-token'     = $env:ANTIGRAVITY_CSRF_TOKEN.Trim()
        }
        try {
            Invoke-RestMethod -Uri "$addr/exa.language_server_pb.LanguageServerService/RefreshMcpServers" `
                -Method Post -Headers $headers -Body '{"serverName":"agy-token-analytics_analytics"}' `
                -TimeoutSec 5 -SkipCertificateCheck | Out-Null
            Write-Host "    Refreshed MCP server: agy-token-analytics_analytics" -ForegroundColor Green
        } catch {
            Write-Host "    Note: RefreshMcpServers skipped ($($_.Exception.Message)). Antigravity auto-discovers new plugins automatically." -ForegroundColor DarkGray
        }
    } else {
        Write-Host "    ANTIGRAVITY_LS_ADDRESS not set in this shell; plugin files are ready for auto-discovery." -ForegroundColor DarkGray
    }

    Write-Host "`n[OK] Deployment complete!" -ForegroundColor Green
} finally {
    Pop-Location
}
