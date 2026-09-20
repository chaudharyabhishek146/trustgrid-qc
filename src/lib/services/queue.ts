import { query, one } from '../db';
import { config } from '../config';
import type { PoolClient } from 'pg';

/**
 * Queue seam (ARCHITECTURE.md §4.1 decision 5).
 *
 * Postgres `SELECT ... FOR UPDATE SKIP LOCKED` rather than Redis/SQS/Kafka:
 *  - one less system for a two-person team to run and monitor
 *  - the enqueue is TRANSACTIONAL with the write that triggers it, so an
 *    inspection can never be marked ready without its job existing
 *  - swapped for SQS behind this interface at roughly 50 jobs/s
 */
export interface Job {
  id: string;
  inspection_id: string;
  attempts: number;
  max_attempts: number;
}

/** Enqueue inside the caller's transaction. ON CONFLICT DO NOTHING against
 *  uq_job_active means a duplicate /complete cannot double-enqueue. */
export async function enqueueAnalysis(client: PoolClient, inspectionId: string): Promise<void> {
  await client.query(
    `INSERT INTO analysis_jobs (inspection_id) VALUES ($1)
     ON CONFLICT DO NOTHING`,
    [inspectionId],
  );
}

/**
 * Claim one job atomically. SKIP LOCKED lets N workers poll the same table
 * without blocking each other — worker concurrency becomes the global Gemini
 * rate limit, which is exactly the knob you want during a 429 storm.
 */
export async function claimJob(workerId: string): Promise<Job | null> {
  return one<Job>(
    `UPDATE analysis_jobs j
        SET status = 'running',
            attempts = j.attempts + 1,
            locked_at = now(),
            locked_by = $1,
            updated_at = now()
      WHERE j.id = (
        SELECT id FROM analysis_jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
    RETURNING j.id, j.inspection_id, j.attempts, j.max_attempts`,
    [workerId],
  );
}

export async function completeJob(jobId: string): Promise<void> {
  await query(
    `UPDATE analysis_jobs SET status='done', updated_at=now() WHERE id=$1`, [jobId],
  );
}

/**
 * Fail a job. Retries go back to 'queued' with a jittered backoff in
 * run_after; exhausted retries are parked as 'failed' for inspection — the
 * inspection itself is never lost, which is requirement N8.
 */
export async function failJob(
  job: Job, error: string, opts: { preserveBudget?: boolean } = {},
): Promise<{ willRetry: boolean }> {
  // A whole-dependency outage is not the job's fault. When the circuit breaker
  // is open we requeue WITHOUT consuming an attempt, so a long Gemini outage
  // cannot permanently park otherwise-valid inspections as failed (QA-D5).
  if (opts.preserveBudget) {
    const delaySec = 30 * (0.5 + Math.random());
    await query(
      `UPDATE analysis_jobs
          SET status='queued', attempts = GREATEST(attempts - 1, 0), last_error=$2,
              run_after = now() + ($3 || ' seconds')::interval,
              locked_at=NULL, locked_by=NULL, updated_at=now()
        WHERE id=$1`,
      [job.id, error.slice(0, 2000), delaySec.toFixed(1)],
    );
    return { willRetry: true };
  }

  const willRetry = job.attempts < job.max_attempts;
  if (willRetry) {
    const delaySec = Math.min(2 ** job.attempts, 300) * (0.5 + Math.random());
    await query(
      `UPDATE analysis_jobs
          SET status='queued', last_error=$2,
              run_after = now() + ($3 || ' seconds')::interval,
              locked_at=NULL, locked_by=NULL, updated_at=now()
        WHERE id=$1`,
      [job.id, error.slice(0, 2000), delaySec.toFixed(1)],
    );
  } else {
    await query(
      `UPDATE analysis_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`,
      [job.id, error.slice(0, 2000)],
    );
  }
  return { willRetry };
}

/** Requeue jobs whose worker died mid-flight (locked but never completed). */
export async function reapStaleJobs(staleAfterSeconds = 300): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE analysis_jobs
        SET status='queued', locked_at=NULL, locked_by=NULL, updated_at=now()
      WHERE status='running' AND locked_at < now() - ($1 || ' seconds')::interval
    RETURNING id`,
    [String(staleAfterSeconds)],
  );
  return rows.length;
}

export const workerConfig = config.worker;
