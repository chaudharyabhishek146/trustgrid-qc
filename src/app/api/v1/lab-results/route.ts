import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, one } from '@/lib/db';

export const runtime = 'nodejs';

const bodySchema = z.object({
  inspectionId: z.string().uuid(),
  sampleId: z.string().min(1).max(64),
  moisturePct: z.number().min(0).max(100).optional(),
  ashPct: z.number().min(0).max(100).optional(),
  gcvKcalKg: z.number().positive().optional(),
  foreignMatterPct: z.number().min(0).max(100).optional(),
  labName: z.string().min(1).max(120),
  testMethod: z.string().max(64).optional(),
  analyst: z.string().max(120).optional(),
  sampledAt: z.string().datetime().optional(),
  testedAt: z.string().datetime().optional(),
  source: z.enum(['manual', 'csv', 'lims_webhook']).default('manual'),
});

/**
 * POST /api/v1/lab-results — attach the delayed physical lab result.
 *
 * This is the other half of the calibration loop, arriving T+24-72h. It does
 * NOT overwrite the AI verdict: it lands beside it so the delta is computable
 * (see v_calibration_pairs). Idempotent on (inspectionId, sampleId) so a LIMS
 * webhook that retries cannot create duplicate truth rows.
 */
export async function POST(req: NextRequest) {
  let b;
  try {
    b = bodySchema.parse(await req.json());
  } catch (err: any) {
    return NextResponse.json({ error: 'Invalid body', details: err?.errors ?? String(err) },
                             { status: 400 });
  }

  const insp = await one(`SELECT id FROM inspections WHERE id=$1`, [b.inspectionId]);
  if (!insp) return NextResponse.json({ error: 'Inspection not found' }, { status: 404 });

  const rows = await query(
    `INSERT INTO lab_results
       (inspection_id, sample_id, moisture_pct, ash_pct, gcv_kcal_kg, foreign_matter_pct,
        lab_name, test_method, analyst, sampled_at, tested_at, source, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (inspection_id, sample_id) DO UPDATE
       SET moisture_pct = EXCLUDED.moisture_pct,
           ash_pct      = EXCLUDED.ash_pct,
           gcv_kcal_kg  = EXCLUDED.gcv_kcal_kg,
           received_at  = now()
     RETURNING id, inspection_id, sample_id`,
    [b.inspectionId, b.sampleId, b.moisturePct ?? null, b.ashPct ?? null,
     b.gcvKcalKg ?? null, b.foreignMatterPct ?? null, b.labName, b.testMethod ?? null,
     b.analyst ?? null, b.sampledAt ?? null, b.testedAt ?? null, b.source,
     JSON.stringify(b)],
  );

  return NextResponse.json({ labResult: rows[0] }, { status: 201 });
}
