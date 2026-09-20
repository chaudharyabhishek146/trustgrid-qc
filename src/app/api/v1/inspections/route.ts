import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createInspection } from '@/lib/services/inspections';
import { ensurePromptVersionRegistered } from '@/lib/services/prompt';
import { config } from '@/lib/config';

export const runtime = 'nodejs';

const imageSchema = z.object({
  sequenceNo: z.number().int().min(1).max(20),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 hex chars'),
  sizeBytes: z.number().int().positive().max(config.policy.maxImageBytes),
  contentType: z.enum(['image/jpeg', 'image/webp', 'image/png']),
  originalSizeBytes: z.number().int().positive().optional(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  angleHint: z.string().max(40).optional(),
});

const bodySchema = z.object({
  siteId: z.string().uuid(),
  supplierId: z.string().uuid(),
  inspectorId: z.string().uuid(),
  vehicleNo: z.string().min(1).max(32),
  weighbridgeTicket: z.string().max(64).optional(),
  grossWeightKg: z.number().nonnegative().optional(),
  tareWeightKg: z.number().nonnegative().optional(),
  capturedAt: z.string().datetime(),
  deviceId: z.string().max(128).optional(),
  appVersion: z.string().max(32).optional(),
  images: z.array(imageSchema).min(1).max(20),
});

/**
 * POST /api/v1/inspections
 *
 * Creates the inspection and mints resumable upload sessions. Note what this
 * endpoint does NOT do: receive image bytes. It exchanges ~1 KB of JSON for a
 * set of URLs, so the app tier never handles a 15 MB payload.
 *
 * Requires an Idempotency-Key header — a client-generated UUID minted at
 * capture time and reused across every retry of this inspection.
 */
export async function POST(req: NextRequest) {
  const idempotencyKey = req.headers.get('idempotency-key');
  if (!idempotencyKey || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
    return NextResponse.json(
      { error: 'Idempotency-Key header is required and must be a UUID' },
      { status: 400 },
    );
  }

  let parsed;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (err: any) {
    return NextResponse.json({ error: 'Invalid request body', details: err?.errors ?? String(err) },
                             { status: 400 });
  }

  const seqs = parsed.images.map((i) => i.sequenceNo);
  if (new Set(seqs).size !== seqs.length) {
    return NextResponse.json({ error: 'Duplicate sequenceNo in images' }, { status: 400 });
  }

  await ensurePromptVersionRegistered();

  try {
    const out = await createInspection({ ...parsed, idempotencyKey });
    return NextResponse.json(
      { inspectionId: out.inspectionId, uploads: out.uploads,
        partSize: config.policy.partSizeBytes },
      { status: out.created ? 201 : 200 },   // 200 on idempotent replay
    );
  } catch (err: any) {
    console.error('[POST /inspections]', err);
    return NextResponse.json({ error: err?.message ?? 'Internal error' },
                             { status: err?.statusCode ?? 500 });
  }
}
