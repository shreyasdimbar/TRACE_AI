# Trace.AI — Project Context (handoff)

> **Purpose:** everything needed to continue work in a fresh conversation without
> re-deriving it.
> **Last verified:** 2026-10-15, against a running stack (figures read from the
> server, not recalled).
> **Rule of thumb:** facts marked ✅ were measured this session; facts marked
> ⚠️ are inherited from earlier context and should be re-confirmed if they matter.

---

## 0 · Status snapshot

| | |
|---|---|
| **What** | Organizational intelligence engine — ingests Gmail / Slack / Google Docs / transcripts, indexes them, answers grounded questions with citations |
| **Audience** | Restricted to `walchandsangli.ac.in` |
| **Data visibility** | **Shared across users by decision** — an org-wide knowledge layer, not a per-user store. Chat history is the exception (per-account). |
| **Stack** | Express + Mongoose · ChromaDB · Neo4j · Gemini · React 19 + Vite 8 |
| **Router** | Hand-rolled History API — **no `react-router-dom`** (deliberately removed) |
| **Blocking issues** | **None** ✅ — Google OAuth is connected and verified |

### Tests — all green ✅

| Suite | Count | Command |
|---|---|---|
| smoke | **16** | `npm run test:smoke` |
| datastore | **18** | `npm run test:datastore` |
| auth | **38 pass / 0 fail / 2 skip** | `npm run test:auth` *(needs API)* |
| routes | **25** | `cd client; npm run test:routes` |
| chat store | **18** | `cd client; npm run test:chatstore` |
| CSS coverage | **228 used / 0 missing** | `cd client; node check_classes.mjs` |

> The 2 auth SKIPs are the register rate-limit 429s, reported by an explicit
> `Skipped` sentinel — **never counted as a pass**. With raised limits
> (`REGISTER_RATE_MAX=500`) it is 40/40.

---

## 1 · Starting up

None of the datastores are Windows services — **everything is down after a
reboot**, and nothing survives a shutdown.

```powershell
npm run db:start        # MongoDB + Chroma + Neo4j  (~197s)
npm start               # API        -> :5000
cd client; npm run dev  # UI         -> :5173
```

**Which things actually need restarting after a change:**

| Changed | Restart |
|---|---|
| `routes/**`, `services/**`, `server.js`, `.env` | `node server.js` only |
| `client/src/**` | usually nothing — Vite HMR. **But** see the caveat below |
| datastore config | `npm run db:stop` → `npm run db:start` |

> ⚠️ **Vite HMR silently skips some modules.** The old dev-server log showed hot
> updates for `AskPage.jsx` and `App.jsx` but **never for `session.js` or
> `chatStore.js`**. `session.js` runs a module-load side effect
> (`setUnauthorizedHandler(...)`), so a hot patch leaves a stale module graph.
> **After touching `session.js` or adding a new module, restart Vite.**
> Verify what is actually served: `GET http://[::1]:5173/src/<file>`.

### Ports — note the IPv6 split ✅

| Port | Service | Bind |
|---|---|---|
| 5000 | API | dual |
| **5173** | Vite | **`::1` only** |
| **8000** | ChromaDB | **`::1` only** |
| 7687 | Neo4j bolt | 127.0.0.1 |
| 7474 | Neo4j Browser (visual graph) | 127.0.0.1 |
| 27017 | MongoDB | 127.0.0.1 |

Use `localhost`, **not** `127.0.0.1`. A probe against IPv4 alone reports
"closed" for two perfectly healthy services.

**Use the project's own `Test-Port`** (in `scripts/start-datastores.ps1`) — it
tries both families and is the only reliable liveness check here.

---

## 2 · File map

