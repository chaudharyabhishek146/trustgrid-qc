import { NextRequest, NextResponse } from 'next/server';
import { getInspection } from '@/lib/services/inspections';

export const runtime = 'nodejs';

/** GET /api/v1/inspections/:id — the poll target. Cheap, and safe to hit
 *  every 2s from a phone on a bad link. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const data = await getInspection(id);
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data, { headers: { 'cache-control': 'no-store' } });
}
