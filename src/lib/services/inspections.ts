import { randomUUID } from 'node:crypto';
import { query, one, tx } from '../db';
import { config } from '../config';
import { storage, buildStorageKey } from './storage';
import { enqueueAnalysis } from './queue';
import { analyseImages, estimateCostUsd, type ImageInput } from './gemini';
import { assessPlausibility } from '../domain/validation';
import type { CompletedPart, UploadTarget } from '../domain/types';

export interface ImageDeclaration {
  sequenceNo: number;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  originalSizeBytes?: number;
  widthPx?: number;
  heightPx?: number;
  angleHint?: string;
}

export interface CreateInspectionInput {
  idempotencyKey: string;
  siteId: string;
  supplierId: string;
  inspectorId: string;
  vehicleNo: string;
  weighbridgeTicket?: string;
  grossWeightKg?: number;
  tareWeightKg?: number;
  capturedAt: string;
  deviceId?: string;
  appVersion?: string;
  images: ImageDeclaration[];
}

/** Split a blob into S3-compatible parts. Most compressed images are a single
 *  part; the machinery matters on slow links and for full-res originals. */
function planParts(sizeBytes: number) {
  const size = config.policy.partSizeBytes;
  const count = Math.max(1, Math.ceil(sizeBytes / size));
  return Array.from({ length: count }, (_, i) => ({
    partNumber: i + 1,
    rangeStart: i * size,
    rangeEnd: Math.min((i + 1) * size, sizeBytes),
  }));
}

/**
 * Create an inspection and mint upload sessions.
 *
 * IDEMPOTENT by client-supplied key. A retry after a response that was sent
 * but never received returns the SAME inspection_id with FRESH part URLs — so
 * a reconnecting client resumes rather than duplicating. In a system that
 * settles supplier payments, duplicate records are worse than lost ones.
 */
export async function createInspection(
  input: CreateInspectionInput,
): Promise<{ inspectionId: string; created: boolean; uploads: UploadTarget[] }> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM inspections WHERE idempotency_key = $1`, [input.idempotencyKey],
  );

  if (existing) {
    return { inspectionId: existing.id, created: false,
             uploads: await mintUploadTargets(existing.id) };
  }

  const { id: inspectionId, created } = await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO inspections
         (idempotency_key, site_id, supplier_id, inspector_id, vehicle_no,
          weighbridge_ticket, gross_weight_kg, tare_weight_kg, captured_at,
          device_id, app_version, expected_image_count, status, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_upload',$13)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.idempotencyKey, input.siteId, input.supplierId, input.inspectorId,
       input.vehicleNo, input.weighbridgeTicket ?? null,
       input.grossWeightKg ?? null, input.tareWeightKg ?? null,
       input.capturedAt, input.deviceId ?? null, input.appVersion ?? null,
       input.images.length, randomUUID()],
    );

    // Lost an idempotency race with a concurrent retry — adopt the winner and
    // report created=false, so only ONE of N racing requests ever sees a 201.
    if (ins.rowCount === 0) {
      const row = await c.query(`SELECT id FROM inspections WHERE idempotency_key=$1`,
                                [input.idempotencyKey]);
      return { id: row.rows[0].id as string, created: false };
    }

    const id = ins.rows[0].id as string;
    for (const img of input.images) {
      const key = buildStorageKey(id, img.sequenceNo);
      await c.query(
        `INSERT INTO inspection_images
           (inspection_id, sequence_no, angle_hint, storage_bucket, storage_key,
            content_type, size_bytes, sha256, width_px, height_px, original_size_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, img.sequenceNo, img.angleHint ?? null, storage.bucket, key,
         img.contentType, img.sizeBytes, img.sha256,
         img.widthPx ?? null, img.heightPx ?? null, img.originalSizeBytes ?? null],
      );
    }
    return { id, created: true };
  });

  return { inspectionId, created, uploads: await mintUploadTargets(inspectionId) };
}

/**
 * Mint (or re-mint) part upload URLs for images that are not yet uploaded.
 * Called on create AND on every resume — URLs are deliberately short-lived, so
 * re-minting is the normal path after a long offline gap.
 */
