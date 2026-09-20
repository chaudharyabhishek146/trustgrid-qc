-- ════════════════════════════════════════════════════════════════════════════
--  TrustGrid QC — PostgreSQL schema
--
--  Design principles (see ARCHITECTURE.md §6):
--   1. The inspection is the aggregate root.
--   2. AI analyses are APPEND-ONLY. A verdict is never UPDATEd — re-running
--      inference inserts a new row. Required for calibration validity and for
--      defending a disputed invoice six months later.
--   3. Every prediction records what produced it (model + prompt version).
--      Pooling predictions across prompt versions produces a confidently
--      wrong calibration.
--   4. Hybrid storage: typed/constrained columns for the billable metrics,
--      full raw JSONB for provenance. Index the former, never lose the latter.
--   5. The lab result is a PEER of the AI answer, not an edit of it.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────── Reference data ─────────────────────────────────
CREATE TABLE suppliers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    biomass_types   TEXT[] NOT NULL DEFAULT '{}',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inspectors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id         UUID NOT NULL REFERENCES sites(id),
    name            TEXT NOT NULL,
    employee_code   TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (site_id, employee_code)
);

-- Prompts are first-class data, not a string constant in the codebase.
-- Without this table the calibration numbers cannot be attributed.
CREATE TABLE prompt_versions (
    version         TEXT PRIMARY KEY,
    system_prompt   TEXT NOT NULL,
    response_schema JSONB NOT NULL,
    model_name      TEXT NOT NULL,
    temperature     NUMERIC(3,2) NOT NULL DEFAULT 0.0,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at      TIMESTAMPTZ
);

-- ─────────────────────────── Aggregate root ─────────────────────────────────
CREATE TYPE inspection_status AS ENUM (
    'pending_upload','uploading','ready','processing',
    'completed','needs_review','failed'
);

CREATE TABLE inspections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Client-generated at capture time, reused across every retry.
    -- This is what makes a retry storm on a flaky link safe.
    idempotency_key     UUID NOT NULL UNIQUE,
    site_id             UUID NOT NULL REFERENCES sites(id),
    supplier_id         UUID NOT NULL REFERENCES suppliers(id),
    inspector_id        UUID NOT NULL REFERENCES inspectors(id),

    vehicle_no          TEXT NOT NULL,
    weighbridge_ticket  TEXT,
    gross_weight_kg     NUMERIC(10,2),
    tare_weight_kg      NUMERIC(10,2),
    net_weight_kg       NUMERIC(10,2)
                        GENERATED ALWAYS AS (gross_weight_kg - tare_weight_kg) STORED,

    status              inspection_status NOT NULL DEFAULT 'pending_upload',
    expected_image_count SMALLINT NOT NULL DEFAULT 5,

    -- captured_at vs created_at IS the offline gap, and it is queryable:
    -- you can prove how long a load sat unsynced and spot chronically
    -- offline devices in the fleet.
    captured_at         TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,

    device_id           TEXT,
    app_version         TEXT,
    capture_gps         POINT,
    trace_id            TEXT,

    CONSTRAINT chk_weights CHECK (
        gross_weight_kg IS NULL OR tare_weight_kg IS NULL
        OR gross_weight_kg >= tare_weight_kg)
);

CREATE INDEX idx_insp_supplier_time ON inspections (supplier_id, captured_at DESC);
CREATE INDEX idx_insp_site_time     ON inspections (site_id, captured_at DESC);
CREATE INDEX idx_insp_status        ON inspections (status) WHERE status <> 'completed';
CREATE INDEX idx_insp_vehicle       ON inspections (vehicle_no, captured_at DESC);

-- ─────────────────────────────── Images ─────────────────────────────────────
CREATE TABLE inspection_images (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_id   UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
    sequence_no     SMALLINT NOT NULL CHECK (sequence_no BETWEEN 1 AND 20),
    angle_hint      TEXT,

    storage_bucket  TEXT NOT NULL,
    storage_key     TEXT NOT NULL,
    content_type    TEXT NOT NULL DEFAULT 'image/jpeg',
    size_bytes      BIGINT CHECK (size_bytes > 0),
    sha256          TEXT NOT NULL,
    width_px        INT,
    height_px       INT,
    original_size_bytes BIGINT,          -- pre-compression; proves the 30x win

    upload_id       TEXT,                -- multipart session id
    uploaded_at     TIMESTAMPTZ,
    exif            JSONB NOT NULL DEFAULT '{}'::jsonb,

    UNIQUE (inspection_id, sequence_no),
    UNIQUE (storage_bucket, storage_key)
);
CREATE INDEX idx_img_sha ON inspection_images (sha256);   -- catch re-used photos

-- ──────────────────── AI output (APPEND-ONLY, versioned) ────────────────────
CREATE TYPE analysis_status AS ENUM (
    'succeeded','failed_parse','failed_api','rejected_validation'
);

