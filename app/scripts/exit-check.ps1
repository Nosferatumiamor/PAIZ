# Vérifie que fermer PAIZ ne laisse aucun processus derrière lui.
# Usage : .\exit-check.ps1 -Exe <chemin de PAIZ-WeightStream.exe> [-WaitStart 25] [-Force]
#   par défaut la fenêtre est fermée proprement (comme le ferait l'utilisateur) ; -Force tue seulement la fenêtre (plantage).
param([Parameter(Mandatory)][string]$Exe, [int]$WaitStart = 25, [switch]$Force)
$before = @{}; Get-Process | ForEach-Object { $before[$_.Id] = $true }
$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep $WaitStart
function Tree($rootPid) {
  $all = Get-CimInstance Win32_Process; $out = @(); $queue = @($rootPid)
  while ($queue.Count) { $id = $queue[0]; $queue = $queue[1..($queue.Count)] | Where-Object { $_ }; foreach ($c in ($all | Where-Object ParentProcessId -eq $id)) { $out += $c; $queue += $c.ProcessId } }
  $out
}
$kids = Tree $p.Id
"--- processus lancés par PAIZ (pid $($p.Id)) : $($kids.Count)"
$kids | ForEach-Object { "  $($_.ProcessId) $($_.Name) $([math]::Round($_.WorkingSetSize/1MB)) Mo" }
$ids = @($p.Id) + @($kids.ProcessId)
if ($Force) { Stop-Process -Id $p.Id -Force } else { [void]$p.CloseMainWindow(); [void]$p.WaitForExit(15000) }
Start-Sleep 8
$left = Get-CimInstance Win32_Process | Where-Object { -not $before[[int]$_.ProcessId] -and $_.ProcessId -ne $PID -and $_.Name -notmatch '^(powershell|conhost|WmiPrvSE|pwsh)' }
"--- encore vivants 8 s après la fermeture : $(@($left).Count)"
$left | ForEach-Object { "  $($_.ProcessId) (parent $($_.ParentProcessId)) $($_.Name) $([math]::Round($_.WorkingSetSize/1MB)) Mo  $(($_.CommandLine + '').Substring(0, [math]::Min(100, ($_.CommandLine + '').Length)))" }