export async function mintUploadTargets(inspectionId: string): Promise<UploadTarget[]> {
  const images = await query<any>(
    `SELECT id, sequence_no, storage_key, content_type, size_bytes, upload_id, uploaded_at
       FROM inspection_images
      WHERE inspection_id = $1
      ORDER BY sequence_no`,
    [inspectionId],
  );

  const targets: UploadTarget[] = [];
  for (const img of images) {
    if (img.uploaded_at) continue;               // already durable; nothing to resume

    let uploadId: string = img.upload_id;
    if (!uploadId) {
      uploadId = await storage.createMultipartUpload(img.storage_key, img.content_type);
      await query(`UPDATE inspection_images SET upload_id=$2 WHERE id=$1`, [img.id, uploadId]);
    }

    // Ask storage what already landed, and mint URLs ONLY for what is missing.
    // A drop at part 3 of 5 therefore resumes at part 3: parts 1-2 are already
    // durable and are never re-sent, even by a client that lost its own state.
    const alreadyUploaded = await storage.listParts(img.storage_key, uploadId);
    const have = new Set(alreadyUploaded.map((p) => p.partNumber));

    const outstanding = planParts(Number(img.size_bytes)).filter((p) => !have.has(p.partNumber));
    const parts = await Promise.all(outstanding.map(async (p) => ({
      ...p,
      url: await storage.presignPart(
        img.storage_key, uploadId, p.partNumber, p.rangeEnd - p.rangeStart),
    })));

    targets.push({
      imageId: img.id,
      sequenceNo: img.sequence_no,
      uploadId,
      storageKey: img.storage_key,
      partSize: config.policy.partSizeBytes,
      parts,
      uploadedParts: alreadyUploaded,
    });
  }
  return targets;
}

/**
 * Finalise uploads and enqueue analysis. Idempotent: calling it twice on an
 * already-ready inspection is a no-op that returns the same state.
 */
