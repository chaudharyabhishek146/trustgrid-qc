import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/v1/calibration/summary
 *
 * The payoff of the whole schema design. Answers: for each prompt+model
 * version, how far is the AI from physical lab truth, and in which direction?
 *
 * A consistent positive `moisture_bias` is directly actionable — apply a
 * correction offset, rewrite the prompt with calibrated examples, or fine-tune.
 * Without prompt_version on every prediction you could not tell an improved
 * prompt from a seasonal change in the biomass.
 */
export async function GET() {
  const [accuracy, pairs] = await Promise.all([
    query(`SELECT * FROM v_model_accuracy ORDER BY n DESC`),
    query(`SELECT inspection_id, supplier_code, prompt_version, confidence,
                  ai_moisture, lab_moisture, moisture_delta, ai_ash, lab_ash, ash_delta
             FROM v_calibration_pairs ORDER BY captured_at DESC LIMIT 50`),
  ]);
  return NextResponse.json({ accuracy, recentPairs: pairs },
                           { headers: { 'cache-control': 'no-store' } });
}
