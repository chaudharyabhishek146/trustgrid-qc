# TrustGrid QC — Beta QA Report

**Build under test:** TrustGrid QC MVP (Next.js 15 + Node worker + PostgreSQL 16)
**Date:** 2026-09-20
**Mode:** `MOCK_GEMINI=true` for functional runs; `MOCK_GEMINI=false` with an invalid key for dependency-failure injection
**Environment:** production build (`npm start`), real Postgres in Docker, real worker process

---

## 1. Verdict

**Ship to a pilot gate — after the fixes in §4, which are already applied and re-verified.**

The entry state had **9 defects**, including **3 that would have caused wrong or missing
quality data at a weighbridge**. All 3 are fixed and re-tested under the original failing
conditions. One known gap (authentication) remains open by design and is tracked.

| | Entry | Exit |
|---|---|---|
| Automated checks passing | 30 | **87** |
| Defects open | 9 | **1** (INFO, by design) |
| HIGH severity open | 3 | **0** |
| Inspections lost in any scenario tested | — | **0** |

### Coverage

| Suite | Focus | Checks |
|---|---|---|
| `npm test` | Schema validation + plausibility gate (unit) | 11 |
| `npm run e2e` | Happy path, resume, idempotency, calibration | 23 |
| `qa/01-integrity.ts` | Corrupt / truncated / oversized / cross-tenant data | 8 |
| `qa/02-security.ts` | Signature scope, traversal, secret leakage, injection, authz | 20 |
| `qa/03-state.ts` | State machine, concurrency, DB invariants | 25 |
| `qa/04-failure.ts` | Dependency outage, worker death, recovery | scenario-driven |
| | **Total** | **87 assertions** |

Run everything with `npm test && npm run e2e && npm run qa`.

---

## 2. Test approach

I deliberately did **not** re-run the happy path the developer already had passing. The
value of a QA pass is in the paths nobody built for:

1. **Lie to the server.** Declare one hash, upload different bytes. Claim parts that were
   never sent. Reference another inspection's image. Declare 300 KB and send 4.5 MB.
2. **Attack the trust boundary.** Assume the signing secret leaked (white-box) and test
   what a valid signature actually authorises — other parts, other sessions, other paths.
3. **Break it concurrently.** Five simultaneous creates, completes and re-analyses against
   one record, then assert database invariants directly in SQL rather than through the API.
4. **Break the dependency for real.** Not a mocked failure — a worker pointed at the live
   Gemini endpoint with an invalid key, producing genuine HTTP 400s, genuine retries and a
   genuine circuit-breaker trip.
5. **Check claims against code.** Every resilience promise in the README was treated as a
   test assertion. Two of them were false.

---

## 3. Defects found

Severity reflects impact on a system where the output settles supplier payments.

| ID | Sev | Title | Status |
|---|---|---|---|
| **D2** | 🔴 HIGH | A failed re-analysis destroys a good verdict | ✅ Fixed |
| **D1** | 🔴 HIGH | `failed` reported while retries are still pending; client stops polling | ✅ Fixed |
| **A1** | 🔴 HIGH | Declared SHA-256 never verified (README claimed it was) | ✅ Fixed |
| **D5** | 🟠 MED | Retry budget consumed during an outage; inspections park as failed | ✅ Fixed |
| **A2** | 🟠 MED | Phantom part → HTTP 500 instead of a clean 4xx | ✅ Fixed |
| **A3** | 🟠 MED | A part may exceed the size reserved for it (unmetered storage) | ✅ Fixed |
| **E1** | 🟡 LOW | Abandoned upload sessions never reclaimed (30 dirs / 20 MB observed) | ✅ Fixed |
| **B7** | 🟡 LOW | Part uploads accepted after an inspection is finalised | ✅ Fixed |
| **B2** | 🟡 LOW | `uploadId` not format-validated before reaching a filesystem path | ✅ Fixed |
| **B8** | ⚪ INFO | No authentication on any endpoint | ⏸ Open by design |

---

### 🔴 D2 — A failed re-analysis destroys a good verdict

**The most serious defect found.** Every analysis attempt, including failures, set
`is_current = TRUE`. A transient Gemini outage during a re-run therefore demoted a
perfectly good verdict and replaced it with an empty failure row.

**Reproduction (observed):** an inspection with a delivered verdict of **11.28 % moisture**,
re-analysed while the dependency was broken:

```
attempt_no | status     | moisture | is_current
         1 | succeeded  | 11.28    | f     ← the real measurement, demoted
         2 | failed_api | (null)   | f
         3 | failed_api | (null)   | t     ← what the API now returned

API response:  inspection.status = failed
               analysis.status   = failed_api
               moisture_pct      = None      ← the reading was simply gone
```

**Impact:** a measurement already delivered to the inspector, and potentially already
used to price a load, silently disappears because a third-party API had a bad minute.
In a payments context this is data loss, not a display glitch.

