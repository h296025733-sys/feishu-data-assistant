param(
    [Parameter(Mandatory=$true)][string]$AuditPath,
    [int]$Concurrency = 3,
    [int]$Limit = 0,
    [string]$RetryFrom = '',
    [switch]$RetryTransientOnly,
    [ValidateSet('storeone-formal','storetwo-formal','storethree-formal','storetwo-llc-formal','storetwo-botanical-care-formal')]
    [string[]]$Tenants = @(),
    [string]$ProxyUrl = $env:TIKTOK_VIDEO_PROXY
)

$ErrorActionPreference = 'Stop'
if ($ProxyUrl -and $ProxyUrl -notmatch '^https?://') { throw 'ProxyUrl must use HTTP or HTTPS' }
$audit = Get-Content -LiteralPath $AuditPath -Raw | ConvertFrom-Json
$outDir = Join-Path (Resolve-Path '.runtime/cooperation-avatar').Path 'images'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function Get-CellText($value) {
    if ($null -eq $value) { return '' }
    if ($value -is [string]) { return $value }
    if ($value -is [array]) { return (($value | ForEach-Object { Get-CellText $_ }) -join '') }
    if ($null -ne $value.text) { return [string]$value.text }
    if ($null -ne $value.link) { return [string]$value.link }
    return ''
}

$candidates = foreach ($store in $audit.result) {
    if ($Tenants.Count -gt 0 -and $store.tenant -notin $Tenants) { continue }
    foreach ($row in $store.rows) {
        if (-not $row.fields.'红人姓名' -or $row.fields.'红人头像') { continue }
        $profileUrl = (Get-CellText $row.fields.'主页').Trim() -replace '[\u200B-\u200D\u2060-\u206F\uFEFF]', ''
        $m = [regex]::Match($profileUrl, '^https?://(?:www\.)?tiktok\.com/@\s*([A-Za-z0-9._]+)(?:/?(?:\?[^#\s]*)?(?:#[^\s]*)?)$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $m.Success) { continue }
        [pscustomobject]@{ Handle = $m.Groups[1].Value.ToLowerInvariant() }
    }
}
$handles = @($candidates | Sort-Object Handle -Unique)
if ($RetryFrom) {
    $previous = @(Get-Content -LiteralPath $RetryFrom -Raw | ConvertFrom-Json)
    $retry = @{}
    foreach ($item in $previous) {
        if ($item.status -ne 'UNAVAILABLE') { continue }
        if ($RetryTransientOnly -and $item.error -notmatch 'SSL connection|HttpClient.Timeout|timed out|connection') { continue }
        $retry[[string]$item.handle] = $true
    }
    $handles = @($handles | Where-Object { $retry.ContainsKey([string]$_.Handle) })
}
if ($Limit -gt 0) { $handles = @($handles | Select-Object -First $Limit) }
Write-Output "targets=$($handles.Count) concurrency=$Concurrency"

$results = $handles | ForEach-Object -Parallel {
    $h = $_.Handle
    $folder = $using:outDir
    $requestOptions = @{}
    if ($using:ProxyUrl) { $requestOptions.Proxy = $using:ProxyUrl }
    $stem = Join-Path $folder $h
    $existing = @('.jpg', '.png', '.webp') | ForEach-Object { "$stem$_" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($existing) {
        [pscustomobject]@{ handle=$h; status='CACHED'; file=$existing; error=$null }
        return
    }
    $lastError = ''
    for ($attempt=1; $attempt -le 3; $attempt++) {
        try {
            $profile = Invoke-WebRequest @requestOptions -Uri "https://www.tiktok.com/@$h" -TimeoutSec 22 -Headers @{
                'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
                'Accept-Language'='en-US,en;q=0.9'
            }
            $match = [regex]::Match($profile.Content, '(?s)<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>')
            if (-not $match.Success) { throw 'hydration-missing' }
            $json = $match.Groups[1].Value | ConvertFrom-Json -AsHashtable
            $detail = $json['__DEFAULT_SCOPE__']['webapp.user-detail']
            $user = if ($null -ne $detail -and $null -ne $detail['userInfo']) { $detail['userInfo']['user'] } else { $null }
            if (-not $user -or -not $user['avatarLarger']) { throw "avatar-missing:status=$($detail['statusCode'])" }
            if (-not [string]::Equals([string]$user['uniqueId'], $h, [StringComparison]::OrdinalIgnoreCase)) {
                throw "handle-mismatch:$($user['uniqueId'])"
            }
            $tmp = "$stem.download"
            Invoke-WebRequest @requestOptions -Uri ([string]$user['avatarLarger']) -OutFile $tmp -TimeoutSec 25 -Headers @{
                'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
            }
            $bytes = [IO.File]::ReadAllBytes($tmp)
            if ($bytes.Length -lt 1500 -or $bytes.Length -gt 5000000) { throw "bad-image-size:$($bytes.Length)" }
            $ext = if ($bytes[0] -eq 0xff -and $bytes[1] -eq 0xd8) { '.jpg' }
                elseif ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { '.png' }
                elseif ([Text.Encoding]::ASCII.GetString($bytes,0,4) -eq 'RIFF' -and [Text.Encoding]::ASCII.GetString($bytes,8,4) -eq 'WEBP') { '.webp' }
                else { throw 'unknown-image-format' }
            $final = "$stem$ext"
            Move-Item -LiteralPath $tmp -Destination $final -Force
            [pscustomobject]@{ handle=$h; status='RESOLVED'; file=$final; bytes=$bytes.Length; error=$null }
            return
        } catch {
            $lastError = $_.Exception.Message
            if (Test-Path -LiteralPath "$stem.download") { Remove-Item -LiteralPath "$stem.download" -Force }
            # A native unavailable profile or mismatched identity is not transient.
            # Do not repeat the same request or guess an avatar.
            if ($lastError -match '^avatar-missing:status=209002|^handle-mismatch:') { break }
            if ($attempt -lt 3) { Start-Sleep -Milliseconds (400 * $attempt) }
        }
    }
    [pscustomobject]@{ handle=$h; status='UNAVAILABLE'; file=$null; error=$lastError }
} -ThrottleLimit ([Math]::Max(1,[Math]::Min(5,$Concurrency)))

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
$receipt = Join-Path (Resolve-Path '.runtime/cooperation-avatar').Path "resolved-$stamp.json"
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receipt -Encoding utf8
$grouped = $results | Group-Object status | ForEach-Object { "$($_.Name)=$($_.Count)" }
Write-Output "result=$receipt $($grouped -join ' ')"
