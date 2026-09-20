'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { compressImage, formatBytes, type CompressedImage } from '@/lib/client/compress';
import { outbox, type OutboxRecord } from '@/lib/client/outbox';
import { drainOutbox } from '@/lib/client/uploader';

/** Seeded in db/seed.sql. Auth/RBAC is a documented non-goal for the MVP —
 *  in production these come from the inspector's session. */
const SITE_ID = '11111111-1111-1111-1111-111111111111';
const INSPECTOR_ID = '33333333-3333-3333-3333-333333333333';

interface Supplier { id: string; code: string; name: string }

/**
 * STATE MANAGEMENT NOTE (the brief asked us to care about this):
 *
 * IndexedDB is the single source of truth, not React state. Every render is a
 * projection of what is durably on the device. That inversion is what makes
 * the app survive a reload, a lock screen, or a kill mid-upload — React state
 * is disposable, the outbox is not.
 *
 * `refresh()` re-reads the outbox and is called after every mutation, on an
 * interval, on `online`, and on window focus.
 */
export default function InspectionPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [grossWeight, setGrossWeight] = useState('');
  const [tareWeight, setTareWeight] = useState('');

  const [staged, setStaged] = useState<CompressedImage[]>([]);
  const [compressing, setCompressing] = useState(false);
  const [records, setRecords] = useState<OutboxRecord[]>([]);
  const [results, setResults] = useState<Record<string, any>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [online, setOnline] = useState(true);
  const [simulateDrop, setSimulateDrop] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => setRecords(await outbox.all()), []);

  const sync = useCallback(async () => {
    await drainOutbox((id, msg) => setProgress((p) => ({ ...p, [id]: msg })));
    await refresh();
  }, [refresh]);

  // ── Boot: suppliers, outbox, service worker, and the sync triggers ────────
  useEffect(() => {
    setOnline(navigator.onLine);
    fetch('/api/v1/suppliers')
      .then((r) => r.json())
      .then((d) => {
        setSuppliers(d.suppliers ?? []);
        if (d.suppliers?.[0]) setSupplierId(d.suppliers[0].id);
      })
      .catch(() => {/* offline boot: the form still works, sync happens later */});

    refresh();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'DRAIN_OUTBOX') sync();
      });
    }

    const goOnline = () => { setOnline(true); sync(); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    window.addEventListener('focus', sync);          // iOS Background Sync fallback
    const timer = setInterval(sync, 10_000);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('focus', sync);
      clearInterval(timer);
    };
  }, [refresh, sync]);

  // ── Poll for verdicts on anything whose bytes are already durable ─────────
  useEffect(() => {
    const pending = records.filter((r) => r.status === 'awaiting_result' && r.inspectionId);
    if (pending.length === 0) return;
    const timer = setInterval(async () => {
      for (const rec of pending) {
        try {
          const res = await fetch(`/api/v1/inspections/${rec.inspectionId}`);
          if (!res.ok) continue;
          const data = await res.json();
          setResults((prev) => ({ ...prev, [rec.id]: data }));
          if (['completed', 'needs_review', 'failed'].includes(data.inspection.status)) {
            await outbox.patch(rec.id, { status: 'done' });
            // Clear the transfer progress line: the verdict now speaks for it.
            setProgress((p) => {
              const { [rec.id]: _drop, ...rest } = p;
              return rest;
            });
            await refresh();
          }
        } catch {/* poll again in 2s */}
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [records, refresh]);

  async function onFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setCompressing(true);
    try {
      const out: CompressedImage[] = [];
      for (const f of files) out.push(await compressImage(f));
      setStaged((prev) => [...prev, ...out].slice(0, 5));
    } finally {
      setCompressing(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /**
   * Capture = a purely LOCAL write. No network call, so it succeeds with zero
   * bars. The truck can leave the gate the moment this returns.
   */
  async function captureInspection() {
    if (!supplierId || !vehicleNo || staged.length === 0) return;
    const rec: OutboxRecord = {
      id: crypto.randomUUID(),                 // doubles as the Idempotency-Key
      status: 'pending',
      createdAt: Date.now(),
      capturedAt: new Date().toISOString(),
      meta: {
        siteId: SITE_ID, supplierId, inspectorId: INSPECTOR_ID, vehicleNo,
        grossWeightKg: grossWeight ? Number(grossWeight) : undefined,
        tareWeightKg: tareWeight ? Number(tareWeight) : undefined,
        supplierCode: suppliers.find((s) => s.id === supplierId)?.code,
      },
      images: staged.map((img, i) => ({
        sequenceNo: i + 1, blob: img.blob, sha256: img.sha256,
        sizeBytes: img.sizeBytes, originalSizeBytes: img.originalSizeBytes,
        widthPx: img.widthPx, heightPx: img.heightPx, contentType: img.contentType,
      })),
      attempts: 0,
    };

    await outbox.put(rec);
    setStaged([]); setVehicleNo(''); setGrossWeight(''); setTareWeight('');
    await refresh();

    // Ask the browser to finish this in the background if we go offline.
    try {
      const reg: any = await navigator.serviceWorker?.ready;
      await reg?.sync?.register('sync-inspections');
    } catch {/* unsupported (iOS) — the focus/online fallbacks cover it */}

    sync();
  }

  function toggleDrop(next: boolean) {
    setSimulateDrop(next);
    sessionStorage.setItem('tg-simulate-drop', String(next));
  }

  const rawTotal = staged.reduce((n, i) => n + i.originalSizeBytes, 0);
  const compTotal = staged.reduce((n, i) => n + i.sizeBytes, 0);

  return (
    <main>
      <h1>TrustGrid QC — Gate Inspection</h1>

      <div style={{ padding: '.5rem', marginBottom: '1rem', border: '1px solid #ccc',
                    background: online ? '#f4fbf4' : '#fff6e5' }}>
        <strong>{online ? '● Online' : '○ Offline'}</strong>{' '}
        {online
          ? 'Captures sync immediately.'
          : 'Captures are saved on the device and will sync automatically.'}
        <label style={{ float: 'right', fontSize: '.85rem' }}>
          <input type="checkbox" checked={simulateDrop}
                 onChange={(e) => toggleDrop(e.target.checked)} />{' '}
          Simulate network drop
        </label>
      </div>

      {/* ── Capture form ──────────────────────────────────────────────────── */}
      <section style={{ border: '1px solid #ccc', padding: '1rem', marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>New inspection</h2>

        <label style={{ display: 'block', marginBottom: '.5rem' }}>
          Supplier<br />
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
                  style={{ width: '100%', padding: '.4rem' }}>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
          </select>
        </label>

        <label style={{ display: 'block', marginBottom: '.5rem' }}>
          Vehicle number<br />
          <input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
                 placeholder="HR55AB1234" style={{ width: '100%', padding: '.4rem' }} />
        </label>

        <div style={{ display: 'flex', gap: '.5rem', marginBottom: '.75rem' }}>
          <label style={{ flex: 1 }}>Gross (kg)<br />
            <input type="number" value={grossWeight} onChange={(e) => setGrossWeight(e.target.value)}
                   style={{ width: '100%', padding: '.4rem' }} /></label>
          <label style={{ flex: 1 }}>Tare (kg)<br />
            <input type="number" value={tareWeight} onChange={(e) => setTareWeight(e.target.value)}
                   style={{ width: '100%', padding: '.4rem' }} /></label>
        </div>

        <label style={{ display: 'block', marginBottom: '.5rem' }}>
          Photos (5 expected)<br />
          <input ref={fileInput} type="file" accept="image/*" capture="environment"
                 multiple onChange={onFilesSelected} />
        </label>
        {compressing && <p>Compressing…</p>}

        {staged.length > 0 && (
          <div style={{ background: '#f6f6f6', padding: '.5rem', marginBottom: '.75rem',
                        fontSize: '.9rem' }}>
            <strong>{staged.length} photo(s) ready.</strong>{' '}
            Compressed on-device: {formatBytes(rawTotal)} → <strong>{formatBytes(compTotal)}</strong>
            {rawTotal > 0 && <> ({(rawTotal / Math.max(compTotal, 1)).toFixed(1)}× smaller)</>}
            <div style={{ color: '#555', marginTop: '.25rem' }}>
              This is the difference between minutes and seconds on a 3G uplink.
            </div>
          </div>
        )}

        <button onClick={captureInspection}
                disabled={!supplierId || !vehicleNo || staged.length === 0 || compressing}
                style={{ padding: '.6rem 1.2rem', fontSize: '1rem' }}>
          Capture &amp; release truck
        </button>
      </section>

      {/* ── Queue ─────────────────────────────────────────────────────────── */}
      <section>
        <h2>Inspections ({records.length})</h2>
        {records.length === 0 && <p style={{ color: '#666' }}>No inspections captured yet.</p>}
        {records.slice().reverse().map((rec) => (
          <InspectionCard key={rec.id} rec={rec} result={results[rec.id]}
                          progress={progress[rec.id]} onChange={refresh} />
        ))}
      </section>

      <CalibrationPanel />
    </main>
  );
}

function InspectionCard({ rec, result, progress, onChange }: {
  rec: OutboxRecord; result: any; progress?: string; onChange: () => void;
}) {
  const a = result?.analysis;
  const status = result?.inspection?.status ?? rec.status;
  const uploaded = rec.images.filter((i) => i.uploadedAt).length;

  const colour: Record<string, string> = {
    pending: '#8a6d00', uploading: '#8a6d00', awaiting_result: '#00548a',
    processing: '#00548a', completed: '#1d6b1d', needs_review: '#8a4b00',
    failed: '#a11', failed_permanent: '#a11', done: '#1d6b1d',
  };

  return (
    <div style={{ border: '1px solid #ccc', padding: '.75rem', marginBottom: '.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <strong>{rec.meta.vehicleNo}</strong>
        <span style={{ color: colour[status] ?? '#333', fontWeight: 600 }}>{status}</span>
      </div>
      <div style={{ fontSize: '.85rem', color: '#555' }}>
        {rec.meta.supplierCode} · {new Date(rec.capturedAt).toLocaleString()} ·{' '}
        {uploaded}/{rec.images.length} photos uploaded
      </div>

      {progress && <div style={{ fontSize: '.85rem', color: '#00548a' }}>↻ {progress}</div>}
      {rec.lastError && (
        <div style={{ fontSize: '.85rem', color: '#a11' }}>
          ⚠ {rec.lastError}
          {rec.status === 'pending' && ' — will retry automatically'}
        </div>
      )}

      {a && (
        <table style={{ marginTop: '.5rem', fontSize: '.95rem', borderCollapse: 'collapse' }}>
          <tbody>
            <Row label="Moisture" value={a.moisture_pct != null ? `${a.moisture_pct}%` : '—'} />
            <Row label="Ash" value={a.ash_pct != null ? `${a.ash_pct}%` : '—'} />
            <Row label="Foreign stones" value={a.foreign_stones ? `Yes — ${a.foreign_detail}` : 'No'} />
            <Row label="Confidence" value={a.confidence != null ? Number(a.confidence).toFixed(2) : '—'} />
            <Row label="Model" value={`${a.model_name} / ${a.prompt_version}`} />
            <Row label="Latency" value={a.latency_ms ? `${a.latency_ms} ms` : '—'} />
          </tbody>
        </table>
      )}

      {a?.validation_errors?.review_reasons && (
        <div style={{ marginTop: '.5rem', padding: '.4rem', background: '#fff6e5',
                      fontSize: '.85rem' }}>
          <strong>Flagged for human review:</strong>
          <ul style={{ margin: '.25rem 0 0 1rem' }}>
            {a.validation_errors.review_reasons.map((r: string) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      )}

      {result?.labResult ? (
        <div style={{ marginTop: '.5rem', fontSize: '.9rem', background: '#f4fbf4', padding: '.4rem' }}>
          <strong>Lab ({result.labResult.lab_name}):</strong>{' '}
          moisture {result.labResult.moisture_pct}% · ash {result.labResult.ash_pct}%
          {a?.moisture_pct != null && result.labResult.moisture_pct != null && (
            <> · <strong>Δ moisture {(a.moisture_pct - result.labResult.moisture_pct).toFixed(2)}</strong></>
          )}
        </div>
      ) : (
        rec.inspectionId && a && <LabResultForm inspectionId={rec.inspectionId} onSaved={onChange} />
      )}
    </div>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <tr>
    <td style={{ paddingRight: '1rem', color: '#555' }}>{label}</td>
    <td><strong>{value}</strong></td>
  </tr>
);

/** Simulates the T+48h lab result arriving. In production this is a LIMS
 *  webhook or a CSV import, not a form. */
function LabResultForm({ inspectionId, onSaved }: { inspectionId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [moisture, setMoisture] = useState('');
  const [ash, setAsh] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
              style={{ marginTop: '.5rem', fontSize: '.8rem' }}>
        + Enter delayed lab result
      </button>
    );
  }

  return (
    <div style={{ marginTop: '.5rem', fontSize: '.85rem' }}>
      <input placeholder="lab moisture %" value={moisture}
             onChange={(e) => setMoisture(e.target.value)} style={{ width: 110 }} />{' '}
      <input placeholder="lab ash %" value={ash}
             onChange={(e) => setAsh(e.target.value)} style={{ width: 90 }} />{' '}
      <button disabled={busy} onClick={async () => {
        setBusy(true);
        await fetch('/api/v1/lab-results', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            inspectionId, sampleId: `SMP-${Date.now()}`,
            moisturePct: Number(moisture), ashPct: Number(ash),
            labName: 'Central Lab', source: 'manual',
          }),
        });
        setBusy(false); setOpen(false); onSaved();
      }}>Save</button>
    </div>
  );
}

/** The calibration loop, visible. This is what the "delayed lab results" field
 *  in the brief was actually for. */
function CalibrationPanel() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch('/api/v1/calibration/summary').then((r) => r.json())
      .then(setData).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  if (!data?.accuracy?.length) return null;
  return (
    <section style={{ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1rem' }}>
      <h2>Model calibration (AI vs physical lab)</h2>
      <table style={{ fontSize: '.9rem', borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
            <th>Prompt</th><th>Model</th><th>n</th>
            <th>Moisture bias</th><th>Moisture MAE</th><th>Ash MAE</th>
          </tr>
        </thead>
        <tbody>
          {data.accuracy.map((r: any) => (
            <tr key={`${r.prompt_version}-${r.model_name}`}>
              <td>{r.prompt_version}</td><td>{r.model_name}</td><td>{r.n}</td>
              <td>{r.moisture_bias}</td><td>{r.moisture_mae}</td><td>{r.ash_mae}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: '.85rem', color: '#555' }}>
        A consistent non-zero bias is directly actionable: correction offset, prompt rewrite,
        or fine-tuning. Attribution is only possible because every prediction stores the exact
        prompt and model version that produced it.
      </p>
    </section>
  );
}
