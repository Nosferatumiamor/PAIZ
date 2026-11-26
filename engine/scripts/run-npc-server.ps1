# WeightStream launcher: picks a model and a resource profile, starts ws_npc_server and opens the web page.
# The last choice is remembered (ws_npc_data\launcher.json): Enter accepts it. Everything can be given on the command line:
#   .\scripts\run-npc-server.ps1 -Model C:\llm-models\x.gguf -Profile eco -NoBrowser
param(
    [string]$Model = "",
    [ValidateSet("", "eco", "leger", "equilibre", "vif", "ultra", "normal", "confort", "cpu", "partage", "fond")][string]$Profile = "",
    [int]$Port = 8770,
    [string]$ModelsDir = "C:\llm-models",
    [int]$Ctx = 4096,
    [int]$Slots = 2,
    [string]$DeciderModel = "",      # second model loaded next to the main one, answers /v1/decide (e.g. a decision model)
    [ValidateSet("eco", "normal", "confort", "cpu")][string]$DeciderProfile = "normal",
    [int]$DeciderRamMib = 0,         # RAM expert cache of the decider (0 = its profile's)
    [int]$DeciderCacheMib = -1,      # VRAM expert cache of the decider (-1 = its profile's)
    [int]$DeciderUbatch = 0,         # micro-batch of the decider (0 = default 512)
    [switch]$NoVramWarm,            # do not preload the VRAM expert cache after a VRAM swap (for comparisons)
    [switch]$PhaseRam,               # with -AutoPhase: the RAM expert caches also slide between the two models (default: only the VRAM does)
    [switch]$AutoPhase,              # the RAM pool slides by itself: to the decider after each reply, back to the main model after each decision
    [int]$PhasePoolMib = 0,          # RAM shared by the two models' expert caches (0 = 60 % of the machine, at most 20 GB)
    [switch]$NoBrowser,
    [switch]$Ask
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Exe = Join-Path $Root "build-llama\bin\ws_npc_server.exe"
if (-not (Test-Path $Exe)) {
    Write-Host "ws_npc_server.exe not found. Build it first:" -ForegroundColor Red
    Write-Host "  .\scripts\build-llama.ps1   (first time, ~30 min)"
    Write-Host "  .\scripts\build-ws-tools.ps1"
    exit 1
}

# profile -> arguments (RAM expert cache / VRAM expert cache in MB)
$Profiles = [ordered]@{
    eco     = @{ label = "Eco      : expert caches 0.7 GB RAM / 0.5 GB VRAM (slowest, lightest; total footprint is larger: base weights, context)"; args = @("--ws-ram-mib", "700", "--cache-mib", "512") }
    leger   = @{ label = "Leger    : expert caches 1.5 GB RAM / 1.5 GB VRAM, 4-token batches, context 2048, 1 thread, q8 KV (~4 tok/s, ~4 GB VRAM)"; args = @("--ws-ram-mib", "1500", "--cache-mib", "1536", "--ubatch", "4", "--prefill-ubatch", "0", "-c", "2048", "--slots", "1", "--kv-type", "q8_0") }
    ultra   = @{ label = "Ultra    : expert caches 0.7 GB RAM / 0.5 GB VRAM, 4-token batches, context 2048, 1 thread, q8 KV (very slow, minimal RAM and VRAM)"; args = @("--ws-ram-mib", "700", "--cache-mib", "512", "--ubatch", "4", "--prefill-ubatch", "0", "-c", "2048", "--slots", "1", "--kv-type", "q8_0") }
    equilibre = @{ label = "Equilibre: expert caches 2 GB RAM / 3 GB VRAM, 4-token batches, context 4096, 1 thread, q8 KV (~8-10 tok/s, ~5 GB VRAM)"; args = @("--ws-ram-mib", "2000", "--cache-mib", "3072", "--ubatch", "4", "--prefill-ubatch", "0", "-c", "4096", "--slots", "1", "--kv-type", "q8_0") }
    vif     = @{ label = "Vif      : expert caches 3 GB RAM / 4 GB VRAM, 4-token batches, context 4096, 1 thread, q8 KV (~12-15 tok/s, ~6 GB VRAM)"; args = @("--ws-ram-mib", "3000", "--cache-mib", "4096", "--ubatch", "4", "--prefill-ubatch", "0", "-c", "4096", "--slots", "1", "--kv-type", "q8_0") }
    normal  = @{ label = "Normal   : expert caches 3 GB RAM / 1 GB VRAM"; args = @("--ws-ram-mib", "3000", "--cache-mib", "1024") }
    confort = @{ label = "Confort  : expert caches 6 GB RAM / 2 GB VRAM (faster)"; args = @("--ws-ram-mib", "6000", "--cache-mib", "2048") }
    partage = @{ label = "Partage  : adapts to the free RAM/VRAM, leaves ~8 GB RAM and ~1.5 GB VRAM to other programs"; args = @("--profile", "partage") }
    fond    = @{ label = "A fond   : takes almost everything (keeps ~4 GB RAM for Windows); close neighbouring programs first"; args = @("--profile", "fond") }
    cpu     = @{ label = "CPU only : experts computed on the CPU, no VRAM for experts"; args = @("--ws-ram-mib", "3000", "--cpu-stream") }
}

$StateFile = Join-Path $Root "ws_npc_data\launcher.json"
$last = $null
if (Test-Path $StateFile) { try { $last = Get-Content $StateFile -Raw | ConvertFrom-Json } catch { $last = $null } }

Write-Host ""
Write-Host " ========================================" -ForegroundColor Cyan
Write-Host "  WeightStream" -ForegroundColor Cyan
Write-Host " ========================================" -ForegroundColor Cyan

# ---- model ----
if (-not $Model) {
    $found = @()
    if (Test-Path $ModelsDir) { $found = @(Get-ChildItem $ModelsDir -Filter *.gguf -File | Sort-Object Name) }
    if ($found.Count -eq 0) {
        Write-Host "No .gguf found in $ModelsDir (use -Model or -ModelsDir)." -ForegroundColor Red
        exit 1
    }
    $default = 1
    if ($last -and $last.model) { for ($i = 0; $i -lt $found.Count; $i++) { if ($found[$i].FullName -eq $last.model) { $default = $i + 1 } } }
    if ($found.Count -eq 1) {
        $Model = $found[0].FullName
    } elseif ($Ask -or -not $last) {
        Write-Host ""
        Write-Host " Models in ${ModelsDir}:"
        for ($i = 0; $i -lt $found.Count; $i++) {
            $mark = if ($i + 1 -eq $default) { "*" } else { " " }
            Write-Host ("  {0}{1}) {2}  ({3:N1} GB)" -f $mark, ($i + 1), $found[$i].Name, ($found[$i].Length / 1GB))
        }
        $n = Read-Host " Model [$default]"
        if (-not $n) { $n = $default }
        $Model = $found[[int]$n - 1].FullName
    } else {
        $Model = $found[$default - 1].FullName
    }
}
if (-not (Test-Path $Model)) { Write-Host "Model not found: $Model" -ForegroundColor Red; exit 1 }

# ---- profile ----
if (-not $Profile) {
    $keys = @($Profiles.Keys | Where-Object { $_ -ne "eco" })
    $default = 2
    if ($last -and $last.profile) { $default = [array]::IndexOf($keys, [string]$last.profile) + 1; if ($default -lt 1) { $default = [array]::IndexOf($keys, "normal") + 1 } }
    if ($Ask -or -not $last) {
        Write-Host ""
        Write-Host " Resources:"
        for ($i = 0; $i -lt $keys.Count; $i++) {
            $mark = if ($i + 1 -eq $default) { "*" } else { " " }
            Write-Host ("  {0}{1}) {2}" -f $mark, ($i + 1), $Profiles[$keys[$i]].label)
        }
        $n = Read-Host " Profile [$default]"
        if (-not $n) { $n = $default }
        $Profile = $keys[[int]$n - 1]
    } else {
        $Profile = $keys[$default - 1]
    }
}

New-Item -ItemType Directory -Force (Split-Path $StateFile) | Out-Null
@{ model = $Model; profile = $Profile } | ConvertTo-Json | Set-Content $StateFile -Encoding UTF8

$srvArgs = @("-m", $Model, "--port", "$Port", "-c", "$Ctx", "--slots", "$Slots", "--models-dir", $ModelsDir) + $Profiles[$Profile].args
if ($DeciderModel) {
    if (-not (Test-Path $DeciderModel)) { Write-Host "Decider model not found: $DeciderModel" -ForegroundColor Red; exit 1 }
    $srvArgs += @("--decider-model", $DeciderModel, "--decider-profile", $DeciderProfile)
    if ($DeciderRamMib -gt 0) { $srvArgs += @("--decider-ram-mib", "$DeciderRamMib") }
    if ($DeciderCacheMib -ge 0) { $srvArgs += @("--decider-cache-mib", "$DeciderCacheMib") }
    if ($AutoPhase) { $srvArgs += "--auto-phase" }
    if ($DeciderUbatch -gt 0) { $srvArgs += @("--decider-ubatch", "$DeciderUbatch") }
    if ($NoVramWarm) { $srvArgs += "--no-vram-warm" }
    if ($PhaseRam) { $srvArgs += "--phase-ram-slide" }
    if ($PhasePoolMib -gt 0) { $srvArgs += @("--phase-pool-mib", "$PhasePoolMib") }
}
Write-Host ""
Write-Host (" Model   : " + (Split-Path $Model -Leaf)) -ForegroundColor Green
Write-Host (" Profile : " + $Profile) -ForegroundColor Green
Write-Host (" Page    : http://127.0.0.1:$Port/   (Ctrl+C here to stop; pre-caches and threads are saved)") -ForegroundColor Green
Write-Host " Re-run with -Ask to change the model or profile."
Write-Host ""

# open the browser once the service answers (the model itself loads at the first request)
if (-not $NoBrowser) {
    Start-Job -ArgumentList $Port -ScriptBlock {
        param($p)
        for ($i = 0; $i -lt 60; $i++) {
            try { Invoke-WebRequest "http://127.0.0.1:$p/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process "http://127.0.0.1:$p/"; break } catch { Start-Sleep -Milliseconds 500 }
        }
    } | Out-Null
}

& $Exe @srvArgs
$code = $LASTEXITCODE
Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { Write-Host "ws_npc_server exited with code $code" -ForegroundColor Red }
exit $code