CREATE TABLE ai_analyses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_id       UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,

    -- Provenance. Without these the calibration dataset is not valid.
    prompt_version      TEXT NOT NULL REFERENCES prompt_versions(version),
    model_name          TEXT NOT NULL,
    model_version       TEXT,
    temperature         NUMERIC(3,2) NOT NULL DEFAULT 0.0,
    image_ids           UUID[] NOT NULL,

    status              analysis_status NOT NULL,

    -- Typed + constrained: these are the numbers that touch money.
    moisture_pct        NUMERIC(5,2) CHECK (moisture_pct BETWEEN 0 AND 100),
    ash_pct             NUMERIC(5,2) CHECK (ash_pct      BETWEEN 0 AND 100),
    foreign_stones      BOOLEAN,
    foreign_detail      TEXT,
    confidence          NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
    quality_ok          BOOLEAN,

    -- Full provenance: everything the model actually said, verbatim.
    raw_response        JSONB NOT NULL,
    validation_errors   JSONB,

    -- Operations & unit economics.
    latency_ms          INT,
    input_tokens        INT,
    output_tokens       INT,
    cost_usd            NUMERIC(10,6),
    attempt_no          SMALLINT NOT NULL DEFAULT 1,
    trace_id            TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_current          BOOLEAN NOT NULL DEFAULT TRUE
);

-- Exactly one "current" analysis per inspection; history preserved forever.
CREATE UNIQUE INDEX uq_current_analysis
    ON ai_analyses (inspection_id) WHERE is_current;

-- A worker retry after a crash cannot double-write.
CREATE UNIQUE INDEX uq_analysis_attempt
    ON ai_analyses (inspection_id, prompt_version, model_name, attempt_no);

CREATE INDEX idx_analysis_raw ON ai_analyses USING GIN (raw_response jsonb_path_ops);
CREATE INDEX idx_analysis_ver ON ai_analyses (prompt_version, model_name, created_at DESC);
CREATE INDEX idx_analysis_review ON ai_analyses (inspection_id)
    WHERE status = 'succeeded' AND (confidence < 0.70 OR quality_ok IS FALSE);

-- ──────────────────────── Delayed physical lab truth ────────────────────────
-- Arrives T+24-72h. A peer of the AI answer, never an overwrite of it.
CREATE TABLE lab_results (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_id       UUID NOT NULL REFERENCES inspections(id) ON DELETE RESTRICT,
    sample_id           TEXT NOT NULL,

    moisture_pct        NUMERIC(5,2) CHECK (moisture_pct BETWEEN 0 AND 100),
    ash_pct             NUMERIC(5,2) CHECK (ash_pct      BETWEEN 0 AND 100),
    gcv_kcal_kg         NUMERIC(8,2),
    foreign_matter_pct  NUMERIC(5,2),

    lab_name            TEXT NOT NULL,
    test_method         TEXT,
    analyst             TEXT,
    sampled_at          TIMESTAMPTZ,
    tested_at           TIMESTAMPTZ,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    source              TEXT NOT NULL DEFAULT 'manual',   -- manual|csv|lims_webhook
    raw_payload         JSONB,
    is_authoritative    BOOLEAN NOT NULL DEFAULT TRUE,    -- FALSE for a superseded re-test

    UNIQUE (inspection_id, sample_id)
);
CREATE INDEX idx_lab_received ON lab_results (received_at DESC);
CREATE INDEX idx_lab_pending  ON lab_results (inspection_id) WHERE is_authoritative;

-- ───────────────────── Human override (audit trail) ─────────────────────────
CREATE TABLE inspection_reviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_id   UUID NOT NULL REFERENCES inspections(id),
    analysis_id     UUID NOT NULL REFERENCES ai_analyses(id),
    reviewer_id     UUID NOT NULL REFERENCES inspectors(id),
    decision        TEXT NOT NULL CHECK (decision IN ('accepted','overridden','rejected')),
    override_moisture_pct NUMERIC(5,2),
    override_ash_pct      NUMERIC(5,2),
    reason          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────── Job queue (Postgres) ────────────────────────────
-- Deliberately NOT Redis/SQS for the MVP: one less system to run, and the
-- enqueue is transactional with the write that triggers it. Swapped behind
-- the JobQueue interface (src/lib/services/queue.ts) when throughput demands.
CREATE TABLE analysis_jobs (
    id              BIGSERIAL PRIMARY KEY,
    inspection_id   UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','done','failed')),
    attempts        SMALLINT NOT NULL DEFAULT 0,
    max_attempts    SMALLINT NOT NULL DEFAULT 5,
    run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),   -- backoff lands here
    locked_at       TIMESTAMPTZ,
    locked_by       TEXT,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_claim ON analysis_jobs (run_after)
    WHERE status IN ('queued','running');
-- One live job per inspection: a duplicate /complete cannot double-enqueue.
CREATE UNIQUE INDEX uq_job_active ON analysis_jobs (inspection_id)
    WHERE status IN ('queued','running');
