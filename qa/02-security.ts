/** QA-B: security boundary — signatures, secrets, injection, authorization. */
import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, makeImages, createInspection, uploadAll, complete,
         check, finding, summary } from './lib';

/** White-box: the tester knows the dev signing secret, so we can forge
 *  structurally valid URLs and probe what the signature actually authorises. */
const SECRET = process.env.UPLOAD_SIGNING_SECRET ?? 'dev-only-change-me';
const signUrl = (uploadId: string, partNumber: number, key: string,
                 expOffsetSec = 900, len = 5 * 1024 * 1024) => {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSec;
  const sig = createHmac('sha256', SECRET)
    .update(`${uploadId}:${partNumber}:${key}:${len}:${exp}`).digest('hex');
  return `${BASE}/api/v1/uploads/${uploadId}/parts/${partNumber}` +
         `?key=${encodeURIComponent(key)}&len=${len}&exp=${exp}&sig=${sig}`;
};
const put = (url: string, body: Buffer) =>
  fetch(url, { method: 'PUT', body: new Uint8Array(body), headers: { 'content-type': 'image/jpeg' } });

async function main() {
  console.log('\n═══ QA-B: SECURITY ═══\n');
  const payload = Buffer.alloc(1024, 9);

  // B1 — does the signature actually bind to part number and upload id?
  console.log('B1. Signature scope');
  {
    const images = makeImages(1);
    const c = await createInspection(images);
    const t = c.body.uploads[0];
    const good = signUrl(t.uploadId, 1, t.storageKey);
    check('B1a', 'correctly signed URL accepted', (await put(good, payload)).ok);

    // Same signature, different part number in the path.
    const tampered = good.replace('/parts/1?', '/parts/2?');
    check('B1b', 'signature does NOT transfer to another part number',
          (await put(tampered, payload)).status === 403);

    // Same signature, different upload session.
    const other = await createInspection(makeImages(1));
    const crossed = good.replace(t.uploadId, other.body.uploads[0].uploadId);
    check('B1c', 'signature does NOT transfer to another upload session',
          (await put(crossed, payload)).status === 403);

    check('B1d', 'expired signature rejected',
          (await put(signUrl(t.uploadId, 1, t.storageKey, -60), payload)).status === 403);
    check('B1e', 'tampered sig rejected',
          (await put(good.replace(/sig=.{8}/, 'sig=deadbeef'), payload)).status === 403);
    check('B1f', 'missing sig rejected',
          (await put(good.split('&sig=')[0], payload)).status === 403);
  }

  // B2 — path traversal. Assumes secret compromise; tests defence in depth.
  console.log('\nB2. Path traversal in uploadId (validly signed)');
  {
    const evil = '..%2F..%2F..%2F..%2Ftmp%2Fqa-pwned';
    const raw = '../../../../tmp/qa-pwned';
    // Sign the RAW value: the server sees the decoded param.
    const exp = Math.floor(Date.now() / 1000) + 900;
    const sig = createHmac('sha256', SECRET).update(`${raw}:1:k:1024:${exp}`).digest('hex');
    const url = `${BASE}/api/v1/uploads/${evil}/parts/1?key=k&len=1024&exp=${exp}&sig=${sig}`;
    const res = await put(url, payload);
    const escaped = existsSync('/tmp/qa-pwned');
    check('B2', 'traversal did not write outside the storage dir', !escaped, `HTTP ${res.status}`);
    if (escaped) {
      finding({ id: 'B2', severity: 'CRITICAL', title: 'Path traversal writes outside storage dir',
                detail: 'uploadId is interpolated into a filesystem path without validation.' });
    } else if (res.ok) {
      finding({ id: 'B2', severity: 'LOW',
        title: 'uploadId is not format-validated before use in a path',
        detail: `A signed request with a traversal-shaped uploadId returned ${res.status}. The ` +
                `write stayed inside the storage root here, but uploadId reaches path.join() with ` +
                `no shape check — it should be constrained to /^[a-f0-9]{32}$/ as defence in depth.` });
    }
  }

  // B3 — is the API key reachable from the browser bundle?
  console.log('\nB3. Secret leakage into the client bundle');
  {
    const dir = '.next/static';
    let hits: string[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(js|map|json)$/.test(f)) {
          const txt = readFileSync(p, 'utf8');
          for (const needle of ['GEMINI_API_KEY', 'UPLOAD_SIGNING_SECRET',
                                'generativelanguage.googleapis.com', 'DATABASE_URL',
                                'x-goog-api-key']) {
            if (txt.includes(needle)) hits.push(`${p}: ${needle}`);
          }
        }
      }
    };
    walk(dir);
    check('B3a', 'no server secret names in the client bundle', hits.length === 0,
          hits.slice(0, 3).join(' | ') || 'clean');

    const html = await (await fetch(BASE)).text();
    check('B3b', 'no secret material in the served HTML',
          !/AIza|GEMINI_API_KEY|postgresql:\/\//.test(html));
  }

  // B4 — injection through text fields.
  console.log('\nB4. Injection through user-supplied text');
  {
    const sqli = await createInspection(makeImages(1), {
      overrides: { vehicleNo: "'; DROP TABLE inspections;--" },
    });
    check('B4a', 'SQL-injection string handled as data (no 500)',
          sqli.status === 201 || sqli.status === 400, `got ${sqli.status}`);
    const stillThere = await fetch(`${BASE}/api/v1/suppliers`);
    check('B4b', 'database intact after injection attempt', stillThere.ok);

    const xss = await createInspection(makeImages(1), {
      overrides: { vehicleNo: '<img src=x onerror=alert(1)>' },
    });
    // zod max(32) may reject; either outcome is safe.
    check('B4c', 'XSS payload rejected or stored inertly',
          xss.status === 400 || xss.status === 201, `got ${xss.status}`);

    const longVal = await createInspection(makeImages(1), {
      overrides: { vehicleNo: 'A'.repeat(5000) } });
    check('B4d', 'oversized field rejected by schema', longVal.status === 400);
  }

  // B5 — content-type allow-list and declared-size ceiling.
  console.log('\nB5. Declared-input policy');
  {
    const imgs = makeImages(1);
    const svg = await createInspection(imgs, {
      overrides: { images: [{ ...(({ bytes, ...r }) => r)(imgs[0]), contentType: 'image/svg+xml' }] } });
    check('B5a', 'non-allow-listed content type rejected', svg.status === 400, `got ${svg.status}`);

    const huge = await createInspection(imgs, {
      overrides: { images: [{ ...(({ bytes, ...r }) => r)(imgs[0]), sizeBytes: 999_999_999 }] } });
    check('B5b', 'image above MAX_IMAGE_BYTES rejected', huge.status === 400, `got ${huge.status}`);

    const badHash = await createInspection(imgs, {
      overrides: { images: [{ ...(({ bytes, ...r }) => r)(imgs[0]), sha256: 'nothex' }] } });
    check('B5c', 'malformed sha256 rejected', badHash.status === 400, `got ${badHash.status}`);
  }

  // B6 — oversized part body.
  console.log('\nB6. Oversized part body');
  {
    const images = makeImages(1);
    const c = await createInspection(images);
    const t = c.body.uploads[0];
    const res = await put(signUrl(t.uploadId, 1, t.storageKey), Buffer.alloc(6_000_000, 3));
    check('B6a', 'part above the negotiated part size rejected with 413',
          res.status === 413, `got ${res.status}`);
    // And a part above the length reserved for THIS part, even if under 5 MB.
    const res2 = await put(signUrl(t.uploadId, 1, t.storageKey, 900, 1000),
                           Buffer.alloc(50_000, 3));
    check('B6b', 'part above its own signed reservation rejected with 413',
          res2.status === 413, `got ${res2.status}`);
  }

  // B7 — can a part still be written after the inspection is finalised?
  console.log('\nB7. Writing a part after the inspection is complete');
  {
    const images = makeImages(1);
    const c = await createInspection(images);
    const t = c.body.uploads[0];
    const done = await uploadAll(c.body.uploads, images);
    await complete(c.body.inspectionId, done);
    const res = await put(signUrl(t.uploadId, 1, t.storageKey), payload);
    check('B7', 'post-completion part write rejected with 409',
          res.status === 409, `got ${res.status}`);
    if (res.ok) {
      finding({ id: 'B7', severity: 'LOW',
        title: 'Part uploads are still accepted after an inspection is finalised',
        detail: `The signed URL stays live for its full 15-minute TTL even though the upload ` +
                `session is closed. The bytes are orphaned (not linked to any inspection) so no ` +
                `data is corrupted, but it is unreclaimed disk and the URL should be dead.` });
    }
  }

  // B8 — read authorization.
  console.log('\nB8. Read authorization');
  {
    const images = makeImages(1);
    const c = await createInspection(images);
    const res = await fetch(`${BASE}/api/v1/inspections/${c.body.inspectionId}`);
    check('B8', 'inspection readable without credentials (known MVP gap)', res.ok);
    finding({ id: 'B8', severity: 'INFO',
      title: 'No authentication on any endpoint',
      detail: 'Any caller who knows or guesses an inspection UUID can read its verdict, and ' +
              'anyone can POST a lab result. Documented as an explicit MVP non-goal in the ' +
              'README; flagged here so it is tracked rather than forgotten.' });
  }

  process.exit(summary('QA-B') > 0 ? 1 : 0);
}
main().catch((e) => { console.error('suite crashed:', e); process.exit(2); });
