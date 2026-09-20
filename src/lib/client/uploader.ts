import { outbox, type OutboxRecord, type OutboxImage } from './outbox';

/**
 * The sync engine: drains the outbox, resuming rather than restarting.
 *
 * Flow per record:
 *   1. POST /inspections with the record's id as Idempotency-Key
 *      -> inspection_id + fresh presigned part URLs for whatever is NOT yet
 *         uploaded. Re-minting on every attempt is the normal path, because
 *         upload URLs are deliberately short-lived.
 *   2. PUT each outstanding part directly to storage; record the ETag in
 *      IndexedDB as each one lands.
 *   3. POST /complete -> server verifies, enqueues inference, returns 202.
 *
 * Kill the network at part 3 of 5 and the next pass resumes at part 3. Parts
 * 1-2 are already durable in the bucket and are never re-sent.
 */

/** Exponential backoff with FULL jitter. After a site-wide outage every device
 *  in the yard reconnects at once; synchronised retries would be a
 *  self-inflicted thundering herd. */
function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, 60_000) * (0.5 + Math.random() * 0.5);
}

/** 400/403/413 mean the request itself is wrong — retrying burns battery for
 *  nothing. Only 408/429/5xx and transport errors are worth another attempt. */
const isRetryableStatus = (s: number) => s === 408 || s === 429 || s >= 500;

const MAX_ATTEMPTS = 8;

export type ProgressFn = (id: string, msg: string, partsDone?: number, partsTotal?: number) => void;

export async function syncRecord(rec: OutboxRecord, onProgress?: ProgressFn): Promise<void> {
  const report = (m: string, d?: number, t?: number) => onProgress?.(rec.id, m, d, t);

  try {
    await outbox.patch(rec.id, { status: 'uploading', lastError: undefined });

    // ── 1. Create (or resume) the inspection ────────────────────────────────
    report('registering inspection…');
    const createRes = await fetch('/api/v1/inspections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': rec.id },
      body: JSON.stringify({
        ...rec.meta,
        capturedAt: rec.capturedAt,
        deviceId: getDeviceId(),
        appVersion: '0.1.0',
        images: rec.images.map((i) => ({
          sequenceNo: i.sequenceNo,
          sha256: i.sha256,
          sizeBytes: i.sizeBytes,
          contentType: i.contentType,
          originalSizeBytes: i.originalSizeBytes,
          widthPx: i.widthPx,
          heightPx: i.heightPx,
        })),
      }),
    });

    if (!createRes.ok) {
      throw new HttpError(`create failed: ${await safeText(createRes)}`, createRes.status);
    }

    const { inspectionId, uploads } = await createRes.json();
    await outbox.patch(rec.id, { inspectionId });

    // ── 2. Upload outstanding parts, resuming where we left off ─────────────
    const current = (await outbox.get(rec.id))!;
    const totalParts = uploads.reduce((n: number, u: any) => n + u.parts.length, 0);
    let donePartsCount = 0;

    for (const target of uploads) {
      const img = current.images.find((i) => i.sequenceNo === target.sequenceNo);
      if (!img) continue;

      img.imageId = target.imageId;
      img.uploadId = target.uploadId;
      img.completedParts ??= [];

      // Trust storage over local bookkeeping: merge in any part the server
      // says is already durable. Covers a reinstall or cleared site data.
      for (const p of target.uploadedParts ?? []) {
        if (!img.completedParts.some((q) => q.partNumber === p.partNumber)) {
          img.completedParts.push(p);
        }
      }

      for (const part of target.parts) {
        // ─── THE RESUME ─── already ACKed in a previous attempt: skip it.
        if (img.completedParts.some((p) => p.partNumber === part.partNumber)) {
          donePartsCount++;
          continue;
        }

        const slice = img.blob.slice(part.rangeStart, part.rangeEnd);
        report(`uploading photo ${target.sequenceNo} part ${part.partNumber}`,
               donePartsCount, totalParts);

        // Demo hook: lets the live demo kill the network mid-transfer and show
        // that the next pass resumes at this exact part rather than restarting.
        if (simulatedDropEnabled()) {
          throw new Error('Simulated network drop (demo toggle is on)');
        }

        const putRes = await fetch(part.url, {
          method: 'PUT',
          body: slice,
          headers: { 'content-type': img.contentType },
        });
        if (!putRes.ok) {
          throw new HttpError(`part ${part.partNumber} failed: HTTP ${putRes.status}`, putRes.status);
        }

        const etag = await extractEtag(putRes);
        img.completedParts.push({ partNumber: part.partNumber, etag });
        donePartsCount++;

        // Persist after EVERY part. If the phone dies on the next byte, this
        // part is still recorded as done and is never re-sent.
        await outbox.put(current);
        report(`uploaded photo ${target.sequenceNo} part ${part.partNumber}`,
               donePartsCount, totalParts);
      }
      img.uploadedAt = Date.now();
      await outbox.put(current);
    }

    // ── 3. Complete ─────────────────────────────────────────────────────────
    report('finalising…');
    const completeRes = await fetch(`/api/v1/inspections/${inspectionId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        images: current.images
          .filter((i) => i.imageId && i.completedParts?.length)
          .map((i) => ({ imageId: i.imageId!, parts: i.completedParts! })),
      }),
    });
    if (!completeRes.ok) {
      throw new HttpError(`complete failed: ${await safeText(completeRes)}`, completeRes.status);
    }

    await outbox.patch(rec.id, { status: 'awaiting_result', attempts: 0, lastError: undefined });
    report('uploaded — analysis pending');
  } catch (err: any) {
    const attempts = rec.attempts + 1;
    const retryable = !(err instanceof HttpError) || isRetryableStatus(err.status);
    const giveUp = !retryable || attempts >= MAX_ATTEMPTS;

    await outbox.patch(rec.id, {
      status: giveUp ? 'failed_permanent' : 'pending',
      attempts,
      lastError: String(err?.message ?? err),
      nextAttemptAt: giveUp ? undefined : Date.now() + backoffMs(attempts),
    });
    report(giveUp ? `failed: ${err?.message}` : `retrying shortly (attempt ${attempts})`);
    if (giveUp) throw err;
  }
}

/** Drain every due record. Safe to call on an interval, on `online`, and on
 *  window focus — all three are wired up in the UI. */
export async function drainOutbox(onProgress?: ProgressFn): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  for (const rec of await outbox.due()) {
    if (rec.status === 'awaiting_result') continue;   // the poller owns these
    try {
      await syncRecord(rec, onProgress);
    } catch {
      // Already recorded on the record; keep draining the rest.
    }
  }
}

/** Demo-only. Controlled by the "Simulate network drop" toggle in the UI. */
function simulatedDropEnabled(): boolean {
  try { return sessionStorage.getItem('tg-simulate-drop') === 'true'; }
  catch { return false; }
}

class HttpError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function extractEtag(res: Response): Promise<string> {
  const header = res.headers.get('etag');
  if (header) return header.replaceAll('"', '');
  try {
    const body = await res.clone().json();
    if (body?.etag) return String(body.etag);
  } catch { /* S3 returns an empty body */ }
  return 'unknown';
}

const safeText = (res: Response) => res.text().then((t) => t.slice(0, 300)).catch(() => `HTTP ${res.status}`);

function getDeviceId(): string {
  const KEY = 'tg-device-id';
  let id = localStorage.getItem(KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
  return id;
}