```
server.js                 Express app, health probes, route mounting
reset.js                  DESTRUCTIVE — wipes Mongo docs + Chroma + Neo4j. Needs --yes
backfill_graph.js         Rebuild Neo4j from Mongo. MERGE-based, idempotent, no AI calls
show_datastores.js        Print Mongo/Chroma/Neo4j state     (npm run show:db)
show_vectors.js           Inspect vector collection          (npm run show:vectors)
test_smoke.js             16
test_auth.js              38 (+2 rate-limit skips)
test_datastore.js         18
test_drive.js             Drive helper
_bench.js                 PRE-EXISTING latency probe — not a leftover

middleware/auth.js        requireAuth · requireRole · requireSecret
models/User.js            tokenVersion, lastLogoutAt, bcrypt pre-save hook
models/Document.js        Ingested document schema

routes/auth.js            login · register · logout · re-exports guards
routes/ask.js             Grounded Q&A  ← recent changes, see §7
routes/documents.js       List/read/delete documents
routes/ingest.js          Manual ingestion
routes/gmail.js           Gmail sync + OAuth entry points (mounted at `/`)
routes/gdocs.js           Google Docs sync (mounted at `/api/gdocs`)
routes/slack.js           Slack channels/fetch

services/aiService.js     MODEL_CHAIN, generateWithFallback, prompts, citations
services/chromaService.js Vector store
services/neo4jService.js  Graph
services/googleAuth.js    OAuth flow, refresh-token handling
services/ingestService.js Ingestion pipeline
services/scheduler.js     node-cron — single-flight + backoff for all sources
services/rateLimit.js     40/IP per 15min · register 5/IP · login 8/account

scripts/start-datastores.ps1   Datastore lifecycle: Start-Detached, -Stop, Test-Port
scripts/chroma_server.py       Chroma launch, redirects stdout to --logfile

client/src/
  routes.js        Route table + auth policy (pure JS, DOM-free → testable)
  router.jsx       React binding, popstate, redirect effect
  session.js       3-state session store + sign-out choke point
  chatStore.js     Conversation history (sessionStorage, per-account)
  api.js           Fetch wrapper; token in localStorage key `trace_token`
  App.jsx          Real URLs + auth gate + theme switching
  index.css        Entire design system (~2900 lines, "Deep Signal")
  pages/           Landing · Login · Dashboard · Ask · Feed · Ingest · Settings

client/check_classes.mjs      Class-coverage invariant (228 used / 0 missing)
client/test_routes.js         25
client/test_chatstore.mjs     18
```

**Dead Vite scaffold (never loaded — `index.html` points at `/src/main.jsx`):**
`src/main.ts`, `src/style.css`, `src/App.css`, `src/counter.ts`,
`src/assets/hero.png`, `src/assets/typescript.svg`, `src/assets/vite.svg`.

---

## 3 · Verified live state ✅

```
API       : up, /health -> ok
MongoDB   : connected, 36 documents
Chroma    : reachable, orgmind_gemini_docs_v2, embed dim 3072
Neo4j     : configured, 143 nodes (136 → 143 after 2 Gmail docs)
Google    : connected=true, hasRefreshToken=true, gmail_tokens.json 659 B
Slack     : configured
Scheduler : enabled, interval "* * * * *", sources gmail/slack/google_docs
Gemini    : gemini-3.6-flash  ->  gemini-3.5-flash-lite
```

**Google OAuth is healthy and persists across restarts** — the flow already
requests `access_type: 'offline'`, so no re-consent is needed. The token file is
`gmail_tokens.json`; if it ever vanishes, one browser visit to
`http://localhost:5000/auth/google` restores it.

---

## 4 · Design system — "Deep Signal"

Rewritten from the old charcoal/aqua glass theme to: **futuristic enterprise with
subtle cyberpunk influence** — deep teal · dark navy · luminous cyan · off-white
· pale blue-gray; bold condensed headings; floating glass cards; thin borders;
pill labels; holographic grid; cyan edge-glow.

| Token | Value |
|---|---|
| Display font | `Chakra Petch` (bold, condensed) |
| Body font | `Inter` |
| Mono | `JetBrains Mono` |
| Loaded via | `@import` in `index.css` (no Google Fonts `<link>`) |
| Themes | `[data-theme='dark']` (default) / `[data-theme='light']` (cool off-white) |

### The performance story (important context)

The original complaint was **frontend lag**. Root cause: `backdrop-filter:
blur(22px)` on **19 separate surfaces**, each over four animated
radial-gradient blobs — the compositor re-sampled the backdrop every frame and
never settled.

The rewrite cut that to **7 occurrences**, all container-level
(`.atmosphere`, `.sidebar`, `.landing-bg`, `.auth-card`, `.modal-overlay`,
`.custom-select-dropdown`, `.landing-security-card`). Critically the
**repeated** selectors — `.card`, `.stat-card`, `.doc-card`, `.ingest-card` —
are now **blur-free**, which is where 34-document lists were costing frames.

Rules that must hold:
1. Backgrounds animate **`transform`/`opacity` only** — never `background-position`
   or `filter`.
