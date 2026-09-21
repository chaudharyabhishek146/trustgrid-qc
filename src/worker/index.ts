/**
 * Analysis worker — the second runtime of the modular monolith.
 *
 * Same repo, same domain code, same migrations as the web app; a separate
 * process so that a 30-second Gemini call never competes with serving the
 * inspector's poll request. Scale it independently:
 *     npm run worker:prod   (run N of these)
 *
 * Everything the inspector experiences is already decoupled from this process.
 * If it is down, inspections queue up and drain when it returns — nothing is
 * lost (requirement N8).
 */
try { process.loadEnvFile?.('.env'); } catch { /* .env is optional */ }

import { randomUUID } from 'node:crypto';
import { pool } from '../lib/db';
import { config } from '../lib/config';
import { claimJob, completeJob, failJob, reapStaleJobs } from '../lib/services/queue';
import { runAnalysis, markInspectionFailed } from '../lib/services/inspections';
import { storage } from '../lib/services/storage';
import { ensurePromptVersionRegistered } from '../lib/services/prompt';

const WORKER_ID = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Circuit breaker. After N consecutive failures — which in practice means
 * Gemini is down, not that one image is bad — stop hammering a dead dependency
 * and let jobs accumulate. The queue IS the buffer; nothing is dropped.
 */
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30_000;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

let running = true;

async function tick(): Promise<boolean> {
  if (Date.now() < breakerOpenUntil) return false;

  const job = await claimJob(WORKER_ID);
  if (!job) return false;

  const started = Date.now();
  console.log(`[${WORKER_ID}] claimed job ${job.id} inspection=${job.inspection_id} attempt=${job.attempts}`);

  try {
    const out = await runAnalysis(job.inspection_id);
    await completeJob(job.id);
    consecutiveFailures = 0;
    console.log(`[${WORKER_ID}] ✓ job ${job.id} -> ${out.status} in ${Date.now() - started}ms`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    consecutiveFailures++;

    // Consecutive failures mean the dependency is down, not that this job is
    // bad — so requeue it without spending an attempt (QA-D5).
    const dependencyDown = consecutiveFailures >= BREAKER_THRESHOLD;
    const { willRetry } = await failJob(job, msg, { preserveBudget: dependencyDown });

    if (!willRetry) {
      // Only now is 'failed' a state the client can trust as terminal (QA-D1).
      await markInspectionFailed(job.inspection_id);
    }

    console.error(
      `[${WORKER_ID}] ✗ job ${job.id} failed (${msg.slice(0, 200)}) — ` +
      `${willRetry ? 'will retry with backoff' : 'exhausted, parked as failed'}`,
    );

    if (dependencyDown) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      // NOTE: consecutiveFailures is deliberately NOT reset here. It is reset
      // only by a SUCCESS. Resetting it on open made the breaker forget it was
      // degraded, so after each cooldown the job burned one more attempt and
      // still exhausted its budget during a sustained outage (QA-D5).
      console.error(
        `[${WORKER_ID}] ⚡ circuit breaker OPEN for ${BREAKER_COOLDOWN_MS / 1000}s ` +
        `(${consecutiveFailures} consecutive failures) — dependency looks down. ` +
        `Jobs requeue without consuming their retry budget.`,
      );
    }
  }
  return true;
}

async function main() {
  console.log(`[${WORKER_ID}] starting`);
  console.log(`[${WORKER_ID}] gemini=${config.gemini.mock ? 'MOCK' : config.gemini.model} ` +
              `storage=${config.storage.backend} prompt=${config.gemini.promptVersion}`);

  await ensurePromptVersionRegistered();

  let sinceReap = 0;
  while (running) {
    let didWork = false;
    try {
      didWork = await tick();

      // Requeue jobs whose worker died mid-flight, and reclaim upload sessions
      // that were abandoned before completion (QA-E1: without this, interrupted
      // uploads accumulate on disk forever).
      if (++sinceReap > 60) {
        sinceReap = 0;
        const reaped = await reapStaleJobs(300);
        if (reaped > 0) console.log(`[${WORKER_ID}] reaped ${reaped} stale job(s)`);
        const swept = await storage.cleanupStaleUploads(24 * 60 * 60 * 1000);
        if (swept > 0) console.log(`[${WORKER_ID}] swept ${swept} abandoned upload session(s)`);
      }
    } catch (err) {
      console.error(`[${WORKER_ID}] loop error`, err);
      await sleep(2000);
    }
    // Poll only when idle; drain back-to-back when there is work.
    if (!didWork) await sleep(config.worker.pollMs);
  }
}

// Graceful shutdown: finish the in-flight job rather than abandoning it.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[${WORKER_ID}] ${sig} received, draining…`);
    running = false;
    setTimeout(() => pool.end().then(() => process.exit(0)), 500);
  });
}

main().catch((err) => {
  console.error('worker crashed', err);
  process.exit(1);
});
