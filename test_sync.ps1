# Verifies two things:
#   1. "Sync now" cannot duplicate — six concurrent syncs leave the document
#      count exactly where it was, because every message is already ingested.
#   2. Google Docs sync no longer dies on "doc.save is not a function", and
#      unchanged docs are skipped rather than re-extracted through Gemini.
#
# Concurrency comes from System.Net.Http, not Start-Job: a job is a whole new
# PowerShell process, so its ~1s startup would serialise the requests and the
# race being tested would never happen.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test_sync.ps1
#   npm run test:sync   (requires a running API on :5000)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$base = 'http://localhost:5000'
$script:failures = 0
$script:checks = 0

function Check($cond, $label) {
    $script:checks++
    if ($cond) { Write-Host "  PASS  $label" }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red; $script:failures++ }
}

$login = @{ email = 'auth.suite@walchandsangli.ac.in'; password = 'Suite@12345' } | ConvertTo-Json
$tok = (Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -Body $login -ContentType 'application/json').token

$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(180)
$client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $tok)

# Held in a list so nothing is disposed while its request is still in flight.
$payloads = New-Object System.Collections.ArrayList

function Post-Json([string]$url, [string]$body) {
    $c = [System.Net.Http.StringContent]::new($body, [System.Text.Encoding]::UTF8, 'application/json')
    [void]$script:payloads.Add($c)
    return $client.PostAsync($url, $c)
}

function Read-Json($task) {
    $json = $task.Result.Content.ReadAsStringAsync().Result
    try { return $json | ConvertFrom-Json } catch { return @{ raw = $json } }
}

function Doc-Count {
    $r = Invoke-WebRequest -Uri "$base/api/documents?limit=200" -Headers @{ Authorization = "Bearer $tok" } -UseBasicParsing
    return (@($r.Content | ConvertFrom-Json).documents).Count
}

Write-Host ""
Write-Host "1. baseline"
$before = Doc-Count
Write-Host "     documents = $before"

# ── 2. six concurrent syncs ────────────────────────────────────────────
Write-Host ""
Write-Host "2. six concurrent syncs (3 gmail + 3 gdocs)"

$gmailTasks = @(1..3 | ForEach-Object { Post-Json "$base/api/gmail/fetch" '{}' })
$gdocsTasks = @(1..3 | ForEach-Object { Post-Json "$base/api/gdocs/fetch" '{}' })

$all = @($gmailTasks) + @($gdocsTasks)
[System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$all)

$gmailResults = @($gmailTasks | ForEach-Object { Read-Json $_ })
$gdocsResults = @($gdocsTasks | ForEach-Object { Read-Json $_ })

$after = Doc-Count
Write-Host "     documents = $after"

Check ($after -eq $before) "no new documents (before=$before after=$after)"

$gmailFailed = @($gmailResults | Where-Object { $_.error })
Check ($gmailFailed.Count -eq 0) "gmail: 3/3 completed without error"

$gdocsFailed = @($gdocsResults | Where-Object { $_.error })
Check ($gdocsFailed.Count -eq 0) "gdocs: 3/3 completed without error"
if ($gdocsFailed.Count -gt 0) { $gdocsFailed | ForEach-Object { Write-Host "         -> $($_.error)" -ForegroundColor Red } }

$gdriveErr = @($gdocsResults | Where-Object { $_.code -eq 'GDRIVE_ERROR' })
Check ($gdriveErr.Count -eq 0) "gdocs: no GDRIVE_ERROR payload (the doc.save bug)"

$notConfigured = @($gdocsResults | Where-Object { $_.code -eq 'NOT_CONNECTED' -or $_.code -eq 'NO_FOLDER' })
if ($notConfigured.Count -gt 0) {
    Write-Host "  SKIP  gdocs not configured ($($notConfigured[0].code))" -ForegroundColor Yellow
} else {
    $unchanged = 0
    foreach ($r in $gdocsResults) { if ($r.skipped) { $unchanged += @($r.skipped | Where-Object { $_.reason -eq 'unchanged' }).Count } }
    Check ($unchanged -gt 0) "gdocs: unchanged docs skipped, not re-extracted ($unchanged skip records)"
}

# ── 3. integrity ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "3. integrity"

$docs = Invoke-RestMethod -Uri "$base/api/documents?limit=200" -Headers @{ Authorization = "Bearer $tok" }
$list = @($docs.documents)
$ids = @($list | ForEach-Object { $_._id })
Check (($ids | Select-Object -Unique).Count -eq $list.Count) "no duplicate _id across $($list.Count) docs"

$noKey = @($list | Where-Object { -not $_.metadata.messageId -and -not $_.metadata.googleDocId })
Check ($noKey.Count -eq 0) "every document carries a provider id ($($noKey.Count) missing)"

Write-Host ""
Write-Host "============================================================"
if ($script:failures -eq 0) { Write-Host "  OK  $($script:checks) passed, 0 failed" }
else                        { Write-Host "  FAILED  $($script:failures) of $($script:checks)" -ForegroundColor Red }
exit ([int]($script:failures -gt 0))
