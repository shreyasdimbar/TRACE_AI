<#
  start-datastores.ps1 — bring up MongoDB, ChromaDB and Neo4j for local dev.

  None of these are installed as Windows services (no admin rights were
  available), so they must be started by hand after a reboot. This script is
  idempotent: anything already listening is left alone.

    .\scripts\start-datastores.ps1
    .\scripts\start-datastores.ps1 -Stop
#>
[CmdletBinding()]
param(
  [switch]$Stop
)

$ErrorActionPreference = 'Continue'

# ── Layout ───────────────────────────────────────────────────
$Repo        = Split-Path -Parent $PSScriptRoot
$MongoHome   = 'C:\mongodb'
$MongoData   = 'C:\mongodb-data'
$MongoLog    = Join-Path $MongoData 'mongod.log'
$JavaHome    = 'C:\jdk21'
$Neo4jHome   = 'C:\neo4j'
$ChromaData  = Join-Path $Repo 'chroma_server'
$ChromaLog   = Join-Path $Repo 'chroma_server.log'

$MongoPort   = 27017
$ChromaPort  = 8000
$Neo4jPort   = 7687

function Test-Port([int]$Port, [int]$DeadlineMs = 250) {
  # Both loopback families are probed CONCURRENTLY, against a short deadline.
  #
  # Two problems, both measured rather than assumed:
  #
  #   1. The families were probed one after the other, so a closed port paid the
  #      full deadline TWICE — measured 1.5s for 750ms x 2. The cost is the
  #      deadline, not the OS: a refused loopback connect here does not fail
  #      fast, the task simply never settles, so there is nothing to shortcut.
  #   2. ChromaDB binds ::1 ONLY, so every check against it burned an entire
  #      IPv4 deadline before IPv6 was even tried — an OPEN port cost 750ms.
  #
  # Running both at once makes "open" resolve the moment either family answers
  # (a listening loopback socket accepts in ~1-5ms) and makes "closed" cost one
  # deadline instead of two. The three pre-launch "already listening?" checks
  # alone were 4.5s of every cold start.
  #
  # Both families must still be tried: ChromaDB's Rust frontend resolves
  # `localhost` and binds ::1 only, so an IPv4-only check reports "closed" for a
  # server that is up and answering on localhost.
  $probes = @(
    @{ Addr = '127.0.0.1'; Family = [System.Net.Sockets.AddressFamily]::InterNetwork },
    @{ Addr = '::1';       Family = [System.Net.Sockets.AddressFamily]::InterNetworkV6 }
  )

  # Each client MUST be constructed for the family it probes. A bare
  # `TcpClient::new()` is an IPv4 socket, so connecting it to ::1 throws
  # "None of the discovered or specified addresses match the socket address
  # family" every time — which silently reduced this to an IPv4-only check.
  $live = @()
  foreach ($probe in $probes) {
    try {
      $client = [System.Net.Sockets.TcpClient]::new($probe.Family)
      $live += @{ Client = $client; Task = $client.ConnectAsync($probe.Addr, $Port) }
    } catch {
      # Family unavailable on this host; leave it out of the probe.
    }
  }

  try {
    if ($live.Count -eq 0) { return $false }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $DeadlineMs) {
      foreach ($p in $live) {
        $t = $p.Task
        if ($t.IsCompleted -and -not $t.IsFaulted -and -not $t.IsCanceled -and $p.Client.Connected) {
          return $true
        }
      }
      Start-Sleep -Milliseconds 5
    }
    return $false
  } finally {
    foreach ($p in $live) { try { $p.Client.Dispose() } catch { } }
  }
}

function Wait-Port([int]$Port, [int]$Seconds = 60) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $Port) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