**Fix:** a failed attempt is still recorded (append-only history is preserved) but is
inserted with `is_current = false` and never demotes the previous verdict.
`markInspectionFailed` restores `completed`/`needs_review` when a good verdict exists.

**Re-verified under the original failing conditions** — 4 consecutive failed re-runs:

```
attempt_no | status     | moisture | is_current
         1 | succeeded  | 11.28    | t     ← still current, still correct
         2 | failed_api | -        | f
         3 | failed_api | -        | f
         4 | failed_api | -        | f
         5 | failed_api | -        | f

API response:  analysis.status = succeeded,  moisture_pct = 11.28  ✓
```

---

### 🔴 D1 — `failed` reported while retries are still pending

`runAnalysis` set `inspections.status = 'failed'` on **every** failed attempt, including
attempts with retries remaining.

**Reproduction (observed):**

```
inspection.status | job.status | attempts
failed            | queued     | 3/5      ← still retrying, already declared failed
failed            | queued     | 3/5
failed            | queued     | 4/5
```

**Impact:** the client treats `failed` as terminal — it marks the outbox record done and
stops polling. So when a retry later succeeded, **the inspector never saw the result**.
The verdict existed in the database and never reached the person at the gate.

**Fix:** `runAnalysis` no longer declares failure. The worker calls `markInspectionFailed`
only once `failJob` reports the retry budget is exhausted, so `failed` is genuinely
terminal and the client can trust it.

**Re-verified:** `inspection.status = processing` with `attempts = 4/5` — polling continues.

---

### 🔴 A1 — Declared SHA-256 never verified

The client computed a SHA-256 per image, sent it at create time, and the server stored it
in `inspection_images.sha256` — then never compared it to anything. The only integrity
check was `sizeBytes > 0`.

