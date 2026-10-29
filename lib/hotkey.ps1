# dsh-screenshot - global hotkey watcher.
#
# The harness has no OS-level hotkey service, and a browser page only sees keys
# while it has focus - which is the opposite of what a screenshot key needs. So
# the host keeps this small PowerShell process alive and it polls the physical
# key state:
#
#   Ctrl + Alt + Z, edge-triggered (one POST per press, not one per 40ms poll),
#   POSTed to the host's own loopback route, which does the capture.
#
# It is deliberately dumb: no window, no UI, no retry storm - if the host is not
# listening it swallows the error and keeps watching. The host kills it on
# unload, and cleanup.ps1 removes orphans left by a crash.

param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$HostName = '127.0.0.1',
  [string]$Endpoint = '/dsh-screenshot/hotkey',
  [int]$PollMs = 40
)

$ErrorActionPreference = 'Stop'

if (-not ('HFShot.Keys' -as [type])) {
  Add-Type -Namespace HFShot -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
'@
}

$VK_CONTROL = 0x11
$VK_MENU    = 0x12   # Alt
$VK_Z       = 0x5A

$url = "http://${HostName}:${Port}${Endpoint}"

function Test-Down([int]$vk) {
  return (([HFShot.Keys]::GetAsyncKeyState($vk)) -band 0x8000) -ne 0
}

# Edge state: true while the combo is held, so a hold does not fire repeatedly.
$held = $false

while ($true) {
  try {
    $combo = (Test-Down $VK_CONTROL) -and (Test-Down $VK_MENU) -and (Test-Down $VK_Z)
    if ($combo) {
      if (-not $held) {
        $held = $true
        try {
          $request = [System.Net.WebRequest]::Create($url)
          $request.Method = 'POST'
          $request.ContentLength = 0
          $request.Timeout = 4000
          $request.ReadWriteTimeout = 4000
          [void]$request.Headers.Add('x-dsh-screenshot-hotkey', $Token)
          $response = $request.GetResponse()
          $response.Dispose()
        }
        catch {
          # Host not up yet / restarting: keep watching, next press retries.
        }
      }
    }
    else {
      $held = $false
    }
  }
  catch {
    $held = $false
  }
  Start-Sleep -Milliseconds $PollMs
}