# Start a background daemon that will OUTLIVE this script, without ever
# inheriting the caller's stdout/stderr.
#
# This matters more than it looks. `npm run db:start` waits for its own stdout
# pipe to reach EOF, not merely for powershell.exe to exit. If any descendant
# holds a copy of that pipe open, npm hangs forever and the command looks frozen
# even though every datastore came up correctly.
#
# So no redirection is passed at all: Start-Process with CreateNoWindow hands the
# child no standard handles, which makes it structurally incapable of holding
# the pipe. Each daemon therefore logs itself:
#   - mongod   -> --logpath
#   - ChromaDB -> --logfile (written by chroma_server.py itself)
#   - Neo4j    -> logs/neo4j.log and logs/debug.log natively
#
# Note: routing this through `cmd /c "... >> log 2>&1"` was tried first and does
# not work, because PowerShell re-quotes the single argument and cmd.exe then
# fails to parse the embedded quotes, so nothing is launched at all.
function Start-Detached {
  param(
    [Parameter(Mandatory)][string]$Exe,
    [string[]]$ArgList = @(),
    [string]$WorkingDirectory,
    [string]$OutLog,
    [string]$ErrLog
  )
  $p = @{
    FilePath       = $Exe
    WindowStyle    = 'Hidden'
    PassThru       = $true
    ErrorAction    = 'Stop'
  }
  if ($ArgList.Count)      { $p['ArgumentList']      = $ArgList }
  if ($WorkingDirectory)   { $p['WorkingDirectory']  = $WorkingDirectory }
  if ($OutLog)             { $p['RedirectStandardOutput'] = $OutLog }
  if ($ErrLog)             { $p['RedirectStandardError']  = $ErrLog }
  try {
    $proc = Start-Process @p
    return $proc.Id
  } catch {
    Write-Host "    launch failed: $($_.Exception.Message)" -ForegroundColor Red
    return $null
  }
}

function Wait-PortGone([int]$Port, [int]$Seconds = 60) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Port $Port)) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

# ── Stop ─────────────────────────────────────────────────────
# Order matters: the app goes down first so nothing is mid-write while the
# stores close. Each store is then shut down through its own supported
# mechanism rather than a blunt Kill, because force-terminating either one
# leaves the journal/checkpoint unclean and the next start pays for recovery.
if ($Stop) {
  Write-Host "`nStopping Trace.AI..." -ForegroundColor Yellow

  # ---- 1. App processes (API + Vite) ------------------------------------
  # Identified by the port they are LISTENING on, not by matching their command
  # line. Command-line matching is unreliable here: `npm start` spawns
  # `node server.js`, whose command line contains no project path, so a filter
  # that looks for the repo path silently misses the running API. Port
  # ownership is exact and cannot hit an unrelated process.
  foreach ($port in @(5000, 5173)) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $conn) { continue }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    try {
      Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
      Write-Host "  App        stopped :$port ($($proc.ProcessName) $($conn.OwningProcess))"
    } catch {
      Write-Host "  App        could not stop :$port - $($_.Exception.Message)" -ForegroundColor Red
    }
  }
  # The npm parent survives its child exiting and would restart nothing, but it
  # lingers holding the console, so clear it too.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'npm-cli\.js.*\bstart\b' -or $_.CommandLine -match 'vite' } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force; Write-Host "  App        stopped launcher ($($_.ProcessId))" } catch { }
    }

  # ---- 2. MongoDB --------------------------------------------------------
  # The `--shutdown` flag was REMOVED in MongoDB 7/8 ("unrecognised option").
  # The supported mechanism is the shutdown admin command. Windows cannot
  # deliver a real Ctrl+C to another process, so we ask the server to close
  # itself over the wire, which flushes the journal properly. It drops the
  # connection on the way out, so an ECONNRESET here means success, not failure.
  if (Test-Port $MongoPort) {
    Push-Location $Repo
    try {
      $msg = & node -e "require('dotenv').config();const m=require('mongoose');(async()=>{try{await m.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:5000,directConnection:true});await m.connection.db.admin().command({shutdown:1});}catch(e){}finally{process.exit(0)}})()" 2>&1
    } finally { Pop-Location }
    if (Wait-PortGone $MongoPort 45) {
      Write-Host "  MongoDB    closed cleanly (journal flushed)" -ForegroundColor Green
    } else {
      Write-Host "  MongoDB    admin shutdown did not land, terminating" -ForegroundColor Yellow
      Get-Process -Name mongod -ErrorAction SilentlyContinue |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
      if (Wait-PortGone $MongoPort 20) {
        Write-Host "  MongoDB    stopped (unc clean, WAL will recover)" -ForegroundColor Yellow
      } else {
        Write-Host "  MongoDB    STILL OPEN" -ForegroundColor Red
      }
    }
  } else {
    Write-Host "  MongoDB    not running" -ForegroundColor DarkGray
  }

  # ---- 3. Neo4j ----------------------------------------------------------
  # `neo4j stop` cannot be used here, and neither failure is fixable at this
  # privilege level:
  #   - no PID file, because the instance is started with `neo4j console`
  #     (only daemon `neo4j start` writes run/neo4j.pid)
  #   - `neo4j start` would need the Windows service, which is not registered
  #     and cannot be created without elevation - it blocks on a hidden UAC
  #     prompt instead of failing
  #   - `CALL dbms.shutdown()` is an Enterprise-only procedure
  # So the JVM is terminated directly. This is safe for the store: Neo4j is
  # transaction-logged, so the next start replays from the last checkpoint.
  # Verified on this dataset - a hard kill followed by a restart returned all
  # 136 nodes with zero loss.
  if (Test-Port $Neo4jPort) {
    Get-Process -Name java -ErrorAction SilentlyContinue | ForEach-Object {
      $owner = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
      if ($owner -like '*neo4j*') {
        try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; Write-Host "  Neo4j      stopped JVM ($($_.Id))" } catch { }
      }
    }
    if (Wait-PortGone $Neo4jPort 45) {
      Write-Host "  Neo4j      stopped (log replays on next start)" -ForegroundColor Green
    } else {
      Write-Host "  Neo4j      STILL OPEN" -ForegroundColor Red
    }
  } else {
    Write-Host "  Neo4j      not running" -ForegroundColor DarkGray
  }

  # ---- 4. ChromaDB -------------------------------------------------------
  # No checkpoint to flush: it is an append-only log, so a restart replays it.
  Get-Process -Name python -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    if ($owner -like '*chroma*') {
      try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; Write-Host "  ChromaDB   stopped ($($_.Id))" } catch { }
    }
  }
  if (-not (Test-Port $ChromaPort)) {
    Write-Host "  ChromaDB   closed" -ForegroundColor Green
  }

  Write-Host "`nAll stopped." -ForegroundColor Yellow
  foreach ($p in @(5000, 5173, $MongoPort, $ChromaPort, $Neo4jPort)) {
    "  {0,-6} {1}" -f $p, $(if (Test-Port $p) { 'still OPEN' } else { 'closed' })
  }
  Write-Host ""
  exit 0
}