2. No per-card `backdrop-filter`.
3. `prefers-reduced-motion` **removes** the depth field entirely, not just fast.

### Invariant

Every `className` token in JSX must resolve in `index.css`:

```powershell
cd client; node check_classes.mjs     # must exit 0
```

---

## 5 · Frontend routing & security

`client/src/routes.js` holds the policy as pure, DOM-free functions.

- `PROTECTED_ROUTES = /dashboard /ask /documents /ingest /settings`
- `PUBLIC_ROUTES = / /login`
- `normalisePath()` folds case, duplicate/trailing slashes, percent-encoding
  (`%73` → `s`), query **and** fragment **before** policy is evaluated — so
  `/settings/`, `/SETTINGS`, `//settings//`, `/%73ettings` are all recognised.
- Unknown paths fail safe to the public landing, never to a protected page.

**Attack-tested: 27 URL variants → 0 leaks.**

> The client guard is **UX only**. The real boundary is the API.

### Server auth

- `requireAuth` / `requireRole` live in `middleware/auth.js`;
  `routes/auth.js` re-exports so call sites are unchanged.
- `requireAuth` **re-reads the user document every request** → role changes and
  revocation take effect immediately.
- **Logout revocation** via `tokenVersion`: `POST /api/auth/logout` bumps the
  claim; a copied token dies instantly (401 everywhere).
- Chose this over `httpOnly` cookies because that would also need CSRF
  protection + CORS credentials — deliberately not half-done.
- Passwords: bcrypt `$2b$12`. **13 accounts, zero plaintext.** ⚠️ *(count
  re-confirm if it matters; verified earlier)*

---

## 6 · Session & conversation history

`client/src/session.js` — three distinct states:

| State | Meaning |
|---|---|
| `loading` | token exists, not yet verified → **boot screen, no redirect** (prevents a login flash on refresh) |
| `authenticated` | `/api/auth/me` accepted the token |
| `anonymous` | no token, or server rejected it |

`App.jsx` checks `status === 'loading'` **before** `renderPage()`, so protected
pages can only mount once authenticated. That ordering matters for chat storage
(see below).

### `chatStore.js` — history persists until logout ✅

**Problem:** messages lived in `useState([])` inside `AskPage`, so every route
change unmounted it and the conversation vanished.

**Fix:**

| File | Change |
|---|---|
| `client/src/chatStore.js` | **new** — `loadMessages` / `saveMessages` / `clearMessages` |
| `AskPage.jsx` | `useState(() => loadMessages(id))` + `useEffect` mirroring changes |
| `session.js` | `clearStoredSession()` now calls `clearMessages(state.user?.id)` |

Design decisions (do not undo casually):

- **`sessionStorage`, not `localStorage`** — survives a reload (refresh doesn't
  destroy the chat) but is tab-scoped and cleared when the tab closes.
- **Keyed by account id** (`trace_chat:v1:<id>`). Without it, A signing out and
  B signing in on the same tab hands B A's transcript. Documents are shared by
  design; a conversation is not.
- **Hooked into `clearStoredSession()`, not `signOut()`** — that is the single
  choke point for **all three** session-ending paths: explicit logout, a token
  revoked elsewhere (`handleUnauthorized`), and a failed bootstrap. The id is
  read *before* the caller resets state.
- **Capped at 120 messages** — sessionStorage is ~5 MB shared with the origin;
  unbounded append would throw `QuotaExceededError` mid-send.
- Every storage call is wrapped — a disabled/full storage degrades to "history
  lasts until the next render", never a crash.

---

## 7 · The Ask pipeline (recently reworked) ✅

### Request flow

```
POST /api/ask
 ├─ isSmalltalk()?      → instant canned reply, NO retrieval, NO Gemini call
 ├─ total docs == 0     → "nothing indexed yet", sources []
 ├─ retrieve(question)  → vector (TOP_K 6) → keyword → graph expansion (+3, +2)
 ├─ docs empty          → explicit "no evidence", sources []
 └─ answerQuestion()    → buildContext (24k char budget) → Gemini → filtered sources
```

Config (`routes/ask.js`):
```
ASK_TOP_K=6          ASK_GRAPH_EXPANSION=3       ASK_CONTEXT_CHARS=24000
```

### Change 1 — sources are now citation-filtered

**Was:** `answerQuestion` returned *every* retrieved doc as a source, so a
two-sentence answer shipped with 9 citations.

