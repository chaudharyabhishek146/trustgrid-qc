import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import type { CompletedPart } from '../domain/types';

/**
 * Storage seam (ARCHITECTURE.md §9.3). Two implementations behind one interface:
 *
 *   "local" — resumable part uploads served by this app on disk. Zero infra,
 *             runs on a laptop with nothing but Postgres. Used for the demo.
 *   "s3"    — real S3/MinIO multipart. Image bytes NEVER touch the app tier;
 *             the browser PUTs parts directly to the bucket.
 *
 * Both speak the same create -> presign parts -> complete lifecycle, so the
 * client code is identical either way. This is also the Phase-3 extension
 * point: a weighbridge edge node is just a third implementation pointing at
 * an on-site MinIO over LAN.
 */
export interface StorageAdapter {
  readonly bucket: string;
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, maxBytes: number): Promise<string>;
  /** SHA-256 of the assembled object, or null when the backend cannot compute
   *  it cheaply (S3: a streaming verification job is the documented follow-up). */
  objectSha256(key: string): Promise<string | null>;
  /** Parts already durable in storage for this session. This is what makes
   *  resume SERVER-authoritative: even a client that lost its local ETag
   *  bookkeeping (reinstall, cleared storage, different device) resumes
   *  instead of re-sending bytes that already landed. */
  listParts(key: string, uploadId: string): Promise<CompletedPart[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<{ sizeBytes: number }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  /** Remove upload sessions abandoned before completion. Without this,
   *  interrupted uploads accumulate forever. */
  cleanupStaleUploads(olderThanMs: number): Promise<number>;
}

/** QA-B2: uploadId reaches a filesystem path, so its shape is constrained
 *  here rather than relying on the framework to normalise away traversal. */
export const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;
export const isValidUploadId = (id: string) => UPLOAD_ID_RE.test(id);

// ─────────────────────────── Local (disk) adapter ───────────────────────────

const partsDir = (uploadId: string) =>
  path.join(config.storage.localDir, 'uploads', uploadId);
const objectPath = (key: string) =>
  path.join(config.storage.localDir, 'objects', key);

/** HMAC-signed, time-limited part URLs — the local analogue of a presigned S3
 *  URL. Without this the part endpoint would be an open write surface. */
export function signPartUrl(
  uploadId: string, partNumber: number, key: string, maxBytes: number,
): string {
  const exp = Math.floor(Date.now() / 1000) + config.policy.uploadUrlTtlSeconds;
  // maxBytes is part of the signed payload, so a client cannot store more than
  // the size it reserved for this part (QA-A3).
  const payload = `${uploadId}:${partNumber}:${key}:${maxBytes}:${exp}`;
  const sig = createHmac('sha256', config.storage.signingSecret).update(payload).digest('hex');
  const q = new URLSearchParams({ key, len: String(maxBytes), exp: String(exp), sig });
  return `/api/v1/uploads/${uploadId}/parts/${partNumber}?${q}`;
}

