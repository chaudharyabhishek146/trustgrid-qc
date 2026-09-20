/**
 * On-device image compression — the single highest-ROI piece of code here.
 *
 * A 12MP phone photo is 12-18 MB. Gemini tiles images into ~768px blocks
 * internally, so nothing above ~1600px on the long edge contributes signal for
 * "is this biomass wet" or "is there a stone in it".
 *
 *      15 MB  ->  ~400 KB   (~30x, no measurable accuracy cost for this task)
 *      75 MB  ->  ~2 MB     for a full 5-photo inspection
 *
 * On a 0.5 Mbps rural uplink that is ~32 seconds instead of ~20 minutes. The
 * cheapest resilience available is not sending the bytes at all.
 */
export interface CompressedImage {
  blob: Blob;
  sha256: string;
  sizeBytes: number;
  originalSizeBytes: number;
  widthPx: number;
  heightPx: number;
  contentType: 'image/jpeg';
}

const MAX_EDGE = 1600;
const QUALITY = 0.8;

export async function compressImage(file: File): Promise<CompressedImage> {
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))),
      'image/jpeg',
      QUALITY,
    );
  });

  return {
    blob,
    sha256: await sha256Hex(blob),
    sizeBytes: blob.size,
    originalSizeBytes: file.size,
    widthPx: width,
    heightPx: height,
    contentType: 'image/jpeg',
  };
}

/** Computed on-device and sent at create time; re-verified server-side on
 *  completion so a truncated upload is detected, not silently analysed. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const formatBytes = (n: number) =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