```js
// before
return { answer: raw, sources: toCitationPayload(blocks.map(b => b.doc)) };
// after — only blocks the model actually referenced
```

- `citedBlockRefs(answer)` parses citations.
- `toCitationPayload(sources, refs)` gained an optional `refs` argument so the
  **original block numbers** survive filtering.
- `routes/ask.js`: on abstention (`/could not find|not (present|in) the .../`)
  → `sources: []`.

**Two bugs I hit and fixed in this change — both would look like "sources are
broken":**

1. The model writes **`[1, 4]`**, not `[1]` `[4]`. A `\[(\d+)\]` regex matched
   nothing and stripped **all** sources.
2. `toCitationPayload` renumbered with `i + 1` *after* filtering, so the answer
   cited `[4] [5]` while the list read `[1] [2]`. Refs now pass through.

**Refs legitimately skip** — `[1] [4] [5]` is correct, not a gap.

Verified: `cited list === source list` on every case (see `test_sources.ps1`).

### Change 2 — `retrieved` semantics

`retrieved` means **documents pulled into context** (`docs.length`), *not*
documents cited. Reporting the filtered count would hide how much was searched.

### Change 3 — smalltalk short-circuit

**Was:** `"hi"` went through retrieval. Vector search always returns nearest
neighbours, so it produced 6 unrelated docs, the model correctly found no
answer, and the user got *"I could not find that in the indexed sources."*
**~8 seconds and one Gemini call later.**

**Now:** two-stage matcher in `routes/ask.js`:

- `OPENER` — bare salutation/gratitude/acknowledgement/identity
- `FILLER` — **closed list** of trailing phrases (`there`, `team`,
  `how are you`, `a lot`, …)

A remainder not on the filler list **falls through to real retrieval**, which is
what keeps `"hi, what is the leave policy?"` answering from the archive.

```
hi / hello / hey / hi there / hey how are you / thanks a lot
ok / test / who are you / help / what's up     → 5–21ms, 0 Gemini calls

hi, what is the leave policy?            → 11.9s, retrieved=8, real answer ✅
hello, summarize the latest emails       → searches ✅
thanks. what decisions were made recently? → searches ✅
```

> ⚠️ **`node --check` does NOT catch bad regexes.** I wrote `thanks?+`
> (invalid — "nothing to repeat"), which took the API down on restart while
> `node --check routes/ask.js` reported exit 0. `new RegExp(...)` constructs at
> **runtime**. Always validate with
> `node -e "require('./routes/ask.js')"` (load the module) before restarting.

### The system prompt (unchanged, relevant)

```
- Answer ONLY from the provided context. Never use outside knowledge.
- Every factual claim must cite the context block it came from, like [1] or [2].
- If the context does not contain the answer, reply exactly:
  "I could not find that in the indexed sources."
```

`buildContext` sorts documents **longest-first**, so block `[n]` ≠ `docs[n-1]`.
Any citation mapping must go through the `blocks` array, never an index.

---

## 8 · AI layer

```
GEMINI_MODEL            = gemini-3.6-flash       ← set in .env
GEMINI_MODEL_FALLBACKS  = gemini-3.5-flash-lite   ← code default (.env has no such key)
timeoutMs               = 40000                  ← code default
fallbackTimeoutMs       = 90000                   ← GEMINI_FALLBACK_TIMEOUT_MS, not in .env
retryBudgetMs           = 90000                   ← GEMINI_RETRY_BUDGET_MS=90000  ✓ in .env
maxRetries              = 3
embedModel              = gemini-embedding-001  (3072 dims)
```

> Do not go looking for `GEMINI_MODEL_FALLBACKS` / `GEMINI_FALLBACK_TIMEOUT_MS`
> in `.env` — they resolve from the code defaults in `services/aiService.js`
> (L56, L81-82). The values above are **effective**, not a dump of `.env`.
> `GEMINI_RETRY_BUDGET_MS` **is** in `.env`.

- **`generateWithFallback()`** walks `MODEL_CHAIN`, advancing only on
  retryable errors. Verified live in logs:
  `gemini-3.6-flash unavailable (UPSTREAM_UNAVAILABLE); falling back to ...`
- Each model has its **own quota bucket** (per-model-per-day, ~5 RPM free tier),
  which is the point of the chain.
- **Why 90000ms fallback timeout:** a single 40s timeout applied to *all* models
  meant the slow fallback could never succeed (flash-lite measures 39–80s).
