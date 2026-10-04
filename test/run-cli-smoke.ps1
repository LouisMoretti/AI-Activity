# Runs one tool's real CLI smoke test on Windows (collector-cli-smoke.yml).
# The test can leave CLI child processes holding its output open, so it runs
# with a hard timeout and its whole process tree is killed when it expires.
param(
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Tool,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$File,
  [ValidateRange(1, 3600)][int]$TimeoutSec = 120
)
$start = Get-Date
$stdout = Join-Path $env:RUNNER_TEMP "cli-$Tool.out"
$stderr = Join-Path $env:RUNNER_TEMP "cli-$Tool.err"
$test = Start-Process node -PassThru -NoNewWindow `
  -ArgumentList @('--test', '--test-force-exit', "--test-name-pattern=$Tool", $File) `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$finished = $test.WaitForExit($TimeoutSec * 1000)
if (-not $finished) {
  taskkill /PID $test.Id /T /F | Out-Null
}
Get-Content $stdout
Get-Content $stderr
if (-not $finished) { throw "$Tool CLI smoke timed out after $TimeoutSec seconds" }
Write-Output "$Tool smoke elapsed: $((Get-Date) - $start)"
if ($test.ExitCode -ne 0) { exit $test.ExitCode }