export async function completeInspection(
  inspectionId: string,
  images: { imageId: string; parts: CompletedPart[] }[],
): Promise<{ status: string; enqueued: boolean }> {
  const insp = await one<any>(`SELECT id, status, expected_image_count FROM inspections WHERE id=$1`,
                              [inspectionId]);
  if (!insp) throw Object.assign(new Error('Inspection not found'), { statusCode: 404 });

  if (['ready', 'processing', 'completed', 'needs_review'].includes(insp.status)) {
    return { status: insp.status, enqueued: false };   // idempotent replay
  }

  for (const entry of images) {
    const img = await one<any>(
      `SELECT id, storage_key, upload_id, sha256, uploaded_at
         FROM inspection_images WHERE id=$1 AND inspection_id=$2`,
      [entry.imageId, inspectionId],
    );
    if (!img || img.uploaded_at) continue;

    const { sizeBytes } = await storage.completeMultipartUpload(
      img.storage_key, img.upload_id, entry.parts,
    );

    // Integrity gate: a corrupted or truncated upload must be detected HERE,
    // never silently analysed. The client declares a SHA-256 at create time and
    // the assembled object is hashed and compared (QA-A1).
    if (sizeBytes <= 0) {
      throw Object.assign(new Error('Uploaded object is empty'), { statusCode: 422 });
    }
    const actualSha = await storage.objectSha256(img.storage_key);
    if (actualSha !== null && actualSha !== img.sha256) {
      // Do not leave a half-good object behind for a later retry to adopt.
      await storage.abortMultipartUpload(img.storage_key, img.upload_id).catch(() => {});
      throw Object.assign(
        new Error(
          `Integrity check failed for image ${img.id}: declared sha256 ${img.sha256.slice(0, 12)}…, ` +
          `stored object hashes to ${actualSha.slice(0, 12)}…`),
        { statusCode: 422 });
    }

    await query(
      `UPDATE inspection_images SET uploaded_at=now(), size_bytes=$2 WHERE id=$1`,
      [img.id, sizeBytes],
    );
  }

  const [{ n }] = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM inspection_images
      WHERE inspection_id=$1 AND uploaded_at IS NOT NULL`,
    [inspectionId],
  );

  if (Number(n) < insp.expected_image_count) {
    await query(`UPDATE inspections SET status='uploading' WHERE id=$1`, [inspectionId]);
    return { status: 'uploading', enqueued: false };
  }

  // Status flip and enqueue are in ONE transaction: an inspection can never be
  // marked ready without its analysis job existing.
  await tx(async (c) => {
    await c.query(`UPDATE inspections SET status='ready' WHERE id=$1`, [inspectionId]);
    await enqueueAnalysis(c, inspectionId);
  });

  return { status: 'ready', enqueued: true };
}

/** Recent lab-verified moisture stats, used by the plausibility gate. */
async function supplierHistory(supplierId: string) {
  const row = await one<any>(
    `SELECT AVG(l.moisture_pct)::float8 AS mean,
            COALESCE(STDDEV_POP(l.moisture_pct), 0)::float8 AS sd,
            COUNT(*)::int AS n
       FROM lab_results l
       JOIN inspections i ON i.id = l.inspection_id
      WHERE i.supplier_id = $1
        AND l.is_authoritative
        AND l.received_at > now() - interval '90 days'`,
    [supplierId],
  );
  if (!row || !row.n || row.n < 10) return undefined;
  return { meanMoisture: row.mean, sdMoisture: row.sd, n: row.n };
}

/**
 * Run inference for one inspection and persist the verdict.
 *
 * APPEND-ONLY: never UPDATEs a previous analysis. A re-run demotes the old row
 * (is_current = false) and inserts a new one, so the full history of what was
 * predicted, by which model, under which prompt, survives forever.
 */
export async function runAnalysis(inspectionId: string): Promise<{ status: string }> {
  await query(`UPDATE inspections SET status='processing' WHERE id=$1`, [inspectionId]);

  const insp = await one<any>(`SELECT id, supplier_id, trace_id FROM inspections WHERE id=$1`,
                              [inspectionId]);
  if (!insp) throw new Error(`Inspection ${inspectionId} not found`);

  const images = await query<any>(
    `SELECT id, storage_key, content_type FROM inspection_images
      WHERE inspection_id=$1 AND uploaded_at IS NOT NULL ORDER BY sequence_no`,
    [inspectionId],
  );
  if (images.length === 0) throw new Error('No uploaded images to analyse');

  const inputs: ImageInput[] = await Promise.all(images.map(async (img: any) => ({
    id: img.id,
    bytes: await storage.getObject(img.storage_key),
    contentType: img.content_type,
  })));

  const result = await analyseImages(inputs);

  const [{ next }] = await query<{ next: number }>(
    `SELECT COALESCE(MAX(attempt_no),0)+1 AS next FROM ai_analyses
      WHERE inspection_id=$1 AND prompt_version=$2 AND model_name=$3`,
    [inspectionId, config.gemini.promptVersion, config.gemini.model],
  );

  const imageIds = images.map((i: any) => i.id);
  const common = {
    inspectionId, promptVersion: config.gemini.promptVersion,
    model: config.gemini.model, temperature: config.gemini.temperature,
    imageIds, attemptNo: next, traceId: insp.trace_id,
  };

  if (!result.ok) {
    // Record the attempt for forensics, but DO NOT mark the inspection failed
    // and DO NOT let a failed attempt become the current verdict:
    //  - the job still has retries left, and the client treats 'failed' as
    //    terminal and would stop polling (QA-D1);
    //  - a transient outage must never blank out a verdict already delivered
    //    to the inspector (QA-D2).
    // The worker sets 'failed' only once the retry budget is exhausted.
    await insertAnalysis({ ...common, status: result.kind, raw: result.raw,
      validationErrors: { error: result.error }, latencyMs: result.latencyMs,
      makeCurrent: false });
    throw new Error(result.error);       // let the queue retry with backoff
  }

  const plaus = assessPlausibility(result.output, await supplierHistory(insp.supplier_id));
  const analysisStatus = 'succeeded';
  const inspectionStatus = plaus.needsReview ? 'needs_review' : 'completed';

  await insertAnalysis({
    ...common,
    status: analysisStatus,
    makeCurrent: true,
    output: result.output,
    raw: result.raw,
    validationErrors: plaus.needsReview ? { review_reasons: plaus.reasons } : null,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    modelVersion: result.modelVersion,
  });

  await query(`UPDATE inspections SET status=$2, completed_at=now() WHERE id=$1`,
              [inspectionId, inspectionStatus]);
  return { status: inspectionStatus };
}

async function insertAnalysis(a: any): Promise<void> {
  const makeCurrent = a.makeCurrent !== false;
  await tx(async (c) => {
    // Demote the previous verdict ONLY when this attempt produces a usable one.
    // A failed attempt is still recorded (append-only history) but must not
    // supersede a good verdict (QA-D2).
    if (makeCurrent) {
      await c.query(`UPDATE ai_analyses SET is_current=FALSE
                      WHERE inspection_id=$1 AND is_current`, [a.inspectionId]);
    }
    await c.query(
      `INSERT INTO ai_analyses
         (inspection_id, prompt_version, model_name, model_version, temperature,
          image_ids, status, moisture_pct, ash_pct, foreign_stones, foreign_detail,
          confidence, quality_ok, raw_response, validation_errors,
          latency_ms, input_tokens, output_tokens, cost_usd, attempt_no, trace_id, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [a.inspectionId, a.promptVersion, a.model, a.modelVersion ?? null, a.temperature,
       a.imageIds, a.status,
       a.output?.moisture_pct ?? null, a.output?.ash_pct ?? null,
       a.output?.foreign_stones ?? null, a.output?.foreign_detail ?? null,
       a.output?.confidence ?? null, a.output?.quality_ok ?? null,
       JSON.stringify(a.raw ?? {}),
       a.validationErrors ? JSON.stringify(a.validationErrors) : null,
       a.latencyMs ?? null, a.inputTokens ?? null, a.outputTokens ?? null,
       estimateCostUsd(a.inputTokens, a.outputTokens), a.attemptNo, a.traceId ?? null,
       makeCurrent],
    );
  });
}

