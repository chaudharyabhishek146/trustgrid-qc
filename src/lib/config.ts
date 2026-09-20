/**
 * Central configuration. The Gemini API key is read here and NOWHERE else —
 * it never appears in a NEXT_PUBLIC_* var, never reaches the client bundle,
 * and never leaves the server process.
 */
function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}
const bool = (name: string, def: boolean) =>
  process.env[name] === undefined ? def : process.env[name] === 'true';
const int = (name: string, def: number) =>
  process.env[name] === undefined ? def : Number.parseInt(process.env[name]!, 10);

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/trustgrid'),

  gemini: {
    /** When true the whole workflow runs with no API key — see services/gemini.ts */
    mock: bool('MOCK_GEMINI', true),
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    promptVersion: process.env.PROMPT_VERSION ?? 'qc-biomass-v1',
    temperature: 0, // deterministic: the output is a measurement, not prose
  },

  storage: {
    backend: (process.env.STORAGE_BACKEND ?? 'local') as 'local' | 's3',
    localDir: process.env.LOCAL_STORAGE_DIR ?? './storage_data',
    signingSecret: process.env.UPLOAD_SIGNING_SECRET ?? 'dev-only-change-me',
    s3: {
      endpoint: process.env.S3_ENDPOINT_URL ?? 'http://localhost:9000',
      bucket: process.env.S3_BUCKET ?? 'trustgrid-images',
      accessKey: process.env.S3_ACCESS_KEY ?? 'minioadmin',
      secretKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
    },
  },

  policy: {
    uploadUrlTtlSeconds: int('UPLOAD_URL_TTL_SECONDS', 900), // 15 min, short by design
    maxImageBytes: int('MAX_IMAGE_BYTES', 20 * 1024 * 1024),
    /** Below this confidence the verdict goes to a human, not to an invoice. */
    reviewConfidenceThreshold: Number(process.env.REVIEW_CONFIDENCE_THRESHOLD ?? '0.70'),
    /** S3 multipart minimum for non-final parts. */
    partSizeBytes: 5 * 1024 * 1024,
  },

  worker: {
    pollMs: int('WORKER_POLL_MS', 1000),
    maxAttempts: 5,
  },
} as const;
