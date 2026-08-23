# Finansla Terminal - Copyright (c) 2026 Efehan Tanirgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary
#
# YEDEKLEME BETIGI
# ----------------
# Her degisiklikten ONCE calistirilir; o anki hali _yedek/ altina zip'ler.
# Boylece bir sey bozulursa geri donulecek bir nokta hep bulunur.
#
# Kullanim:
#     .\yedekle.ps1                 -> her seyi yedekle
#     .\yedekle.ps1 -Not "kur sayfasi oncesi"
#
# Zip adi surum ve tarih icerir:  terminal_v32_2026-08-20_0915.zip
#
# NOT: Zip girdileri ELLE olusturuluyor cunku Windows PowerShell'in
# Compress-Archive'i klasor ayracini ters bolu (\) yaziyor; Linux tarafinda
# acilinca "css\terminal.css" adinda bozuk dosya olusuyor. ZIP standardi
# duz bolu (/) ister.

param(
    [string]$Not = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Yedeklenecek alanlar: klasor -> _yedek altindaki hedef ad
$hedefler = @(
    @{ Kaynak = "frontend"; Ad = "terminal" },
    @{ Kaynak = "site";     Ad = "ana-site" },
    @{ Kaynak = "backend";  Ad = "backend"  }
)

# Yedege girmeyecekler (gecici / uretilmis dosyalar)
$haric = @("__pycache__", ".vercel", "node_modules", ".git")

function Get-Surum($klasor) {
    # HTML'lerdeki ?v=N degerinden surumu oku; yoksa bos don.
    $html = Get-ChildItem $klasor -Filter *.html -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $html) { return "" }
    $icerik = [System.IO.File]::ReadAllText($html.FullName)
    $m = [regex]::Match($icerik, '\?v=(\d+)')
    if ($m.Success) { return "_v" + $m.Groups[1].Value }
    return ""
}

foreach ($h in $hedefler) {
    $kaynakYol = Join-Path $root $h.Kaynak
    if (-not (Test-Path $kaynakYol)) {
        Write-Host ("ATLANDI  {0} (klasor yok)" -f $h.Kaynak)
        continue
    }

    $hedefKlasor = Join-Path $root ("_yedek\" + $h.Ad)
    if (-not (Test-Path $hedefKlasor)) {
        New-Item -ItemType Directory -Path $hedefKlasor -Force | Out-Null
    }

    $surum = Get-Surum $kaynakYol
    $zipAd = "{0}{1}_{2}.zip" -f $h.Ad, $surum, $stamp
    $zipYol = Join-Path $hedefKlasor $zipAd

    $kaynak = (Get-Item $kaynakYol).FullName
    $dosyalar = Get-ChildItem $kaynak -Recurse -File -Force | Where-Object {
        $yol = $_.FullName
        -not ($haric | Where-Object { $yol -like "*\$_\*" })
    }

    $fs = [System.IO.File]::Open($zipYol, [System.IO.FileMode]::Create)
    $ar = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    foreach ($d in $dosyalar) {
        $rel = $d.FullName.Substring($kaynak.Length + 1).Replace('\', '/')
        $e = $ar.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $s = $e.Open()
        $b = [System.IO.File]::ReadAllBytes($d.FullName)
        $s.Write($b, 0, $b.Length)
        $s.Close()
    }
    $ar.Dispose(); $fs.Close()

    $kb = [math]::Round((Get-Item $zipYol).Length / 1KB, 1)
    Write-Host ("OK       {0,-22} {1,4} dosya  {2,7} KB" -f $zipAd, $dosyalar.Count, $kb)
}

if ($Not) {
    $notYol = Join-Path $root "_yedek\GECMIS.txt"
    Add-Content -Path $notYol -Value ("{0}  {1}" -f $stamp, $Not) -Encoding utf8
    Write-Host ("NOT      GECMIS.txt'e eklendi: {0}" -f $Not)
}

Write-Host ""
Write-Host "Yedekler: _yedek\terminal\  _yedek\ana-site\  _yedek\backend\"