export function verifyPartUrl(
  uploadId: string, partNumber: number, key: string,
  maxBytes: string, exp: string, sig: string,
): boolean {
  if (!exp || !sig || !maxBytes) return false;
  if (Number(exp) * 1000 < Date.now()) return false;          // expired
  const payload = `${uploadId}:${partNumber}:${key}:${maxBytes}:${exp}`;
  const expected = createHmac('sha256', config.storage.signingSecret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(sig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

class LocalStorage implements StorageAdapter {
  readonly bucket = 'local';

  async createMultipartUpload(_key: string, _contentType: string): Promise<string> {
    const uploadId = createHash('sha256')
      .update(`${_key}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32);
    await fs.mkdir(partsDir(uploadId), { recursive: true });
    return uploadId;
  }

  async presignPart(key: string, uploadId: string, partNumber: number, maxBytes: number) {
    return signPartUrl(uploadId, partNumber, key, maxBytes);
  }

  async objectSha256(key: string): Promise<string | null> {
    const buf = await fs.readFile(objectPath(key));
    return createHash('sha256').update(buf).digest('hex');
  }

  async cleanupStaleUploads(olderThanMs: number): Promise<number> {
    const root = path.join(config.storage.localDir, 'uploads');
    let entries: string[];
    try { entries = await fs.readdir(root); } catch { return 0; }
    let removed = 0;
    for (const name of entries) {
      const dir = path.join(root, name);
      try {
        const st = await fs.stat(dir);
        if (Date.now() - st.mtimeMs > olderThanMs) {
          await fs.rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch { /* raced with a completion */ }
    }
    return removed;
  }

  async listParts(_key: string, uploadId: string): Promise<CompletedPart[]> {
    let names: string[];
    try { names = await fs.readdir(partsDir(uploadId)); }
    catch { return []; }                                  // session not started yet
    const out: CompletedPart[] = [];
    for (const name of names) {
      const m = /^part-(\d+)$/.exec(name);
      if (!m) continue;
      const buf = await fs.readFile(path.join(partsDir(uploadId), name));
      out.push({ partNumber: Number(m[1]), etag: createHash('md5').update(buf).digest('hex') });
    }
    return out.sort((a, b) => a.partNumber - b.partNumber);
  }

  /** Called by the part-upload route once the signature has been verified.
   *  Returns null when the upload session no longer exists — completing an
   *  inspection closes the session, and a still-valid signed URL must not be
   *  able to resurrect it and strand orphaned bytes on disk (QA-B7). */
  async writePart(uploadId: string, partNumber: number, body: Buffer): Promise<string | null> {
    try {
      await fs.access(partsDir(uploadId));
    } catch {
      return null;                                   // session closed or never opened
    }
    await fs.writeFile(path.join(partsDir(uploadId), `part-${partNumber}`), body);
    return createHash('md5').update(body).digest('hex'); // ETag, S3-compatible shape
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]) {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Buffer[] = [];
    for (const p of ordered) {
      try {
        chunks.push(await fs.readFile(path.join(partsDir(uploadId), `part-${p.partNumber}`)));
      } catch {
        // The client claimed a part it never uploaded: that is a bad request,
        // not a server fault (QA-A2).
        throw Object.assign(
          new Error(`Part ${p.partNumber} was never uploaded`), { statusCode: 422 });
      }
    }
    const full = Buffer.concat(chunks);
    const dest = objectPath(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, full);
    await fs.rm(partsDir(uploadId), { recursive: true, force: true });
    return { sizeBytes: full.length };
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    await fs.rm(partsDir(uploadId), { recursive: true, force: true });
  }

  async getObject(key: string): Promise<Buffer> {
    return fs.readFile(objectPath(key));
  }
}

// ──────────────────────────── S3 / MinIO adapter ────────────────────────────

class S3Storage implements StorageAdapter {
  readonly bucket = config.storage.s3.bucket;
  private clientPromise: Promise<any> | null = null;

  // Imported lazily so a "local" deployment never pays for the SDK.
  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { S3Client } = await import('@aws-sdk/client-s3');
        return new S3Client({
          region: config.storage.s3.region,
          endpoint: config.storage.s3.endpoint,
          forcePathStyle: config.storage.s3.forcePathStyle,
          credentials: {
            accessKeyId: config.storage.s3.accessKey,
            secretAccessKey: config.storage.s3.secretKey,
          },
        });
      })();
    }
    return this.clientPromise;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const { CreateMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    const out = await (await this.client()).send(new CreateMultipartUploadCommand({
      Bucket: this.bucket, Key: key, ContentType: contentType,
    }));
    if (!out.UploadId) throw new Error('S3 did not return an UploadId');
    return out.UploadId;
  }

  async objectSha256(_key: string): Promise<string | null> {
    // Verifying a full hash means streaming the object back out of S3. Deferred
    // to an async verification job; size is checked at completion instead.
    return null;
  }

  async cleanupStaleUploads(_olderThanMs: number): Promise<number> {
    // S3 does this natively and more cheaply via a bucket lifecycle rule:
    //   AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }
    return 0;
  }

  async presignPart(key: string, uploadId: string, partNumber: number, _maxBytes: number) {
    const { UploadPartCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(
      await this.client(),
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: config.policy.uploadUrlTtlSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<CompletedPart[]> {
    const { ListPartsCommand } = await import('@aws-sdk/client-s3');
    try {
      const out = await (await this.client()).send(new ListPartsCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId,
      }));
      return (out.Parts ?? []).map((p: any) => ({
        partNumber: Number(p.PartNumber), etag: String(p.ETag ?? '').replaceAll('"', ''),
      }));
    } catch {
      return [];   // no such upload session yet
    }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]) {
    const { CompleteMultipartUploadCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await this.client();
    await c.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket, Key: key, UploadId: uploadId,
      MultipartUpload: {
        Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }));
    const head = await c.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return { sizeBytes: Number(head.ContentLength ?? 0) };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const { AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    await (await this.client()).send(new AbortMultipartUploadCommand({
      Bucket: this.bucket, Key: key, UploadId: uploadId,
    }));
  }

  async getObject(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const out = await (await this.client()).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
}

// ──────────────────────────────── Selection ─────────────────────────────────

const localSingleton = new LocalStorage();

export const storage: StorageAdapter =
  config.storage.backend === 's3' ? new S3Storage() : localSingleton;

/** The part-upload route needs the concrete local adapter; it is meaningless
 *  under S3, where parts go straight to the bucket. */
export const localStorage = localSingleton;
export const isLocalBackend = config.storage.backend !== 's3';

export function buildStorageKey(inspectionId: string, sequenceNo: number): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return `inspections/${ymd}/${inspectionId}/${sequenceNo}.jpg`;
}
