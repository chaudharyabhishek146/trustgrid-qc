/** QA-D helper: drives one phase of the failure-injection scenario.
 *  Orchestrated by qa/run-failure.sh, which starts/stops workers around it. */
import { execFileSync } from 'node:child_process';
import { BASE, makeImages, createInspection, uploadAll, complete, sleep } from './lib';

const sql = (q: string) => execFileSync('docker', ['compose', 'exec', '-T', 'postgres',
  'psql', '-U', 'postgres', '-d', 'trustgrid', '-tAc', q], { encoding: 'utf8' }).trim();

const phase = process.argv[2];

async function ready(n = 2) {
  const images = makeImages(n);
  const c = await createInspection(images);
  const done = await uploadAll(c.body.uploads, images);
  await complete(c.body.inspectionId, done);
  return c.body.inspectionId as string;
}

async function main() {
  if (phase === 'create') {
    // Worker is DOWN. Nothing should be lost.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await ready(2));
    console.log(ids.join(','));
    return;
  }

  if (phase === 'assert-queued') {
    const ids = (process.argv[3] ?? '').split(',').filter(Boolean);
    const list = ids.map((i) => `'${i}'`).join(',');
    const statuses = sql(`SELECT string_agg(DISTINCT status::text, ',') FROM inspections WHERE id IN (${list})`);
    const queued = sql(`SELECT COUNT(*) FROM analysis_jobs WHERE inspection_id IN (${list}) AND status='queued'`);
    console.log(JSON.stringify({ statuses, queued: Number(queued) }));
    return;
  }

  if (phase === 'assert-failed') {
    const ids = (process.argv[3] ?? '').split(',').filter(Boolean);
    const list = ids.map((i) => `'${i}'`).join(',');
    const insp = sql(`SELECT string_agg(DISTINCT status::text, ',') FROM inspections WHERE id IN (${list})`);
    const an = sql(`SELECT string_agg(DISTINCT status::text, ',') FROM ai_analyses WHERE inspection_id IN (${list})`);
    const rawKept = sql(`SELECT COUNT(*) FROM ai_analyses WHERE inspection_id IN (${list}) AND raw_response::text <> '{}'`);
    const errKept = sql(`SELECT COUNT(*) FROM ai_analyses WHERE inspection_id IN (${list}) AND validation_errors IS NOT NULL`);
    const jobs = sql(`SELECT string_agg(status || ':' || attempts, ',') FROM analysis_jobs WHERE inspection_id IN (${list})`);
    console.log(JSON.stringify({ insp, an, rawKept: Number(rawKept), errKept: Number(errKept), jobs }));
    return;
  }

  if (phase === 'recover') {
    const ids = (process.argv[3] ?? '').split(',').filter(Boolean);
    for (const id of ids) {
      await fetch(`${BASE}/api/v1/inspections/${id}/analyze`, { method: 'POST' });
    }
    await sleep(8000);
    const list = ids.map((i) => `'${i}'`).join(',');
    const insp = sql(`SELECT string_agg(DISTINCT status::text, ',') FROM inspections WHERE id IN (${list})`);
    const cur = sql(`SELECT COUNT(*) FROM ai_analyses WHERE inspection_id IN (${list}) AND is_current AND status='succeeded'`);
    const hist = sql(`SELECT COUNT(*) FROM ai_analyses WHERE inspection_id IN (${list})`);
    console.log(JSON.stringify({ insp, recovered: Number(cur), totalRows: Number(hist) }));
    return;
  }

  if (phase === 'stale-reap') {
    // Simulate a worker that died mid-job: a 'running' row whose lock is old.
    const id = await ready(1);
    await sleep(500);
    sql(`UPDATE analysis_jobs SET status='running', locked_at=now() - interval '10 minutes',
         locked_by='dead-worker' WHERE inspection_id='${id}'`);
    console.log(id);
    return;
  }

  if (phase === 'assert-reaped') {
    const id = process.argv[3];
    const row = sql(`SELECT status || '|' || COALESCE(locked_by,'-') FROM analysis_jobs WHERE inspection_id='${id}'`);
    const insp = sql(`SELECT status FROM inspections WHERE id='${id}'`);
    console.log(JSON.stringify({ job: row, inspection: insp }));
    return;
  }

  throw new Error(`unknown phase: ${phase}`);
}
main().catch((e) => { console.error(e); process.exit(2); });
