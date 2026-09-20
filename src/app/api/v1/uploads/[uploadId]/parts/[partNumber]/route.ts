import { NextRequest, NextResponse } from 'next/server';
import { localStorage as localAdapter, verifyPartUrl, isLocalBackend,
         isValidUploadId } from '@/lib/services/storage';
import { config } from '@/lib/config';

export const runtime = 'nodejs';

/**
 * PUT /api/v1/uploads/:uploadId/parts/:partNumber?key=&exp=&sig=
 *
 * The LOCAL storage backend's stand-in for a presigned S3 part URL. Under
 * STORAGE_BACKEND=s3 this route is unreachable by design — the browser PUTs
 * parts straight to the bucket and these bytes never enter the app tier.
 *
 * Authorised solely by the HMAC signature in the query string: no session, no
 * cookie, time-limited, and scoped to one upload + one part + one key.
 */
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ uploadId: string; partNumber: string }> },
) {
  if (!isLocalBackend) {
    return NextResponse.json(
      { error: 'Local part upload is disabled under STORAGE_BACKEND=s3' }, { status: 404 },
    );
  }

  const { uploadId, partNumber } = await ctx.params;
  const n = Number.parseInt(partNumber, 10);
  const key = req.nextUrl.searchParams.get('key') ?? '';
  const len = req.nextUrl.searchParams.get('len') ?? '';
  const exp = req.nextUrl.searchParams.get('exp') ?? '';
  const sig = req.nextUrl.searchParams.get('sig') ?? '';

  if (!Number.isInteger(n) || n < 1) {
    return NextResponse.json({ error: 'Invalid part number' }, { status: 400 });
  }
  // Defence in depth: uploadId is interpolated into a filesystem path, so its
  // shape is checked here rather than trusting framework URL normalisation.
  if (!isValidUploadId(uploadId)) {
    return NextResponse.json({ error: 'Invalid upload id' }, { status: 400 });
  }
  if (!verifyPartUrl(uploadId, n, key, len, exp, sig)) {
    // Covers both a forged signature and an expired URL. An expired URL is the
    // normal case after a long offline gap: the client re-mints via POST
    // /inspections with the same Idempotency-Key and resumes.
    return NextResponse.json({ error: 'Invalid or expired upload URL' }, { status: 403 });
  }

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) {
    return NextResponse.json({ error: 'Empty part' }, { status: 400 });
  }
  // The signed `len` is the exact size reserved for THIS part, so a client
  // cannot store more than it declared at create time (QA-A3).
  const maxBytes = Math.min(Number(len), config.policy.partSizeBytes);
  if (body.length > maxBytes) {
    return NextResponse.json(
      { error: `Part exceeds the ${maxBytes} bytes reserved for it` }, { status: 413 });
  }

  const etag = await localAdapter.writePart(uploadId, n, body);
  if (etag === null) {
    // The multipart session is closed (inspection already finalised) or was
    // never opened. The signed URL may still be within its TTL, but there is
    // nothing left to upload into.
    return NextResponse.json({ error: 'Upload session is closed' }, { status: 409 });
  }

  // ETag header mirrors S3, so the client's resume bookkeeping is identical
  // across both backends.
  return NextResponse.json({ etag, partNumber: n, bytes: body.length },
                           { headers: { ETag: `"${etag}"` } });
}
