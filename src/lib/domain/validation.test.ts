import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { geminiOutputSchema, assessPlausibility } from './validation';

const valid = {
  moisture_pct: 14.2, ash_pct: 6.1, foreign_stones: false,
  foreign_detail: '', confidence: 0.88, quality_ok: true,
  observations: 'Dry rice husk, evenly loaded.',
};

describe('geminiOutputSchema — the model is not trusted', () => {
  test('accepts a well-formed response', () => {
    assert.equal(geminiOutputSchema.safeParse(valid).success, true);
  });

  test('rejects out-of-range moisture', () => {
    // A hallucinated 150% would otherwise flow into a payment calculation.
    assert.equal(geminiOutputSchema.safeParse({ ...valid, moisture_pct: 150 }).success, false);
  });

  test('rejects a string where a number is required', () => {
    assert.equal(geminiOutputSchema.safeParse({ ...valid, ash_pct: '6.1' }).success, false);
  });

  test('rejects a missing field rather than defaulting it', () => {
    const { confidence, ...missing } = valid;
    assert.equal(geminiOutputSchema.safeParse(missing).success, false);
  });

  test('rejects confidence outside 0..1', () => {
    assert.equal(geminiOutputSchema.safeParse({ ...valid, confidence: 1.4 }).success, false);
  });
});

describe('assessPlausibility — nothing doubtful reaches an invoice', () => {
  test('a confident, good-quality, in-range reading passes', () => {
    assert.equal(assessPlausibility(valid).needsReview, false);
  });

  test('low confidence routes to human review', () => {
    const v = assessPlausibility({ ...valid, confidence: 0.4 });
    assert.equal(v.needsReview, true);
    assert.match(v.reasons.join(), /low confidence/);
  });

  test('model-reported bad image quality routes to human review', () => {
    assert.equal(assessPlausibility({ ...valid, quality_ok: false }).needsReview, true);
  });

  test('physically implausible moisture routes to human review', () => {
    const v = assessPlausibility({ ...valid, moisture_pct: 85 });
    assert.equal(v.needsReview, true);
    assert.match(v.reasons.join(), /plausible band/);
  });

  test('a >3-sigma outlier against supplier history routes to human review', () => {
    const v = assessPlausibility(
      { ...valid, moisture_pct: 40 },
      { meanMoisture: 14, sdMoisture: 2, n: 50 },
    );
    assert.equal(v.needsReview, true);
    assert.match(v.reasons.join(), /σ from this supplier/);
  });

  test('thin supplier history is ignored rather than trusted', () => {
    // n < 10: not enough data for a meaningful sigma, so no false flag.
    const v = assessPlausibility(
      { ...valid, moisture_pct: 40 },
      { meanMoisture: 14, sdMoisture: 2, n: 3 },
    );
    assert.equal(v.reasons.some((r) => r.includes('σ')), false);
  });
});
