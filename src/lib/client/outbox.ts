/**
 * Durable capture outbox (IndexedDB).
 *
 * The inspector's job is to photograph the truck and wave it through. Capture
 * must therefore succeed with ZERO bars of signal, so photos and metadata are
 * written here the instant they are taken — before any network call exists.
 *
 * Survives reload, screen lock, app kill and a flat battery. This is the
 * difference between "the app needs signal" and "the network is the system's
 * problem, never the inspector's".
 */
export type OutboxStatus =
  | 'pending'          // captured, not yet sent
  | 'uploading'        // parts in flight / resuming
  | 'awaiting_result'  // bytes durable server-side, waiting on inference
  | 'done'
  | 'failed_permanent';

export interface OutboxImage {
  sequenceNo: number;
  blob: Blob;
  sha256: string;
  sizeBytes: number;
  originalSizeBytes: number;
  widthPx: number;
  heightPx: number;
  contentType: string;
  /** Server-assigned once the inspection exists. */
  imageId?: string;
  uploadId?: string;
  /** Parts already ACKed by storage. THIS is what makes a resume a resume. */
  completedParts?: { partNumber: number; etag: string }[];
  uploadedAt?: number;
}

export interface OutboxRecord {
  /** Client-generated UUID, minted at capture, reused across every retry.
   *  Doubles as the server-side Idempotency-Key. */
  id: string;
  status: OutboxStatus;
  createdAt: number;
  capturedAt: string;
  meta: {
    siteId: string; supplierId: string; inspectorId: string;
    vehicleNo: string; weighbridgeTicket?: string;
    grossWeightKg?: number; tareWeightKg?: number;
    supplierCode?: string;
  };
  images: OutboxImage[];
  inspectionId?: string;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number;
}

const DB_NAME = 'trustgrid-qc';
const STORE = 'outbox';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export const outbox = {
  put: (rec: OutboxRecord) => withStore<void>('readwrite', (s) => s.put(rec)),
  get: (id: string) => withStore<OutboxRecord | undefined>('readonly', (s) => s.get(id)),
  all: () => withStore<OutboxRecord[]>('readonly', (s) => s.getAll()),
  remove: (id: string) => withStore<void>('readwrite', (s) => s.delete(id)),

  async patch(id: string, patch: Partial<OutboxRecord>): Promise<OutboxRecord | undefined> {
    const rec = await outbox.get(id);
    if (!rec) return undefined;
    const next = { ...rec, ...patch };
    await outbox.put(next);
    return next;
  },

  /** Records eligible to sync right now (respecting backoff). */
  async due(): Promise<OutboxRecord[]> {
    const all = await outbox.all();
    const now = Date.now();
    return all
      .filter((r) => r.status !== 'done' && r.status !== 'failed_permanent')
      .filter((r) => !r.nextAttemptAt || r.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
};
