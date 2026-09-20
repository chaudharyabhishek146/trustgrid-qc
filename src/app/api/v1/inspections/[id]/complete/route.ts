import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { completeInspection } from '@/lib/services/inspections';

export const runtime = 'nodejs';

const bodySchema = z.object({
  images: z.array(z.object({
    imageId: z.string().uuid(),
    parts: z.array(z.object({
      partNumber: z.number().int().positive(),
      etag: z.string().min(1).max(256),
    })).min(1),
  })).min(1),
});

/**
 * POST /api/v1/inspections/:id/complete
 *
 * Finalises the multipart uploads, verifies the objects, flips the inspection
 * to `ready` and enqueues analysis — status change and enqueue in ONE
 * transaction. Returns 202: the verdict is not ready yet, and the inspector is
 * not waiting for it.
 *
 * Idempotent: a replay on an already-ready inspection returns its state.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err: any) {
    return NextResponse.json({ error: 'Invalid body', details: err?.errors ?? String(err) },
                             { status: 400 });
  }

  try {
    const out = await completeInspection(id, body.images);
    return NextResponse.json(out, { status: out.enqueued ? 202 : 200 });
  } catch (err: any) {
    console.error('[POST /complete]', err);
    return NextResponse.json({ error: err?.message ?? 'Internal error' },
                             { status: err?.statusCode ?? 500 });
  }
}