- `gemini-2.5-flash*` → **404, does not exist.**
- `gemini-3.6-flash` is fast (~2.7s) but intermittently 503s.
  `gemini-3.5-flash-lite` is slow (39–80s) but reliable.
- **Measured:** `/api/ask` ≈ **9–13s** normally; up to 68s on the fallback path
  when quota is tight.
- A type guard fails loudly if a request object is malformed (an earlier thunk-instead-of-object
  bug produced `prompt=undefined` → HTTP 400 that graceful degradation masked as an empty document).

---

## 9 · Ingestion & scheduler

`services/scheduler.js` — one poller per source, with single-flight + backoff.

```
CRON_INTERVAL=* * * * *        ← every 60s (was */2 — see below)
CRON_MAX_BACKOFF_MIN=30
CRON_STAGGER_MS=1500           ← sources run 1.5s apart
DISABLE_CRON=false
```

**Fix applied this session:** the Ingest page advertised
*"Auto-polling every 60s"* in **two places** while `.env` had
`CRON_INTERVAL=*/2` — a 2-minute cadence. The UI was describing behaviour the
backend didn't have. Changed to `* * * * *`; health now reports
`interval: * * * * *`.

**Measured cadence:** slack ran at `18:24:02`, `18:25:01`, `18:26:02` —
**average gap 60.4s** ✅

### Manual sync vs cron

| | |
|---|---|
| **"Sync now" / "Force Sync"** | **Direct.** `POST /api/gmail/fetch` calls `syncInbox()` inline and awaits it — no queue, no scheduler in the path. Measured **0.4s**. Same for Slack and Drive. |
| **Automatic** | cron, every 60s |

**A manual sync does NOT advance `lastRunAt`** — that field belongs to the cron
schedule only. A manual push correctly does not reset the automatic cadence, so
the next tick still lands on the minute. This looks like a bug and is not.

---

## 10 · Test scripts (location matters)

**Root (CommonJS):** `test_smoke.js`, `test_auth.js`, `test_datastore.js`.

**`client/` (ESM — `package.json` has `"type": "module"`):**
- `test_routes.js` — run via `npm run test:routes`
- `test_chatstore.mjs` — run via `npm run test:chatstore` (stubs `sessionStorage`)
- `check_classes.mjs` — `node check_classes.mjs`

**Temp scripts** in `C:\Users\LOQ\AppData\Local\Temp\opencode\` (recreate if gone):

| Script | Purpose |
|---|---|
| `test_sources.ps1` | asserts `cited list === source list` on 4 queries |
| `test_smalltalk.ps1` | 13 greetings must be instant; 3 real queries must still search |
| `test_greetings.ps1` | greeting latency/degenerate-reply probe |
| `verify_sync.ps1` | times manual sync + samples cron cadence over 150s |

> **PowerShell gotcha hit repeatedly this session:** nested `$(...)` with
> parens/quotes inside double-quoted strings throws
> `MissingEndParenthesisInSubexpression`. Also `Write-Output` inside a function
> becomes its **return value**, silently swallowed by `$x = (Fn)`. Use
> `Write-Host` for diagnostics, or write the script to a `.ps1` file instead of
> fighting inline quoting.

**Auth test conventions:** reuses a stable account
(`auth.suite@walchandsangli.ac.in` / `Suite@12345`) because registration is
capped 5/IP per 15min. A `429` is an explicit **SKIP**, never a pass.
Full coverage: `$env:REGISTER_RATE_MAX=500; $env:LOGIN_RATE_MAX=500; npm start`
— **`.env` is never left with these overrides.**

---

## 11 · Hard-won operational gotchas

| Gotcha | Detail |
|---|---|
| **`Test-Port` IPv6 bug (FIXED)** | `[TcpClient]::new()` creates an **IPv4** socket, so connecting it to `::1` threw *"None of the discovered or specified addresses match the socket address family"* on **every** call — the IPv6 branch was a no-op that had never once succeeded, silently reducing it to an IPv4-only check. That is why `db:start` printed "ChromaDB FAILED to open 8000" for a healthy server. Now constructs **one client per family**. |
| **`reset.js` is destructive** | Wipes Mongo documents + Chroma collection + `MATCH (n) DETACH DELETE n`. Requires `--yes`. Leading suspect for two historical Neo4j wipes. It does **not** touch `gmail_tokens.json`. |
| **Neo4j shell needs Java 21** | `$env:JAVA_HOME = "C:\jdk21\jdk-21.0.12.1+1"` first, else *"Unsupported Java 1.8.0"*. |
| **Visual graph ≠ shell** | Renders at `http://localhost:7474`, not the `neo4j$` prompt. |
| **`db:start` ≈197s** | May exceed a command timeout. Children get no std handles (mongod uses `--logpath`, Chroma `--logfile`) so they cannot hold the pipe npm waits on. |
| **Mongo 8 shutdown** | `mongod --shutdown` was removed — use `adminCommand({shutdown:1})`. |
| **Neo4j can't stop cleanly** | Console mode = no PID file, no service, `dbms.shutdown()` is Enterprise-only. The JVM is terminated directly; WAL recovers (verified by hard-kill + restart returning all nodes). |
| **`node --check` misses runtime regex** | See §7. Load the module instead. |
| **Killing VS Code kills this session** | Asked for directly once — closing VS Code terminates the agent, and the harness restart brings VS Code back, so doing it from inside is circular. Close from the taskbar/Alt+F4 instead. |
| **IPv4-only probes lie** | `Test-NetConnection 127.0.0.1` reports closed for `:5173` and `:8000`. |

