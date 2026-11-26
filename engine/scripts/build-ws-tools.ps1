# Builds the WeightStream MoE tools into build-llama\bin\ next to llama.dll (run build-llama.ps1 first).
# These are compiled directly with cl.exe against the prebuilt llama.cpp DLLs, so a change to
# WeightStream sources never triggers a CUDA rebuild. They are not part of CMakeLists.txt yet.
# -Suffix builds e.g. ws_moe_probe_dev.exe (useful while a benchmark holds the regular exe open); -Only limits the targets
param([string]$Suffix = "", [string[]]$Only = @())
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$L = Join-Path $Root "third_party\llama.cpp"
$B = Join-Path $Root "build-llama"

$VsDev = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$vars = cmd /c "`"$VsDev`" >nul 2>&1 && set"
foreach ($line in $vars) { if ($line -match '^([^=]+)=(.*)$') { [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2]) } }

New-Item -ItemType Directory -Force (Join-Path $B "ws_obj") | Out-Null
Set-Location (Join-Path $B "bin")

$common = @("/nologo", "/O2", "/EHsc", "/std:c++17", "/W4", "/permissive-", "/utf-8", "/DUNICODE", "/D_UNICODE",
            "/I", "$Root\include", "/I", "$L\include", "/I", "$L\ggml\include", "/I", "$L\src", "/I", "$L\common", "/I", "$L\vendor", "/Fo:$B\ws_obj\\")
$libs = @("/link", "$B\src\llama.lib", "$B\ggml\src\ggml.lib", "$B\ggml\src\ggml-base.lib", "$B\ggml\src\ggml-cpu.lib", "$B\common\llama-common.lib")
$ws = @("$Root\src\ExpertSheets.cpp", "$Root\src\ExpertStore.cpp", "$Root\src\DomainRouter.cpp", "$Root\src\GGUFReader.cpp", "$Root\src\RouterLookahead.cpp", "$Root\src\ExpertBudget.cpp")

$failed = 0
foreach ($t in @("moe_probe", "expert_profile", "moe_session", "npc_server")) {
    if ($Only.Count -gt 0 -and $Only -notcontains $t) { continue }
    Write-Host "== ws_$t" -ForegroundColor Cyan
    $extra = @()
    if ($t -eq "npc_server") {
        # cpp-httplib (vendored in llama.cpp) is a 700 KB translation unit: compiled once, reused afterwards
        $http = "$B\ws_obj\httplib.obj"
        if (-not (Test-Path $http)) { & cl @common "/I" "$L\vendor\cpp-httplib" /c "$L\vendor\cpp-httplib\httplib.cpp" "/Fo:$http" }
        $extra = @($http, "/I", "$L\vendor\cpp-httplib")
    }
    & cl @common "$Root\tools\$t.cpp" @ws @extra "/Fe:ws_$t$Suffix.exe" @libs
    if ($LASTEXITCODE -ne 0) { $failed++ }
}
if ($Only.Count -gt 0) { exit $failed }
Write-Host "== ws_ssd_probe" -ForegroundColor Cyan
& cl /nologo /O2 /EHsc /std:c++17 /W4 /DUNICODE /D_UNICODE "/Fo:$B\ws_obj\\" "$Root\tools\ssd_probe.cpp" /Fe:ws_ssd_probe.exe
if ($LASTEXITCODE -ne 0) { $failed++ }
Write-Host "== ws_mem_hog" -ForegroundColor Cyan
& cl /nologo /O2 /EHsc /std:c++17 /W4 /DUNICODE /D_UNICODE "/Fo:$B\ws_obj\\" "$Root\tools\mem_hog.cpp" /Fe:ws_mem_hog.exe
if ($LASTEXITCODE -ne 0) { $failed++ }
Write-Host "== ws_run_capped" -ForegroundColor Cyan
& cl /nologo /O2 /EHsc /std:c++17 /W4 /DUNICODE /D_UNICODE "/Fo:$B\ws_obj\\" "$Root\tools\run_capped.cpp" /Fe:ws_run_capped.exe
if ($LASTEXITCODE -ne 0) { $failed++ }
exit $failed