Both the README ("SHA-256 computed on device, declared at create, object verified at
completion") and the code comment ("Local backend verifies the full SHA-256") asserted a
check that did not exist.

**Reproduction:** uploaded bytes deliberately mismatching the declared hash →
`202 Accepted`, and the corrupted image was analysed and given a moisture reading.

**Impact:** a truncated or corrupted upload is graded as if it were a real photograph of
the load. Silent wrong data is worse than a visible failure.

**Fix:** added `objectSha256()` to the storage adapter; the assembled object is hashed at
completion and compared to the declaration. Mismatch → `422` and the multipart session is
aborted so no half-good object is left for a later retry to adopt. (S3 returns `null` and
falls back to size verification — a streaming verification job is the documented
follow-up, and the code now says so honestly.)

**Re-verified:** corrupted upload → `422`.

---

### 🟠 D5 — Retry budget consumed during an outage

The README promised: *"Sustained outage → jobs accumulate in the queue instead of failing.
Drains automatically when service returns."* They did not. Each job burned its 5 attempts
against a dead dependency and parked permanently as `failed`, requiring manual
intervention to recover.

**This one needed two passes.** The first fix requeued without consuming an attempt once
the breaker tripped — but the breaker reset `consecutiveFailures = 0` when it opened, so
after each 30 s cooldown it had forgotten it was degraded and burned one more attempt.
Re-testing showed the job still reaching `5/5` and failing:

```
t+20s: queued  attempts=4/5
t+40s: failed  attempts=5/5     ← still exhausted
```

**Root cause:** "consecutive failures" was being reset by the breaker opening rather than
by a success, destroying the very signal the breaker depends on.

**Fix:** `consecutiveFailures` is now reset **only by a successful job**. While degraded,
every failure requeues without consuming budget.

**Re-verified over a sustained 2-minute outage:**

```
t+30s   jobs: queued:1/5 queued:2/5 queued:1/5  |  inspections: processing
t+60s   jobs: queued:1/5 queued:2/5 queued:1/5  |  inspections: processing
t+90s   jobs: queued:1/5 queued:2/5 queued:1/5  |  inspections: processing
t+120s  jobs: queued:1/5 queued:2/5 queued:1/5  |  inspections: processing

breaker openings: 4      permanently failed jobs: 0
```

Then, on restoring a healthy worker, all three drained automatically to
`needs_review` with the correct verdict and **9 failed-attempt rows preserved** for
forensics. Zero inspections lost.

**Accepted trade-off:** a job that fails consistently for a non-dependency reason can now
retry indefinitely while the breaker reads as degraded. That is the correct bias for this
product — never lose an inspection — and the condition is visible in `analysis_jobs`
(`status`, `attempts`, `last_error`). Queue-depth alerting is the documented next step.

---

### 🟠 A2 — Phantom part returned HTTP 500

A client claiming a part number it never uploaded caused an unhandled `ENOENT` from
`readFile` → `500`. A malformed client request should never present as a server fault,
and a 500 both leaks an internal path and tells the client to retry something that will
never succeed.

**Fix:** the missing part is caught and surfaced as `422 Part N was never uploaded`.

---

### 🟠 A3 — A part could exceed its reserved size

The part endpoint capped a part at the global 5 MB part size but never compared against
the size the client declared at create time. An image declared as 300 KB accepted a
4.5 MB part — roughly 16× the reserved storage, entirely unmetered.

**Fix:** the byte length reserved for each part is now part of the **signed** payload
(`uploadId:partNumber:key:len:exp`) and enforced on upload, so a client cannot store more
than it reserved. Verified at both bounds: over the global cap → `413`, and over this
part's own reservation → `413`.

---

### 🟡 E1 — Abandoned upload sessions never reclaimed

Observed during testing: **30 orphaned upload directories, 20 MB** accumulated from
interrupted and abandoned uploads, with no reaper. `ARCHITECTURE.md` claimed "a bucket
lifecycle rule aborts incomplete multipart uploads after 24 h" — true for S3, but the
local backend had nothing.

On a real gate with flaky connectivity, abandoned sessions are the *normal* case, not the
exception, so this grows without bound.

**Fix:** `cleanupStaleUploads()` added to the storage adapter and wired into the worker's
periodic sweep alongside stale-job reaping. The S3 implementation documents the
equivalent bucket lifecycle rule rather than duplicating it.

---

### 🟡 B7 — Parts accepted after an inspection was finalised

A signed URL stayed live for its full 15-minute TTL even after the upload session was
closed by completion, letting a client write bytes that no inspection would ever
reference.

**Fix:** `writePart` now refuses when the session directory no longer exists → `409 Upload
session is closed`.

---

### 🟡 B2 — `uploadId` not format-validated

`uploadId` came straight from the URL path into `path.join()`. A traversal-shaped value
with a valid signature was neutralised only because Next.js normalised the URL first —
the application itself had no check. Relying on framework normalisation for a filesystem
write is fragile.

**Fix:** `uploadId` must match `/^[a-f0-9]{32}$/` before it is used, rejected as `400`.
Verified: no write escaped the storage root, before or after.

---

### ⚪ B8 — No authentication (open, by design)

Any caller who knows an inspection UUID can read its verdict, and anyone can POST a lab
result. This is documented as an explicit MVP non-goal in the README and is listed here so
it is tracked rather than forgotten.

**Required before any real pilot**, because lab results feed model calibration: an
unauthenticated write path lets anyone poison the training signal. Recommendation: JWT
session for inspectors, row-level security scoped by `site_id`, and a signed webhook
secret for the LIMS integration.

---

## 4. What held up well

Worth stating plainly, because these are the parts that were designed rather than patched:

| Area | Result |
|---|---|
| **Signature scoping** | A valid signature does not transfer to another part number, another upload session, or past its expiry. 6/6 attacks rejected |
| **Secret handling** | No API key, signing secret or connection string in the client bundle or served HTML. Clean |
| **Injection** | SQL injection stored as inert data; database intact; oversized and malformed fields rejected by schema |
| **Concurrency** | 5 concurrent creates → 1 inspection. 5 concurrent completes → 1 job. 5 concurrent re-analyses → at most 1 extra analysis. No 5xx anywhere |
| **Transactional enqueue** | Zero inspections in `ready` without a job, across the entire campaign |
| **Append-only history** | Zero inspections with two `is_current` rows; attempt numbers increment correctly; provenance present on every row |
| **Worker death** | A job held by a dead worker was reclaimed, reprocessed and completed automatically |
| **Resume** | Interrupted upload re-sent nothing — only the 3 outstanding parts of 7 |

The database invariants in particular passed *before* any fixes, which says the schema
design was sound even where the application logic was not.

## 5. Residual risks and recommendations

| Priority | Item |
|---|---|
| **P0 before pilot** | Authentication + RLS by `site_id`; signed LIMS webhook (B8) |
| **P1** | Queue-depth and breaker-state alerting — the outage behaviour is now correct but silent |
| **P1** | Streaming SHA-256 verification job for the S3 backend (local is covered) |
| **P2** | A job failing for a non-dependency reason can retry indefinitely while the breaker reads degraded; add a poison-message quarantine |
| **P2** | `inspection.status` can read `processing` while a valid earlier verdict is current — cosmetic, resolves on settle |
| **P3** | Load/soak testing was out of scope: concurrency was tested for correctness, not throughput |

## 6. Not covered by this pass

Stated so the gaps are known rather than assumed:

- **Real Gemini accuracy.** All functional runs used the deterministic mock. Failure
  behaviour was tested against the live endpoint, but no judgement is offered on the
  model's actual moisture or ash accuracy — that is what the calibration loop is for.
- **Real mobile devices.** The client was exercised in a desktop browser. Background Sync
  on iOS Safari, real camera capture and true low-bandwidth radio behaviour are untested
  on hardware.
- **Load and soak.** No sustained throughput, connection-pool exhaustion or multi-worker
  scaling test.
- **S3/MinIO backend.** All runs used `STORAGE_BACKEND=local`. The S3 adapter compiles and
  its lifecycle is implemented, but it was not exercised end to end.
