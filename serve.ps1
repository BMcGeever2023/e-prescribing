# ---------------------------------------------------------------------------
# Zero-install local static server for the portal (Windows PowerShell 5.1+).
# Serves prescribe-portal/ over http:// with the right MIME types for ES
# modules, so the app can talk to your real Supabase project locally.
#
#   Run:   powershell -ExecutionPolicy Bypass -File serve.ps1
#   Then:  open http://localhost:8000
#   Stop:  Ctrl+C
#
# (If you have real Python or Node instead, `python -m http.server 8000` or
#  `npx serve prescribe-portal` work too — this script just needs nothing.)
# ---------------------------------------------------------------------------
param(
  [int]$Port = 8000,
  [string]$Root = (Join-Path $PSScriptRoot 'prescribe-portal')
)

$mime = @{
  '.html'='text/html; charset=utf-8';       '.htm'='text/html; charset=utf-8'
  '.js'  ='text/javascript; charset=utf-8';  '.mjs'='text/javascript; charset=utf-8'
  '.css' ='text/css; charset=utf-8';         '.json'='application/json; charset=utf-8'
  '.png' ='image/png';  '.jpg'='image/jpeg';  '.jpeg'='image/jpeg';  '.gif'='image/gif'
  '.svg' ='image/svg+xml'; '.ico'='image/x-icon'; '.txt'='text/plain; charset=utf-8'
  '.woff'='font/woff';  '.woff2'='font/woff2'; '.map'='application/json'
}

$Root = [System.IO.Path]::GetFullPath($Root)
if (-not (Test-Path $Root)) { Write-Error "Root folder not found: $Root"; exit 1 }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() }
catch { Write-Error "Could not start on port $Port. Is it already in use? $($_.Exception.Message)"; exit 1 }
Write-Host "Serving $Root"
Write-Host "  -> http://localhost:$Port/   (Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
      if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
      $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))

      # Block path traversal outside the served root.
      if (-not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403; $res.Close(); continue
      }
      if (Test-Path $full -PathType Container) { $full = Join-Path $full 'index.html' }
      if (-not (Test-Path $full -PathType Leaf)) {
        $res.StatusCode = 404
        $nf = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
        $res.OutputStream.Write($nf, 0, $nf.Length); $res.Close(); continue
      }

      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $ct = $mime[$ext]; if (-not $ct) { $ct = 'application/octet-stream' }
      $res.ContentType = $ct
      $res.Headers['Cache-Control'] = 'no-store'
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try { $res.StatusCode = 500 } catch {}
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
