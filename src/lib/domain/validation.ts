import { z } from 'zod';
import { config } from '../config';

/**
 * Layer 2 of 3 defences on the model output (see ARCHITECTURE.md §5.4).
 *
 *  1. responseSchema on the Gemini call       — structured output
 *  2. THIS: re-validate server-side           — the model is not trusted
 *  3. Plausibility gate below                 — humans see anything doubtful
 *
 * This matters because moisture % determines what the supplier gets paid.
 * A number that reaches an invoice unchecked is a financial bug.
 */
export const geminiOutputSchema = z.object({
  moisture_pct: z.number().min(0).max(100),
  ash_pct: z.number().min(0).max(100),
  foreign_stones: z.boolean(),
  foreign_detail: z.string().max(2000).default(''),
  confidence: z.number().min(0).max(1),
  quality_ok: z.boolean(),
  observations: z.string().max(4000).default(''),
});

export type GeminiOutput = z.infer<typeof geminiOutputSchema>;

export interface PlausibilityVerdict {
  needsReview: boolean;
  reasons: string[];
}

/**
 * Plausibility gate. Deliberately conservative: when in doubt, a human looks.
 *
 * `supplierHistory` is the recent moisture mean/sd for this supplier. A reading
 * far outside a supplier's own established range is more likely a model error
 * or a bad photo than a genuinely unusual truckload — either way it deserves
 * eyes before it settles money.
 */
export function assessPlausibility(
  out: GeminiOutput,
  supplierHistory?: { meanMoisture: number; sdMoisture: number; n: number },
): PlausibilityVerdict {
  const reasons: string[] = [];

  if (out.confidence < config.policy.reviewConfidenceThreshold) {
    reasons.push(`low confidence (${out.confidence.toFixed(2)} < ${config.policy.reviewConfidenceThreshold})`);
  }
  if (!out.quality_ok) {
    reasons.push('model reported insufficient image quality');
  }
  // Biomass outside this band is physically implausible for a delivered load;
  // treat it as a model error rather than a finding.
  if (out.moisture_pct > 60) {
    reasons.push(`moisture ${out.moisture_pct}% exceeds plausible band for a delivered load`);
  }
  if (out.ash_pct > 40) {
    reasons.push(`ash ${out.ash_pct}% exceeds plausible band`);
  }
  if (supplierHistory && supplierHistory.n >= 10 && supplierHistory.sdMoisture > 0) {
    const z = Math.abs(out.moisture_pct - supplierHistory.meanMoisture) / supplierHistory.sdMoisture;
    if (z > 3) {
      reasons.push(
        `moisture is ${z.toFixed(1)}σ from this supplier's 90-day mean ` +
        `(${supplierHistory.meanMoisture.toFixed(1)}%)`,
      );
    }
  }
  return { needsReview: reasons.length > 0, reasons };
}
