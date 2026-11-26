Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded background
$radius = 190
$d = $radius * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$bgRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bgRect, [System.Drawing.Color]::FromArgb(255, 22, 30, 52), [System.Drawing.Color]::FromArgb(255, 7, 10, 18), 55)
$g.FillPath($bgBrush, $path)

# Inner border
$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 79, 227, 255), 4)
$g.DrawPath($borderPen, $path)

# Glow diamonds
$cx = 512; $cy = 512
function New-Diamond([int]$half) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddPolygon(@(
    [System.Drawing.Point]::new($cx, ($cy - $half)),
    [System.Drawing.Point]::new(($cx + $half), $cy),
    [System.Drawing.Point]::new($cx, ($cy + $half)),
    [System.Drawing.Point]::new(($cx - $half), $cy)
  ))
  return $p
}

foreach ($spec in @(@(300, 34, 14), @(300, 22, 26), @(300, 12, 44))) {
  $half = $spec[0]; $width = $spec[1]; $alpha = $spec[2]
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($alpha, 79, 227, 255), $width)
  $g.DrawPath($pen, (New-Diamond -half $half))
}

# Gradient for the mark
$markRect = New-Object System.Drawing.Rectangle(150, 150, 724, 724)
$markBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($markRect, [System.Drawing.Color]::FromArgb(255, 79, 227, 255), [System.Drawing.Color]::FromArgb(255, 139, 123, 255), 45)

# Outer diamond stroke
$outerPen = New-Object System.Drawing.Pen($markBrush, 22)
$outerPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Miter
$g.DrawPath($outerPen, (New-Diamond -half 286))

# Translucent fill
$fillPath = New-Diamond -half 188
$fillBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(52, 139, 123, 255))
$g.FillPath($fillBrush, $fillPath)

# Solid core
$corePath = New-Diamond -half 112
$g.FillPath($markBrush, $corePath)

$out = Join-Path $PSScriptRoot 'paiz-icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $out
