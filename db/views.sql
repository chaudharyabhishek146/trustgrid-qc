-- ════════════════════════════════════════════════════════════════════════════
--  Calibration views — the reason the schema is shaped the way it is.
--
--  The brief asked for "a field for delayed physical lab results (which we use
--  for later model calibration)". That is an MLOps question wearing a schema
--  question's clothes. These views are the payoff.
-- ════════════════════════════════════════════════════════════════════════════

-- Every (AI prediction, lab truth) pair, with the delta precomputed.
CREATE OR REPLACE VIEW v_calibration_pairs AS
SELECT  i.id                              AS inspection_id,
        i.supplier_id,
        s.code                            AS supplier_code,
        i.site_id,
        i.captured_at,
        a.prompt_version,
        a.model_name,
        a.confidence,
        a.moisture_pct                    AS ai_moisture,
        l.moisture_pct                    AS lab_moisture,
        (a.moisture_pct - l.moisture_pct) AS moisture_delta,
        a.ash_pct                         AS ai_ash,
        l.ash_pct                         AS lab_ash,
        (a.ash_pct - l.ash_pct)           AS ash_delta,
        (l.received_at - i.captured_at)   AS lab_turnaround
FROM        inspections i
JOIN        suppliers   s ON s.id = i.supplier_id
JOIN        ai_analyses a ON a.inspection_id = i.id
                         AND a.is_current
                         AND a.status = 'succeeded'
JOIN        lab_results l ON l.inspection_id = i.id
                         AND l.is_authoritative;

-- Per-version accuracy. Answers the only question that matters after a prompt
-- change: did it actually help, or did the biomass just change with the season?
CREATE OR REPLACE VIEW v_model_accuracy AS
SELECT  prompt_version,
        model_name,
        COUNT(*)                                        AS n,
        ROUND(AVG(moisture_delta), 3)                   AS moisture_bias,
        ROUND(AVG(ABS(moisture_delta)), 3)              AS moisture_mae,
        ROUND(STDDEV_POP(moisture_delta), 3)            AS moisture_sd,
        ROUND(AVG(ABS(ash_delta)), 3)                   AS ash_mae,
        CORR(ai_moisture::float8, lab_moisture::float8) AS moisture_corr
FROM    v_calibration_pairs
GROUP BY prompt_version, model_name;
-- NOTE: production adds HAVING COUNT(*) >= 20. Omitted here so the seeded
-- demo dataset produces visible output.

-- Operational view: what is stuck, and for how long.
CREATE OR REPLACE VIEW v_pipeline_health AS
SELECT  i.status,
        COUNT(*)                                          AS n,
        ROUND(AVG(EXTRACT(EPOCH FROM (now() - i.created_at)))::numeric, 1)
                                                          AS avg_age_seconds,
        ROUND(AVG(EXTRACT(EPOCH FROM (i.created_at - i.captured_at)))::numeric, 1)
                                                          AS avg_offline_gap_seconds
FROM    inspections i
GROUP BY i.status;
