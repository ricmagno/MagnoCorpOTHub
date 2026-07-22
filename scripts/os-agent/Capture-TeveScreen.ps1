<#
.SYNOPSIS
  TEVE os-agent: captures the console screen of a thick-client SCADA node (e.g.
  AVEVA Plant SCADA runtime) and uploads it to the TEVE historian API.

.DESCRIPTION
  Grabs the primary display via .NET (Graphics.CopyFromScreen), encodes it as PNG,
  and POSTs it to /api/historian/screenshots/upload with the admin Bearer token.
  Runs once by default; pass -IntervalSeconds to loop forever.

  REQUIREMENTS / GOTCHAS
  - Must run in the INTERACTIVE session of the logged-on user showing the SCADA
    runtime. From Task Scheduler, choose "Run only when user is logged on" —
    a session-0 / "whether user is logged on or not" task captures nothing.
  - A locked console produces black frames: the display node must stay unlocked
    (typical for a dedicated kiosk/operator display; check site screensaver policy).
  - Works on Windows PowerShell 5.1 (Windows 11 IoT Enterprise default).

.EXAMPLE
  .\Capture-TeveScreen.ps1 -ServerUrl "https://teve.example.com" `
      -ScadaSystemId "PLANTSCADA-242" -Token $env:TEVE_TOKEN -IntervalSeconds 300

.EXAMPLE
  # Register as a scheduled task at logon of the operator account:
  #   schtasks /Create /TN "TEVE Screen Capture" /SC ONLOGON /RU "OPERATOR" ^
  #     /TR "powershell -ExecutionPolicy Bypass -File C:\teve\Capture-TeveScreen.ps1 -ServerUrl https://teve.example.com -ScadaSystemId PLANTSCADA-242 -Token <token> -IntervalSeconds 300"
  # then set "Run only when user is logged on" in Task Scheduler properties.
#>
param(
    [Parameter(Mandatory = $true)] [string] $ServerUrl,
    [Parameter(Mandatory = $true)] [string] $ScadaSystemId,
    [Parameter(Mandatory = $true)] [string] $Token,
    [int] $IntervalSeconds = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# TLS 1.2 for older .NET defaults on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$uploadUri = "$($ServerUrl.TrimEnd('/'))/api/historian/screenshots/upload?scada_system_id=$([uri]::EscapeDataString($ScadaSystemId))"
$headers = @{ Authorization = "Bearer $Token" }

function Invoke-Capture {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $tmp = Join-Path $env:TEMP ("teve-capture-{0}.png" -f [guid]::NewGuid())
    try {
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $resp = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers `
            -ContentType 'image/png' -InFile $tmp
        Write-Host ("{0} uploaded screenshot_id={1}" -f (Get-Date -Format s), $resp.screenshot_id)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }
}

if ($IntervalSeconds -le 0) {
    Invoke-Capture
} else {
    Write-Host "Capturing every $IntervalSeconds s to $uploadUri (Ctrl+C to stop)"
    while ($true) {
        try {
            Invoke-Capture
        } catch {
            # keep the loop alive across transient VPN/server outages
            Write-Warning ("capture/upload failed: {0}" -f $_.Exception.Message)
        }
        Start-Sleep -Seconds $IntervalSeconds
    }
}