---

## 12 · Verified change log (this session)

| # | Change | Evidence |
|---|---|---|
| 1 | Frontend rewritten to **"Deep Signal"** | build 216–271ms, 45.2 kB CSS, coverage 0 missing |
| 2 | `backdrop-filter` 19 → **7**, repeated cards blur-free | counted in source |
| 3 | Google OAuth reconnected | `hasRefreshToken: true`, token file 659 B |
| 4 | Gmail ingestion end-to-end | 2 fetched / 2 ingested / 0 skipped |
| 5 | Graph synced | 136 → **143** nodes, 0 failed |
| 6 | **`Test-Port` IPv6 fix** | `8000` now reads OPEN (never did before) |
| 7 | Sources filtered to cited only | `cited === source list` on 4 queries |
| 8 | Abstention → `sources: []` | 0 sources on 2 off-topic queries |
| 9 | Ref badges shown in UI | `.chat-source-ref`, coverage 228/0 |
| 10 | `retrieved` semantics restored | reports `docs.length` |
| 11 | Smalltalk short-circuit | 13 greetings 5–21ms (was 8,000ms) |
| 12 | `CRON_INTERVAL` 2min → **60s** | measured gap **60.4s** |
| 13 | Chat history persists until logout | 18 new tests, all pass |

---

## 13 · Backlog (not done — pick up if asked)

**Cleanups**
- Dead Vite scaffold (7 files, list in §2)
- Stale `chroma_data/` + `chroma_db/` (~1.9 MB)
- Empty `orgmind_gemini_docs_v1` collection (server uses `v2`)
- `.env` backups: `.env.bak-20260928-194503`, `.env.pre-demo.bak`, `.env.pre-gemini-switch.bak`
- Config drift ⚠️: `CHROMA_EMBED_DIM` code default 768 vs `.env` 3072

**Security**
- No email verification
- No password reset
- Token in `localStorage`, not `httpOnly` (deliberate — see §5)
- Per-user data scoping — currently **shared by decision**
- **Plaintext secrets in `.env`** — rotation advised

**Product**
- Frontend `bootstrap()` still blocks first paint on `/api/auth/me` (the other
  half of the original lag complaint; only the blur half was fixed)
- `show_vectors.js` prints `Swagger API docs: http://localhost:8000/docs` —
  misleading, 8000 is Chroma
- Neo4j wiped twice historically, cause unconfirmed — if it happens again,
  instrument boot-time file-existence logging instead of guessing

---

## 14 · Quick verification after any change

```powershell
# 1. backend up?
curl http://localhost:5000/health

# 2. full datastore health (needs a token)
#    POST /api/auth/login -> use token on GET /api/health/detail

# 3. all test suites
npm run test:smoke
npm run test:datastore
npm run test:auth                      # needs API
cd client; npm run test:routes; npm run test:chatstore; node check_classes.mjs

# 4. graph intact? (safe — MERGE-based, no AI calls)
npm run backfill:graph                 # expect: nodes before == nodes after

# 5. vectors intact?
npm run show:vectors
```

**Remember:** use `localhost` not `127.0.0.1`; use the project's `Test-Port`;
restart Vite (not just HMR) after touching `session.js` or adding modules.
