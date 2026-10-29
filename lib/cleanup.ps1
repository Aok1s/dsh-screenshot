# dsh-screenshot - remove orphaned hotkey watchers.
#
# hotkey.ps1 is a child of the harness process, so a normal unload kills it with
# the plugin. A crash or a hard restart can leave one behind, and two watchers
# mean one press fires two captures. This runs once at plugin load, before a new
# watcher starts.
#
# The match is on the script file name plus our plugin folder, and this script's
# own command line only contains "cleanup.ps1", so it cannot stop itself.

$ErrorActionPreference = 'SilentlyContinue'

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-screenshot*' -and $_.CommandLine -like '*hotkey.ps1*' } |
  ForEach-Object {
    if ($_.ProcessId -ne $PID) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }

exit 0
