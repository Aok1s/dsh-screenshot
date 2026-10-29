# dsh-screenshot - grab the desktop into a PNG.
#
# Called per capture by index.js. One run = one screenshot:
#   1. enumerate the harness process' own top-level windows (Chrome_WidgetWin_1)
#      instead of trusting MainWindowHandle, which drifts between the pet widget
#      and the real GUI window;
#   2. optionally hide them (SW_HIDE) and wait for the compositor to actually
#      drop them, otherwise the capture still contains the hidden window;
#   3. CopyFromScreen over the whole virtual desktop (all monitors);
#   4. always restore the windows in `finally` - a screenshot must never be able
#      to leave the app invisible, not even when an exception is thrown;
#   5. downscale to MaxWidth (a PNG of a 4K desktop is needlessly heavy) and save;
#   6. print one compact JSON line the host parses.
#
# Exit code 0 + {"ok":true,...} on success; non-zero + {"ok":false,"error":...}
# on failure, so the caller never has to scrape English error text.

param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$TargetPid = 0,
  [string]$WindowTitle = '',
  [string]$WindowTitleFile = '',
  [string]$Hide = 'false',
  [int]$MaxWidth = 2400
)

$ErrorActionPreference = 'Stop'
$wantHide = ($Hide -eq 'true')

# The window title comes from the page (document.title) and contains Chinese.
# Passing it as a file keeps it out of the command line, where the console code
# page would mangle it.
if ($WindowTitleFile -ne '' -and (Test-Path -LiteralPath $WindowTitleFile)) {
  $WindowTitle = ([System.IO.File]::ReadAllText($WindowTitleFile, [System.Text.Encoding]::UTF8)).Trim()
}

function Write-Result([hashtable]$Payload) {
  $Payload | ConvertTo-Json -Compress -Depth 4 | Write-Output
}

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms

  if (-not ('HFShot.Win2' -as [type])) {
    Add-Type -Namespace HFShot -Name Win2 -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("dwmapi.dll")] public static extern int DwmFlush();
'@
  }

  # Physical pixels, otherwise a 150% display yields a scaled, blurry desktop.
  [void][HFShot.Win2]::SetProcessDPIAware()

  # --- which windows are "us" ----------------------------------------------
  # Every visible top-level Chromium window on the desktop, whatever process owns
  # it. Why not just this process: the GUI is shown by the Electron shell, which
  # is not the process the host plugin runs in (the backend), and the shell's pid
  # is not necessarily readable from here. The window title, however, is the page
  # title the client sends along, so it identifies the window exactly.
  $script:found = New-Object System.Collections.Generic.List[object]
  $callback = {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if ([HFShot.Win2]::IsWindowVisible($hWnd)) {
      $klass = New-Object System.Text.StringBuilder 256
      [void][HFShot.Win2]::GetClassName($hWnd, $klass, $klass.Capacity)
      if ($klass.ToString() -eq 'Chrome_WidgetWin_1') {
        $owner = [uint32]0
        [void][HFShot.Win2]::GetWindowThreadProcessId($hWnd, [ref]$owner)
        $length = [HFShot.Win2]::GetWindowTextLength($hWnd)
        $title = New-Object System.Text.StringBuilder ([Math]::Max(1, $length + 2))
        [void][HFShot.Win2]::GetWindowText($hWnd, $title, $title.Capacity)
        $rect = New-Object HFShot.Win2+RECT
        [void][HFShot.Win2]::GetWindowRect($hWnd, [ref]$rect)
        $w = $rect.Right - $rect.Left
        $h = $rect.Bottom - $rect.Top
        # The desktop pet is a 48x48 window: never a screenshot target.
        if ($w -ge 100 -and $h -ge 100) {
          $script:found.Add([pscustomobject]@{
            handle = $hWnd
            pid    = $owner
            title  = $title.ToString()
            width  = $w
            height = $h
          })
        }
      }
    }
    return $true
  }
  [void][HFShot.Win2]::EnumWindows($callback, [IntPtr]::Zero)

  $windows = @()

  # Preferred: exact window-title match (the title the client sent).
  if ($WindowTitle -ne '') {
    $windows = @($script:found | Where-Object { $_.title -eq $WindowTitle })
  }
  # Fallback: the biggest Chromium window owned by TargetPid (the process passed
  # in from JS), so behaviour stays sane when the title is missing or stale.
  if ($windows.Count -eq 0 -and $TargetPid -gt 0) {
    $windows = @($script:found | Where-Object { $_.pid -eq $TargetPid } |
      Sort-Object { $_.width * $_.height } -Descending | Select-Object -First 1)
  }
  # Last resort: the biggest Chromium window titled like the harness at all.
  if ($windows.Count -eq 0) {
    $windows = @($script:found | Where-Object { $_.title -like '*DeepSeek Harness*' } |
      Sort-Object { $_.width * $_.height } -Descending | Select-Object -First 1)
  }

  $wasHidden = @()
  $bitmap = $null
  $graphics = $null
  try {
    if ($wantHide) {
      foreach ($w in $windows) {
        [void][HFShot.Win2]::ShowWindow($w.handle, 0)   # SW_HIDE
        $wasHidden += $w
      }
      if ($wasHidden.Count -gt 0) {
        # Let DWM actually remove the window from the composited desktop; without
        # this the capture still contains the window it was asked to exclude.
        for ($i = 0; $i -lt 3; $i++) {
          [void][HFShot.Win2]::DwmFlush()
          Start-Sleep -Milliseconds 120
        }
      }
    }

    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($vs.Width -le 0 -or $vs.Height -le 0) { throw 'virtual screen has no size' }

    $bitmap = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  }
  finally {
    if ($graphics) { $graphics.Dispose() }
    foreach ($w in $wasHidden) {
      [void][HFShot.Win2]::ShowWindow($w.handle, 5)   # SW_SHOW
      [void][HFShot.Win2]::SetForegroundWindow($w.handle)
    }
  }

  if (-not $bitmap) { throw 'capture produced no bitmap' }

  # --- downscale + save -----------------------------------------------------
  $width = $bitmap.Width
  $height = $bitmap.Height
  if ($width -gt $MaxWidth) {
    $scale = $MaxWidth / $width
    $nw = [int][math]::Round($width * $scale)
    $nh = [int][math]::Round($height * $scale)
    $small = New-Object System.Drawing.Bitmap($nw, $nh)
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.DrawImage($bitmap, 0, 0, $nw, $nh)
    $sg.Dispose()
    $bitmap.Dispose()
    $bitmap = $small
    $width = $nw
    $height = $nh
  }

  $dir = Split-Path -Parent $OutPath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  $bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()

  $bytes = (Get-Item -LiteralPath $OutPath).Length
  Write-Result @{
    ok        = $true
    path      = $OutPath
    width     = $width
    height    = $height
    bytes     = $bytes
    hidden    = ($wasHidden.Count -gt 0)
    hiddenIds = @($wasHidden | ForEach-Object { $_.title })
    monitors  = @($vs).Count
  }
  exit 0
}
catch {
  if ($bitmap) { try { $bitmap.Dispose() } catch { } }
  Write-Result @{ ok = $false; error = [string]$_.Exception.Message }
  exit 1
}