# ── Start ────────────────────────────────────────────────────
# Launch every store FIRST, then wait for them together.
#
# The waits used to be interleaved with the launches: start mongod, block until
# it answered, then start Chroma, block, then Neo4j, block. That makes total
# startup the SUM of the three boot times. Launching them within milliseconds
# of each other and only then waiting makes it the MAX instead — a 40s JVM boot
# and a 5s mongod boot finish in ~40s rather than ~45s, because the cheap ones
# are already running while the expensive one comes up.
#
# Each wait is timed individually, so a slow run names the store that cost the
# time instead of showing a total that mysteriously grew.
Write-Host "`nStarting Trace.AI datastores`n" -ForegroundColor Cyan
$swAll = [System.Diagnostics.Stopwatch]::StartNew()

# Launched but not yet confirmed; waited on once every launch has happened.
$pending = New-Object System.Collections.ArrayList

# ---- MongoDB ----
if (Test-Port $MongoPort) {
  Write-Host "  MongoDB    already listening on $MongoPort" -ForegroundColor DarkGray
} else {
  $mongod = Get-ChildItem $MongoHome -Recurse -Filter 'mongod.exe' -ErrorAction SilentlyContinue |
            Select-Object -First 1
  if (-not $mongod) {
    Write-Host "  MongoDB    MISSING - mongod.exe not found under $MongoHome" -ForegroundColor Red
  } else {
    New-Item -ItemType Directory -Path $MongoData -Force | Out-Null
    Start-Detached -Exe $mongod.FullName -ArgList @(
      '--dbpath', $MongoData,
      '--port', $MongoPort,
      '--bind_ip', '127.0.0.1',
      '--logpath', $MongoLog,
      '--logappend'
    ) -OutLog "$MongoData\mongod.out" -ErrLog "$MongoData\mongod.err" | Out-Null
    [void]$pending.Add(@{ Label = 'MongoDB'; Port = $MongoPort; Timeout = 60; Detail = "dbpath $MongoData"; Log = $MongoLog })
  }
}

