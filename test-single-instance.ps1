# 单实例检测验证：先后启动两个客户端，第二个应被拒绝并立即退出
$ErrorActionPreference = 'Continue'
$root = 'D:\migumusic'
$exe  = Join-Path $root 'node_modules\electron\dist\electron.exe'
$log  = Join-Path $root 'second-instance-check.txt'
$lock = Join-Path $env:TEMP 'migu-music-desktop.lock'

Remove-Item $log  -ErrorAction SilentlyContinue
Remove-Item $lock -ErrorAction SilentlyContinue

$env:ELECTRON_DISABLE_SECURITY_WARNINGS = '1'
$env:MIGU_TEST_LOG = $log

Write-Host '=== single instance check ==='

Write-Host '[1] start instance A (background)'
$a = Start-Process -FilePath $exe -ArgumentList @($root, '--smoke', '--no-sandbox', '--disable-gpu') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 5
$aRunning = -not $a.HasExited
Write-Host ("    A pid={0} running={1}" -f $a.Id, $aRunning)

Write-Host '[2] start instance B (should be rejected)'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$b = Start-Process -FilePath $exe -ArgumentList @($root, '--no-sandbox', '--disable-gpu') -PassThru -Wait -WindowStyle Hidden
$sw.Stop()
$bSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
Write-Host ("    B exitcode={0} elapsed={1}s" -f $b.ExitCode, $bSec)

Write-Host '[3] wait for A to finish'
try { $a.WaitForExit(25000) | Out-Null } catch {}

Write-Host '[4] check second-instance notification'
$content = if (Test-Path $log) { (Get-Content $log -Raw) } else { '' }
Write-Host ("    log: {0}" -f ($content -replace '\s+', ' '))

Write-Host '[5] lock released after A exits?'
$lockLeft = Test-Path $lock
Write-Host ("    lock file still there: {0}" -f $lockLeft)

Write-Host '[6] start instance C after A quit (should run normally)'
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
$c = Start-Process -FilePath $exe -ArgumentList @($root, '--smoke', '--no-sandbox', '--disable-gpu') -PassThru -Wait -WindowStyle Hidden
$sw2.Stop()
$cSec = [math]::Round($sw2.Elapsed.TotalSeconds, 1)
Write-Host ("    C exitcode={0} elapsed={1}s" -f $c.ExitCode, $cSec)

Write-Host '[7] stale lock self-heal (simulate a force-killed client)'
$d = Start-Process -FilePath $exe -ArgumentList @($root, '--no-sandbox', '--disable-gpu') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4
Get-Process -Id $d.Id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'electron' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Write-Host ("    stale lock file present: {0}" -f (Test-Path $lock))

Write-Host '[8] start instance E with stale lock present'
$sw3 = [System.Diagnostics.Stopwatch]::StartNew()
$e = Start-Process -FilePath $exe -ArgumentList @($root, '--smoke', '--no-sandbox', '--disable-gpu') -PassThru -Wait -WindowStyle Hidden
$sw3.Stop()
$eSec = [math]::Round($sw3.Elapsed.TotalSeconds, 1)
Write-Host ("    E exitcode={0} elapsed={1}s" -f $e.ExitCode, $eSec)

$fail = 0
if (-not $aRunning) { Write-Host '  [FAIL] instance A was not running when B started'; $fail++ }
else { Write-Host '  [PASS] instance A stayed running' }

if ($bSec -lt 6) { Write-Host '  [PASS] instance B was rejected and exited immediately' }
else { Write-Host '  [FAIL] instance B did not exit quickly'; $fail++ }

if ($content -match 'second-instance') { Write-Host '  [PASS] running instance received second-instance notice' }
else { Write-Host '  [FAIL] running instance got no notice'; $fail++ }

if (-not $lockLeft) { Write-Host '  [PASS] pid lock cleaned up after exit' }
else { Write-Host '  [WARN] pid lock file left behind (should self-heal on next start)' }

if ($cSec -gt 5) { Write-Host '  [PASS] a new instance can start normally after the old one quit' }
else { Write-Host '  [FAIL] new instance was wrongly rejected'; $fail++ }

if ($eSec -gt 5) { Write-Host '  [PASS] stale lock self-healed, client still starts' }
else { Write-Host '  [FAIL] client was blocked by a stale lock'; $fail++ }

Get-Process -Id $a.Id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'electron' } | Stop-Process -Force -ErrorAction SilentlyContinue

if ($fail -eq 0) { Write-Host '=== ALL PASS ===' } else { Write-Host "=== $fail FAILED ===" }
