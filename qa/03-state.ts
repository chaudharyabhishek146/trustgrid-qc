/** QA-C: state machine, idempotency, concurrency and DB invariants. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BASE, makeImages, createInspection, uploadAll, complete,
         waitForVerdict, sleep, check, finding, summary } from './lib';

/** Direct SQL, so invariants are checked in the database, not via the API. */
function sql(q: string): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'trustgrid', '-tAc', q], { encoding: 'utf8' }).trim();
}

async function readyInspection(n = 2) {
  const images = makeImages(n);
  const c = await createInspection(images);
  const done = await uploadAll(c.body.uploads, images);
  await complete(c.body.inspectionId, done);
  return c.body.inspectionId as string;
}

async function main() {
  console.log('\n═══ QA-C: STATE MACHINE & CONCURRENCY ═══\n');

  // C1 — not-found handling across every route.
  console.log('C1. Unknown / malformed identifiers');
  {
    const ghost = randomUUID();
    check('C1a', 'GET unknown inspection → 404',
          (await fetch(`${BASE}/api/v1/inspections/${ghost}`)).status === 404);
    check('C1b', 'GET malformed id → 400',
          (await fetch(`${BASE}/api/v1/inspections/not-a-uuid`)).status === 400);
    const comp = await fetch(`${BASE}/api/v1/inspections/${ghost}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: [{ imageId: randomUUID(), parts: [{ partNumber: 1, etag: 'x' }] }] }),
    });
    check('C1c', 'complete unknown inspection → 404', comp.status === 404, `got ${comp.status}`);
    const anal = await fetch(`${BASE}/api/v1/inspections/${ghost}/analyze`, { method: 'POST' });
    check('C1d', 'analyze unknown inspection → 404', anal.status === 404, `got ${anal.status}`);
    const lab = await fetch(`${BASE}/api/v1/lab-results`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inspectionId: ghost, sampleId: 'S1', labName: 'L' }),
    });
    check('C1e', 'lab result for unknown inspection → 404', lab.status === 404, `got ${lab.status}`);
  }

  // C2 — repeated /complete must be a no-op.
  console.log('\nC2. Repeated /complete');
  {
    const id = await readyInspection(2);
    const again = await fetch(`${BASE}/api/v1/inspections/${id}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: [{ imageId: randomUUID(), parts: [{ partNumber: 1, etag: 'x' }] }] }),
    });
    check('C2a', 'replayed complete returns 200, not 202', again.status === 200, `got ${again.status}`);
    const jobs = sql(`SELECT COUNT(*) FROM analysis_jobs WHERE inspection_id='${id}'`);
    check('C2b', 'no duplicate job enqueued', Number(jobs) === 1, `${jobs} job(s)`);
  }

  // C3 — concurrent /complete storm.
  console.log('\nC3. 5 concurrent /complete calls');
  {
    const images = makeImages(2);
    const c = await createInspection(images);
    const done = await uploadAll(c.body.uploads, images);
    const id = c.body.inspectionId;
    const results = await Promise.all(Array.from({ length: 5 }, () => complete(id, done)));
    const jobs = sql(`SELECT COUNT(*) FROM analysis_jobs WHERE inspection_id='${id}'`);
    check('C3a', 'exactly one job despite 5 concurrent completes', Number(jobs) === 1, `${jobs} job(s)`);
    check('C3b', 'no 5xx among concurrent completes',
          results.every((r) => r.status < 500), results.map((r) => r.status).join(','));
  }

  // C4 — re-analysis must append, never overwrite.
  console.log('\nC4. Re-analysis is append-only');
  {
    const id = await readyInspection(2);
    await waitForVerdict(id);
    const before = Number(sql(`SELECT COUNT(*) FROM ai_analyses WHERE inspection_id='${id}'`));

    const re = await fetch(`${BASE}/api/v1/inspections/${id}/analyze`, { method: 'POST' });
    check('C4a', 're-analyze accepted → 202', re.status === 202, `got ${re.status}`);
    await waitForVerdict(id);
    await sleep(1500);

    const after = Number(sql(`SELECT COUNT(*) FROM ai_analyses WHERE inspection_id='${id}'`));
    check('C4b', 'a NEW analysis row was appended', after === before + 1, `${before} → ${after}`);
    const current = Number(sql(
      `SELECT COUNT(*) FROM ai_analyses WHERE inspection_id='${id}' AND is_current`));
    check('C4c', 'exactly one is_current row survives', current === 1, `${current} current`);
    const attempts = sql(
      `SELECT string_agg(attempt_no::text, ',' ORDER BY attempt_no) FROM ai_analyses WHERE inspection_id='${id}'`);
    check('C4d', 'attempt numbers increment', attempts === '1,2', attempts);
  }

  // C5 — concurrent re-analysis requests.
  console.log('\nC5. 5 concurrent re-analyze requests');
  {
    const id = await readyInspection(2);
    await waitForVerdict(id);
    const before = Number(sql(`SELECT COUNT(*) FROM ai_analyses WHERE inspection_id='${id}'`));
    const res = await Promise.all(Array.from({ length: 5 }, () =>
      fetch(`${BASE}/api/v1/inspections/${id}/analyze`, { method: 'POST' })));
    await sleep(4000);
    const jobsLive = Number(sql(
      `SELECT COUNT(*) FROM analysis_jobs WHERE inspection_id='${id}' AND status IN ('queued','running')`));
    const after = Number(sql(`SELECT COUNT(*) FROM ai_analyses WHERE inspection_id='${id}'`));
    check('C5a', 'no 5xx among concurrent analyze calls',
          res.every((r) => r.status < 500), res.map((r) => r.status).join(','));
    check('C5b', 'at most one live job', jobsLive <= 1, `${jobsLive} live`);
    check('C5c', 'at most one extra analysis produced', after <= before + 1, `${before} → ${after}`);
    if (res.every((r) => r.status === 202) && after === before) {
      finding({ id: 'C5', severity: 'MEDIUM',
        title: 'Duplicate /analyze returns 202 while silently doing nothing',
        detail: `All 5 concurrent re-analyze calls returned 202 Accepted, but uq_job_active means ` +
                `only one job can exist, so the rest were dropped by ON CONFLICT DO NOTHING. ` +
                `The caller is told the work was accepted when it was not queued. It should ` +
                `return 409 Conflict (or the existing job id) instead.` });
    }
  }

  // C6 — lab result idempotency.
  console.log('\nC6. Lab result idempotency');
  {
    const id = await readyInspection(2);
    await waitForVerdict(id);
    const body = { inspectionId: id, sampleId: 'SMP-DUP', moisturePct: 11.1,
                   ashPct: 4.2, labName: 'Central Lab' };
    const post = () => fetch(`${BASE}/api/v1/lab-results`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    await post();
    const second = await post();
    const rows = Number(sql(`SELECT COUNT(*) FROM lab_results WHERE inspection_id='${id}'`));
    check('C6a', 'duplicate sample_id upserts, does not duplicate', rows === 1, `${rows} row(s)`);
    check('C6b', 'second POST does not 5xx', second.status < 500, `got ${second.status}`);

    const pairs = Number(sql(`SELECT COUNT(*) FROM v_calibration_pairs WHERE inspection_id='${id}'`));
    check('C6c', 'calibration pair produced exactly once', pairs === 1, `${pairs} pair(s)`);
  }

  // C7 — whole-database invariants.
  console.log('\nC7. Database invariants across every inspection so far');
  {
    const multiCurrent = sql(
      `SELECT COUNT(*) FROM (SELECT inspection_id FROM ai_analyses WHERE is_current
         GROUP BY inspection_id HAVING COUNT(*) > 1) x`);
    check('C7a', 'no inspection has two current analyses', Number(multiCurrent) === 0, `${multiCurrent}`);

    const orphanImages = sql(
      `SELECT COUNT(*) FROM inspection_images i
        LEFT JOIN inspections n ON n.id = i.inspection_id WHERE n.id IS NULL`);
    check('C7b', 'no orphaned image rows', Number(orphanImages) === 0, `${orphanImages}`);

    const badRange = sql(
      `SELECT COUNT(*) FROM ai_analyses
        WHERE moisture_pct < 0 OR moisture_pct > 100 OR ash_pct < 0 OR ash_pct > 100`);
    check('C7c', 'no out-of-range stored metrics', Number(badRange) === 0, `${badRange}`);

    const unversioned = sql(
      `SELECT COUNT(*) FROM ai_analyses WHERE prompt_version IS NULL OR model_name IS NULL`);
    check('C7d', 'every analysis carries prompt + model provenance',
          Number(unversioned) === 0, `${unversioned}`);

    const completedNoAnalysis = sql(
      `SELECT COUNT(*) FROM inspections i WHERE i.status IN ('completed','needs_review')
         AND NOT EXISTS (SELECT 1 FROM ai_analyses a WHERE a.inspection_id = i.id AND a.is_current)`);
    check('C7e', 'no inspection is completed without a current analysis',
          Number(completedNoAnalysis) === 0, `${completedNoAnalysis}`);

    const readyNoJob = sql(
      `SELECT COUNT(*) FROM inspections i WHERE i.status = 'ready'
         AND NOT EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.inspection_id = i.id)`);
    check('C7f', 'no inspection is ready without a job (transactional enqueue)',
          Number(readyNoJob) === 0, `${readyNoJob}`);
  }

  process.exit(summary('QA-C') > 0 ? 1 : 0);
}
main().catch((e) => { console.error('suite crashed:', e); process.exit(2); });