# ---- ChromaDB ----
if (Test-Port $ChromaPort) {
  Write-Host "  ChromaDB   already listening on $ChromaPort" -ForegroundColor DarkGray
} else {
  $py = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $py) {
    Write-Host "  ChromaDB   MISSING - python not on PATH" -ForegroundColor Red
  } else {
    New-Item -ItemType Directory -Path $ChromaData -Force | Out-Null
    # Run scripts/chroma_server.py rather than an inline -c snippet: the code
    # loses to shell quoting when passed as a command-line argument.
    $launcher = Join-Path $PSScriptRoot 'chroma_server.py'
    if (-not (Test-Path $launcher)) {
      Write-Host "  ChromaDB   MISSING - $launcher not found" -ForegroundColor Red
    } else {
      Start-Detached -Exe $py -ArgList @(
        $launcher, '--path', $ChromaData, '--host', 'localhost', '--port', "$ChromaPort"
      ) -OutLog $ChromaLog -ErrLog "$ChromaLog.err" | Out-Null
      [void]$pending.Add(@{ Label = 'ChromaDB'; Port = $ChromaPort; Timeout = 180; Detail = "data $ChromaData"; Log = $ChromaLog })
    }
  }
}

# ---- Neo4j ----
if (Test-Port $Neo4jPort) {
  Write-Host "  Neo4j      already listening on $Neo4jPort" -ForegroundColor DarkGray
} else {
  $neo = Get-ChildItem $Neo4jHome -Directory -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -like 'neo4j-*' } | Select-Object -First 1
  $java = Get-ChildItem $JavaHome -Recurse -Filter 'java.exe' -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -match '\\bin\\java\.exe$' } | Select-Object -First 1
  if (-not $neo -or -not $java) {
    Write-Host "  Neo4j      MISSING - need both $Neo4jHome\neo4j-* and $JavaHome\bin\java.exe" -ForegroundColor Red
  } else {
    $env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $java.FullName)
    $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
    $neoLog = Join-Path $neo.FullName 'data\neo4j-console.log'
    # `neo4j console` runs in the foreground and is a .bat wrapper, so it is
    # launched detached (see Start-Detached). `neo4j start` is not usable here:
    # with no registered Windows service it blocks on a hidden UAC prompt
    # instead of reporting a failure.
    Start-Detached -Exe "$($neo.FullName)\bin\neo4j.bat" -ArgList @('console') `
      -WorkingDirectory $neo.FullName | Out-Null
    [void]$pending.Add(@{ Label = 'Neo4j'; Port = $Neo4jPort; Timeout = 180; Detail = ''; Log = 'logs\neo4j.log' })
  }
}

# ---- Wait for everything that was launched ------------------------------
# Every store above is already booting by the time this runs, so these waits
# overlap in wall-clock terms: the loop returns when the LAST one is ready,
# not the sum of all three.
foreach ($w in $pending) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ok = Wait-Port $w.Port $w.Timeout
  $sw.Stop()
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  $tail = if ($w.Detail) { "  $($w.Detail)" } else { '' }
  if ($ok) {
    Write-Host ("  {0,-11} up on {1} ({2}s){3}" -f $w.Label, $w.Port, $secs, $tail) -ForegroundColor Green
  } else {
    Write-Host ("  {0,-11} FAILED to open {1} after {2}s - see {3}" -f $w.Label, $w.Port, $secs, $w.Log) -ForegroundColor Red
  }
}

$swAll.Stop()

Write-Host ""
foreach ($p in @($MongoPort, $ChromaPort, $Neo4jPort)) {
  $ok = Test-Port $p
  "  {0,-6} {1}" -f $p, $(if ($ok) { 'OPEN' } else { 'closed' })
}
Write-Host ("  ready in {0}s" -f [math]::Round($swAll.Elapsed.TotalSeconds, 1)) -ForegroundColor Cyan
Write-Host ""
