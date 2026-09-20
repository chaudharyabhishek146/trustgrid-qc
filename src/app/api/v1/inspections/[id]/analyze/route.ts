import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { enqueueAnalysis } from '@/lib/services/queue';
import { ensurePromptVersionRegistered } from '@/lib/services/prompt';

export const runtime = 'nodejs';

/**
 * POST /api/v1/inspections/:id/analyze — force a re-analysis.
 *
 * This is how a prompt or model change gets A/B tested against history: it
 * creates a NEW ai_analyses row rather than editing the old one, so the
 * previous verdict stays intact and both remain attributable.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await ensurePromptVersionRegistered();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insp = await client.query(`SELECT id FROM inspections WHERE id=$1`, [id]);
    if (insp.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    await client.query(`UPDATE inspections SET status='ready' WHERE id=$1`, [id]);
    await enqueueAnalysis(client, id);
    await client.query('COMMIT');
    return NextResponse.json({ status: 'queued' }, { status: 202 });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return NextResponse.json({ error: err?.message ?? 'Internal error' }, { status: 500 });
  } finally {
    client.release();
  }
}
