$port = 3000
$root = $PSScriptRoot
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Servidor corriendo en http://localhost:$port  (Ctrl+C para detener)"

$mimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.png'  = 'image/png'
    '.avif' = 'image/avif'
    '.webp' = 'image/webp'
    '.mp4'  = 'video/mp4'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.toml' = 'text/plain'
}

while ($listener.IsListening) {
    $ctx  = $listener.GetContext()
    $req  = $ctx.Request
    $resp = $ctx.Response
    $url  = $req.Url.LocalPath
    if ($url -eq '/') { $url = '/index.html' }
    $file = Join-Path $root $url.TrimStart('/')
    if (Test-Path $file -PathType Leaf) {
        $ext  = [System.IO.Path]::GetExtension($file).ToLower()
        $mime = if ($mimeTypes[$ext]) { $mimeTypes[$ext] } else { 'application/octet-stream' }
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $resp.ContentType   = $mime
        $resp.ContentLength64 = $bytes.Length
        $resp.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $resp.StatusCode = 404
        $msg = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
        $resp.OutputStream.Write($msg, 0, $msg.Length)
    }
    $resp.OutputStream.Close()
}
