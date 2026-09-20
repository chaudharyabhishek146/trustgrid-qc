/**
 * End-to-end exercise of the whole pipeline, acting as the mobile client.
 *   npx tsx scripts/e2e.ts
 *
 * Covers the three claims that matter most in the architecture:
 *   1. an interrupted multi-part upload RESUMES rather than restarting
 *   2. a duplicate create with the same Idempotency-Key does not duplicate
 *   3. the calibration loop produces an AI-vs-lab delta
 */
import { createHash, randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const SITE = '11111111-1111-1111-1111-111111111111';
const INSPECTOR = '33333333-3333-3333-3333-333333333333';
const SUPPLIER = '22222222-2222-2222-2222-222222222222';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

/** 4 small images + 1 large one, so at least one image is genuinely multi-part. */
function makeImages() {
  const sizes = [380_000, 410_000, 395_000, 402_000, 12_000_000];
  return sizes.map((size, i) => {
    const bytes = Buffer.alloc(size);
    for (let j = 0; j < size; j += 997) bytes[j] = (i * 31 + j) % 256;
    return { sequenceNo: i + 1, bytes, sha256: sha(bytes), sizeBytes: size,
             contentType: 'image/jpeg' as const, originalSizeBytes: size * 30 };
  });
}

async function create(idemKey: string, images: ReturnType<typeof makeImages>, vehicleNo: string) {
  const res = await fetch(`${BASE}/api/v1/inspections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idemKey },
    body: JSON.stringify({
      siteId: SITE, supplierId: SUPPLIER, inspectorId: INSPECTOR, vehicleNo,
      grossWeightKg: 24000, tareWeightKg: 9000,
      capturedAt: new Date().toISOString(),
      images: images.map(({ bytes, ...rest }) => rest),
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function uploadParts(
  uploads: any[], images: ReturnType<typeof makeImages>,
  opts: { stopAfter?: number } = {},
) {
  const done: Record<string, { partNumber: number; etag: string }[]> = {};
  let uploaded = 0;
  for (const target of uploads) {
    const img = images.find((i) => i.sequenceNo === target.sequenceNo)!;
    done[target.imageId] ??= [];
    // Parts the server reports as already durable — never re-sent.
    for (const p of target.uploadedParts ?? []) {
      if (!done[target.imageId].some((q) => q.partNumber === p.partNumber)) {
        done[target.imageId].push(p);
      }
    }
    for (const part of target.parts) {
      if (opts.stopAfter !== undefined && uploaded >= opts.stopAfter) {
        return { done, interrupted: true, uploaded };
      }
      const slice = img.bytes.subarray(part.rangeStart, part.rangeEnd);
      const res = await fetch(new URL(part.url, BASE), {
        method: 'PUT', body: slice, headers: { 'content-type': 'image/jpeg' },
      });
      if (!res.ok) throw new Error(`part upload failed: ${res.status} ${await res.text()}`);
      const body: any = await res.json();
      done[target.imageId].push({ partNumber: part.partNumber, etag: body.etag });
      uploaded++;
    }
  }
  return { done, interrupted: false, uploaded };
}

const toPayload = (done: Record<string, any[]>) =>
  ({ images: Object.entries(done).map(([imageId, parts]) => ({ imageId, parts })) });

async function main() {
  const images = makeImages();
  const totalRaw = images.reduce((n, i) => n + i.originalSizeBytes, 0);
  const totalComp = images.reduce((n, i) => n + i.sizeBytes, 0);

  console.log('\n━━━ TrustGrid QC end-to-end ━━━');
  console.log(`payload: ${(totalRaw / 1e6).toFixed(1)} MB raw → ${(totalComp / 1e6).toFixed(1)} MB after client compression\n`);

  // ── 1. Interrupted upload, then resume ───────────────────────────────────
  console.log('1. Network drops mid-upload, then resumes');
  const idemKey = randomUUID();
  const first = await create(idemKey, images, 'HR55AB1234');
  check('create returned 201', first.status === 201);
  const totalParts = first.body.uploads.reduce((n: number, u: any) => n + u.parts.length, 0);
  check(`${totalParts} parts planned across ${first.body.uploads.length} images`, totalParts > 5);

  const partial = await uploadParts(first.body.uploads, images, { stopAfter: 4 });
  check('interrupted after 4 parts', partial.interrupted && partial.uploaded === 4);

  // The client reconnects: same Idempotency-Key, fresh URLs, resume.
  const resumed = await create(idemKey, images, 'HR55AB1234');
  check('replay returned 200 (not a new inspection)', resumed.status === 200);
  check('same inspection id', resumed.body.inspectionId === first.body.inspectionId,
        resumed.body.inspectionId);

  const rest = await uploadParts(resumed.body.uploads, images);
  const merged: Record<string, any[]> = { ...partial.done };
  for (const [k, v] of Object.entries(rest.done)) {
    merged[k] = [...(merged[k] ?? []), ...v].filter(
      (p, i, arr) => arr.findIndex((q) => q.partNumber === p.partNumber) === i,
    );
  }
  const expectedRemaining = totalParts - 4;
  check(`resume re-sent NOTHING, uploaded only the ${expectedRemaining} outstanding parts`,
        rest.uploaded === expectedRemaining, `${rest.uploaded} uploaded on resume`);

  const completeRes = await fetch(`${BASE}/api/v1/inspections/${first.body.inspectionId}/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toPayload(merged)),
  });
  check('complete returned 202 (async, not blocking)', completeRes.status === 202);

  // ── 2. Async inference ───────────────────────────────────────────────────
  console.log('\n2. Worker picks the job up asynchronously');
  let data: any;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    data = await (await fetch(`${BASE}/api/v1/inspections/${first.body.inspectionId}`)).json();
    if (['completed', 'needs_review', 'failed'].includes(data.inspection.status)) break;
  }
  check(`verdict reached (${data.inspection.status})`,
        ['completed', 'needs_review'].includes(data.inspection.status));
  check('moisture present', data.analysis?.moisture_pct != null, `${data.analysis?.moisture_pct}%`);
  check('ash present', data.analysis?.ash_pct != null, `${data.analysis?.ash_pct}%`);
  check('foreign stones decided', typeof data.analysis?.foreign_stones === 'boolean',
        String(data.analysis?.foreign_stones));
  check('prompt version recorded', !!data.analysis?.prompt_version, data.analysis?.prompt_version);
  check('all 5 images durable', data.images.filter((i: any) => i.uploaded_at).length === 5);

  // ── 3. Idempotency under a retry storm ───────────────────────────────────
  console.log('\n3. Retry storm: 5 concurrent creates, one Idempotency-Key');
  const stormKey = randomUUID();
  const storm = await Promise.all(
    Array.from({ length: 5 }, () => create(stormKey, images, 'PB10XY9999')),
  );
  const ids = new Set(storm.map((r) => r.body.inspectionId));
  check('exactly one inspection created', ids.size === 1, `${ids.size} distinct id(s)`);
  check('exactly one 201 among 5 responses',
        storm.filter((r) => r.status === 201).length === 1);

  // ── 4. Calibration loop ──────────────────────────────────────────────────
  console.log('\n4. Delayed lab result → calibration delta');
  const labRes = await fetch(`${BASE}/api/v1/lab-results`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      inspectionId: first.body.inspectionId, sampleId: 'SMP-E2E-1',
      moisturePct: 12.4, ashPct: 5.8, labName: 'Central Lab', source: 'manual',
    }),
  });
  check('lab result accepted', labRes.status === 201);

  const cal = await (await fetch(`${BASE}/api/v1/calibration/summary`)).json();
  check('calibration pair produced', cal.recentPairs.length >= 1);
  const pair = cal.recentPairs[0];
  if (pair) {
    console.log(`     AI ${pair.ai_moisture}% vs lab ${pair.lab_moisture}% → Δ ${pair.moisture_delta}`);
    check('delta computed', pair.moisture_delta != null);
  }
  check('accuracy rollup available', cal.accuracy.length >= 1,
        cal.accuracy[0] && `bias ${cal.accuracy[0].moisture_bias}, n=${cal.accuracy[0].n}`);

  // ── 5. Input validation ──────────────────────────────────────────────────
  console.log('\n5. Input validation rejects bad requests');
  const noKey = await fetch(`${BASE}/api/v1/inspections`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check('missing Idempotency-Key → 400', noKey.status === 400);

  const badBody = await fetch(`${BASE}/api/v1/inspections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ siteId: 'not-a-uuid', images: [] }),
  });
  check('malformed body → 400', badBody.status === 400);

  // Malformed uploadId is rejected on shape (400) before the signature is even
  // checked; a well-formed id with a bad signature is rejected as 403.
  const badShape = await fetch(`${BASE}/api/v1/uploads/deadbeef/parts/1?key=x&len=10&exp=9999999999&sig=bad`, {
    method: 'PUT', body: new Uint8Array(Buffer.from('x')),
  });
  check('malformed uploadId → 400', badShape.status === 400, `got ${badShape.status}`);

  const forged = await fetch(
    `${BASE}/api/v1/uploads/${'a'.repeat(32)}/parts/1?key=x&len=10&exp=9999999999&sig=bad`,
    { method: 'PUT', body: new Uint8Array(Buffer.from('x')) });
  check('forged upload signature → 403', forged.status === 403, `got ${forged.status}`);

  console.log(`\n━━━ ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ━━━\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('e2e crashed:', err); process.exit(1); });
