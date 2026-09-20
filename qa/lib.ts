/** Shared helpers for the QA suites. */
import { createHash, randomUUID } from 'node:crypto';

export const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
export const SITE = '11111111-1111-1111-1111-111111111111';
export const INSPECTOR = '33333333-3333-3333-3333-333333333333';
export const SUPPLIER = '22222222-2222-2222-2222-222222222222';

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TestImage {
  sequenceNo: number; bytes: Buffer; sha256: string;
  sizeBytes: number; contentType: string; originalSizeBytes: number;
}

export function makeImage(seq: number, size = 300_000, seed = 1): TestImage {
  const bytes = Buffer.alloc(size);
  for (let j = 0; j < size; j += 331) bytes[j] = (seed * 17 + j) % 256;
  return { sequenceNo: seq, bytes, sha256: sha(bytes), sizeBytes: size,
           contentType: 'image/jpeg', originalSizeBytes: size * 30 };
}

export const makeImages = (n = 5, size = 300_000) =>
  Array.from({ length: n }, (_, i) => makeImage(i + 1, size, i + 1));

export async function createInspection(
  images: TestImage[], opts: { key?: string; overrides?: any } = {},
) {
  const res = await fetch(`${BASE}/api/v1/inspections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'idempotency-key': opts.key ?? randomUUID() },
    body: JSON.stringify({
      siteId: SITE, supplierId: SUPPLIER, inspectorId: INSPECTOR,
      vehicleNo: 'QA0000', capturedAt: new Date().toISOString(),
      images: images.map(({ bytes, ...r }) => r),
      ...opts.overrides,
    }),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, body };
}

/** Upload every part. `mutate` can corrupt the bytes for integrity tests. */
export async function uploadAll(
  uploads: any[], images: TestImage[],
  mutate?: (b: Buffer, seq: number) => Buffer,
) {
  const done: Record<string, { partNumber: number; etag: string }[]> = {};
  for (const target of uploads) {
    const img = images.find((i) => i.sequenceNo === target.sequenceNo)!;
    done[target.imageId] ??= [];
    for (const p of target.uploadedParts ?? []) done[target.imageId].push(p);
    for (const part of target.parts) {
      let slice = img.bytes.subarray(part.rangeStart, part.rangeEnd);
      if (mutate) slice = mutate(Buffer.from(slice), target.sequenceNo);
      const res = await fetch(new URL(part.url, BASE), {
        method: 'PUT', body: new Uint8Array(slice), headers: { 'content-type': 'image/jpeg' },
      });
      if (!res.ok) throw new Error(`part PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
      done[target.imageId].push({ partNumber: part.partNumber, etag: (await res.json()).etag });
    }
  }
  return done;
}

export async function complete(id: string, done: Record<string, any[]>) {
  const res = await fetch(`${BASE}/api/v1/inspections/${id}/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      images: Object.entries(done).map(([imageId, parts]) => ({ imageId, parts })),
    }),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

export async function waitForVerdict(id: string, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  let data: any;
  while (Date.now() < until) {
    await sleep(400);
    const res = await fetch(`${BASE}/api/v1/inspections/${id}`);
    if (!res.ok) continue;
    data = await res.json();
    if (['completed', 'needs_review', 'failed'].includes(data.inspection.status)) return data;
  }
  return data;
}

// ── tiny test harness ───────────────────────────────────────────────────────
export interface Finding {
  id: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  title: string; detail: string;
}
export const findings: Finding[] = [];
let passed = 0, failed = 0;

export function check(id: string, name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  ✗ ${id} ${name}${detail ? ` — ${detail}` : ''}`); }
  return cond;
}

export function finding(f: Finding) {
  findings.push(f);
  console.log(`  ⚠ [${f.severity}] ${f.id} ${f.title} — ${f.detail}`);
}

export function summary(label: string) {
  console.log(`\n━━━ ${label}: ${passed} passed, ${failed} failed, ${findings.length} finding(s) ━━━`);
  return failed;
}
export const counts = () => ({ passed, failed });
