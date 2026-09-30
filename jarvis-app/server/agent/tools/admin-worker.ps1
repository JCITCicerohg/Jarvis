# Elevated command worker for Jarvis. Started once per server session via UAC
# (Start-Process -Verb RunAs). Connects back to the server's named pipe, proves
# itself with the session token, then runs each requested command elevated.
param([Parameter(Mandatory)][string]$Pipe, [Parameter(Mandatory)][string]$Token)

$ErrorActionPreference = 'Stop'
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::InOut)
$client.Connect(15000)
$reader = New-Object System.IO.StreamReader($client, (New-Object System.Text.UTF8Encoding($false)))
$writer = New-Object System.IO.StreamWriter($client, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true
$writer.WriteLine((@{ hello = $Token } | ConvertTo-Json -Compress))

while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $req = $line | ConvertFrom-Json
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $req.encoded
    $psi.WorkingDirectory = $req.cwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    $timedOut = -not $p.WaitForExit([int]$req.timeoutMs)
    if ($timedOut) { try { $p.Kill() } catch {} ; $p.WaitForExit(); $code = -1 } else { $code = $p.ExitCode }
    $res = @{ id = $req.id; stdout = $out.Result; stderr = $err.Result; exitCode = $code; timedOut = $timedOut }
  } catch {
    $res = @{ id = $req.id; stdout = ''; stderr = $_.Exception.Message; exitCode = -1; timedOut = $false }
  }
  $writer.WriteLine(($res | ConvertTo-Json -Compress))
}