/** Full read model for the polling endpoint. */
export async function getInspection(inspectionId: string) {
  const insp = await one<any>(
    `SELECT i.*, s.code AS supplier_code, s.name AS supplier_name
       FROM inspections i JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.id = $1`,
    [inspectionId],
  );
  if (!insp) return null;

  const [images, analysis, lab] = await Promise.all([
    query(`SELECT id, sequence_no, storage_key, size_bytes, original_size_bytes,
                  sha256, uploaded_at
             FROM inspection_images WHERE inspection_id=$1 ORDER BY sequence_no`, [inspectionId]),
    one(`SELECT id, status, moisture_pct, ash_pct, foreign_stones, foreign_detail,
                confidence, quality_ok, prompt_version, model_name, latency_ms,
                input_tokens, output_tokens, cost_usd, validation_errors, created_at
           FROM ai_analyses WHERE inspection_id=$1 AND is_current`, [inspectionId]),
    one(`SELECT sample_id, moisture_pct, ash_pct, gcv_kcal_kg, lab_name, received_at
           FROM lab_results WHERE inspection_id=$1 AND is_authoritative
          ORDER BY received_at DESC LIMIT 1`, [inspectionId]),
  ]);

  return { inspection: insp, images, analysis, labResult: lab };
}


/** Called by the worker only once a job's retry budget is exhausted, so that
 *  'failed' is a genuinely terminal state the client can trust (QA-D1). */
export async function markInspectionFailed(inspectionId: string): Promise<void> {
  // If a previous attempt already produced a usable verdict, restore that state
  // rather than declaring the inspection failed: the inspector still has a
  // valid reading and a later failed re-run must not take it away (QA-D2).
  await query(
    `UPDATE inspections i
        SET status = COALESCE((
              SELECT (CASE WHEN a.validation_errors ? 'review_reasons'
                           THEN 'needs_review' ELSE 'completed' END)::inspection_status
                FROM ai_analyses a
               WHERE a.inspection_id = i.id AND a.is_current AND a.status = 'succeeded'
               LIMIT 1),
            'failed'::inspection_status)
      WHERE i.id = $1`,
    [inspectionId]);
}
