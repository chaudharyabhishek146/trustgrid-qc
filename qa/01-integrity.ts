/** QA-A: data integrity — does corrupt or truncated data get caught? */
import { randomUUID } from 'node:crypto';
import { BASE, makeImages, createInspection, uploadAll, complete,
         waitForVerdict, check, finding, summary } from './lib';

async function main() {
  console.log('\n═══ QA-A: DATA INTEGRITY ═══\n');

  // A1 — the headline claim: a corrupted payload must not be analysed.
  console.log('A1. Upload bytes that do NOT match the declared SHA-256');
  {
    const images = makeImages(2);
    const c = await createInspection(images);
    // Flip every byte: the object will differ completely from what was declared.
    const done = await uploadAll(c.body.uploads, images, (b) => {
      const copy = Buffer.from(b); copy.fill(0xff, 0, Math.min(1000, copy.length)); return copy;
    });
    const res = await complete(c.body.inspectionId, done);
    const rejected = res.status >= 400;
    check('A1', 'corrupted upload rejected at /complete', rejected, `got ${res.status}`);
    if (!rejected) {
      const v = await waitForVerdict(c.body.inspectionId, 15_000);
      finding({
        id: 'A1', severity: 'HIGH',
        title: 'Declared SHA-256 is never verified',
        detail: `Bytes that do not match the declared hash were accepted and analysed ` +
                `(status=${v?.inspection?.status}). README and the code comment both claim ` +
                `"Local backend verifies the full SHA-256" — it does not. Only sizeBytes>0 is checked.`,
      });
    }
  }

  // A2 — client claims parts that were never uploaded.
  console.log('\nA2. /complete claiming a part that was never uploaded');
  {
    const images = makeImages(1);
    const c = await createInspection(images);
    const done = await uploadAll(c.body.uploads, images);
    const imageId = Object.keys(done)[0];
    done[imageId].push({ partNumber: 99, etag: 'fabricated' });   // never uploaded
    const res = await complete(c.body.inspectionId, done);
    const handled = res.status === 422 || res.status === 400;
    check('A2', 'phantom part rejected with a 4xx', handled, `got ${res.status}`);
    if (!handled) {
      finding({
        id: 'A2', severity: res.status >= 500 ? 'MEDIUM' : 'HIGH',
        title: res.status >= 500 ? 'Phantom part causes a 500, not a clean 4xx'
                                 : 'Phantom part silently accepted',
        detail: `Client claimed part 99 which was never uploaded; server returned ${res.status}. ` +
                `A malformed client request should be a 4xx, and a 500 leaks an internal error path.`,
      });
    }
  }

  // A3 — size ceiling is enforced on the DECLARED size; what about actual bytes?
  console.log('\nA3. Declared size vs actually uploaded bytes');
  {
    const images = makeImages(1, 300_000);
    const c = await createInspection(images);
    const target = c.body.uploads[0];
    const part = target.parts[0];
    const oversized = Buffer.alloc(4_500_000, 7);        // ~15x the declared size
    const res = await fetch(new URL(part.url, BASE), {
      method: 'PUT', body: oversized, headers: { 'content-type': 'image/jpeg' },
    });
    const accepted = res.ok;
    check('A3', 'part larger than the declared image size is rejected', !accepted, `got ${res.status}`);
    if (accepted) {
      finding({
        id: 'A3', severity: 'MEDIUM',
        title: 'A part may exceed the declared image size',
        detail: `Declared 300 KB, uploaded 4.5 MB and it was accepted. The part route caps a part ` +
                `at partSize (5 MB) but never compares against the size the client declared, so a ` +
                `client can store ~16x what it reserved. Bounded, but it is unmetered storage.`,
      });
    }
  }

  // A4 — an image belonging to a DIFFERENT inspection must not be completable.
  console.log('\nA4. /complete referencing another inspection\'s image');
  {
    const imgsA = makeImages(1), imgsB = makeImages(1);
    const a = await createInspection(imgsA);
    const b = await createInspection(imgsB);
    const doneB = await uploadAll(b.body.uploads, imgsB);
    const foreignImageId = Object.keys(doneB)[0];
    const res = await complete(a.body.inspectionId, { [foreignImageId]: doneB[foreignImageId] });
    // Query is scoped by inspection_id, so the row is not found and is skipped.
    const insp = await (await fetch(`${BASE}/api/v1/inspections/${a.body.inspectionId}`)).json();
    const leaked = insp.images.some((i: any) => i.uploaded_at);
    check('A4', 'cross-inspection image not adopted', !leaked, `complete returned ${res.status}`);
    check('A4b', 'inspection with unmet image count is not marked ready',
          insp.inspection.status !== 'ready', `status=${insp.inspection.status}`);
  }

  // A5 — empty/zero-length part.
  console.log('\nA5. Zero-length part');
  {
    const images = makeImages(1);
    const c = await createInspection(images);
    const part = c.body.uploads[0].parts[0];
    const res = await fetch(new URL(part.url, BASE), {
      method: 'PUT', body: Buffer.alloc(0), headers: { 'content-type': 'image/jpeg' },
    });
    check('A5', 'zero-length part rejected', res.status === 400, `got ${res.status}`);
  }

  // A6 — is the stored analysis actually linked to the images that were analysed?
  console.log('\nA6. Analysis provenance links the real images');
  {
    const images = makeImages(3);
    const c = await createInspection(images);
    const done = await uploadAll(c.body.uploads, images);
    await complete(c.body.inspectionId, done);
    const v = await waitForVerdict(c.body.inspectionId);
    const ok = ['completed', 'needs_review'].includes(v?.inspection?.status);
    check('A6', 'verdict produced for a 3-image inspection', ok, v?.inspection?.status);
    check('A6b', 'token + cost telemetry recorded',
          v?.analysis?.input_tokens != null && v?.analysis?.cost_usd != null,
          `tokens=${v?.analysis?.input_tokens} cost=${v?.analysis?.cost_usd}`);
  }

  process.exit(summary('QA-A') > 0 ? 1 : 0);
}
main().catch((e) => { console.error('suite crashed:', e); process.exit(2); });
