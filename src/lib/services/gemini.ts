import { createHash } from 'node:crypto';
import { config } from '../config';
import { SYSTEM_PROMPT, RESPONSE_SCHEMA } from './prompt';
import { geminiOutputSchema, type GeminiOutput } from '../domain/validation';

export interface ImageInput {
  id: string;
  bytes: Buffer;
  contentType: string;
}

export type InferenceResult =
  | { ok: true; output: GeminiOutput; raw: unknown; latencyMs: number;
      inputTokens?: number; outputTokens?: number; modelVersion?: string }
  | { ok: false; kind: 'failed_api' | 'failed_parse'; error: string;
      raw: unknown; latencyMs: number };

/** Retryable transport / server conditions. 400/403/413 fail fast — retrying
 *  a malformed request just burns quota and battery. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Exponential backoff with FULL jitter. The jitter is not cosmetic: after a
 *  site-wide outage every device in the yard reconnects at once, and
 *  synchronised retries would be a self-inflicted thundering herd. */
function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, 60_000) * Math.random();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls Gemini with the pinned system prompt and enforced response schema.
 *
 * The API key is read from server-side config only. This module is imported by
 * the worker and by server route handlers — never by a client component.
 */
export async function analyseImages(images: ImageInput[]): Promise<InferenceResult> {
  if (config.gemini.mock) return mockInference(images);

  const started = Date.now();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [
        { text: `Analyse these ${images.length} photographs of a single biomass truckload.` },
        ...images.map((img) => ({
          inlineData: { mimeType: img.contentType, data: img.bytes.toString('base64') },
        })),
      ],
    }],
    generationConfig: {
      temperature: config.gemini.temperature,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  let lastError = 'unknown error';
  let lastRaw: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Header, not a query param — keeps the key out of logs and proxies.
          'x-goog-api-key': config.gemini.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const text = await res.text();
        lastError = `Gemini HTTP ${res.status}: ${text.slice(0, 500)}`;
        lastRaw = { status: res.status, body: text.slice(0, 2000) };
        if (RETRYABLE.has(res.status)) continue;
        return { ok: false, kind: 'failed_api', error: lastError, raw: lastRaw,
                 latencyMs: Date.now() - started };
      }

      const json: any = await res.json();
      lastRaw = json;
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string') {
        return { ok: false, kind: 'failed_parse', error: 'No text part in Gemini response',
                 raw: json, latencyMs: Date.now() - started };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, kind: 'failed_parse', error: 'Gemini returned non-JSON text',
                 raw: json, latencyMs: Date.now() - started };
      }

      // The model is NOT trusted. Re-validate everything it claimed.
      const check = geminiOutputSchema.safeParse(parsed);
      if (!check.success) {
        return { ok: false, kind: 'failed_parse',
                 error: `Schema validation failed: ${check.error.message.slice(0, 500)}`,
                 raw: json, latencyMs: Date.now() - started };
      }

      return {
        ok: true,
        output: check.data,
        raw: json,
        latencyMs: Date.now() - started,
        inputTokens: json?.usageMetadata?.promptTokenCount,
        outputTokens: json?.usageMetadata?.candidatesTokenCount,
        modelVersion: json?.modelVersion,
      };
    } catch (err: any) {
      lastError = `Transport error: ${err?.message ?? String(err)}`;
      lastRaw = { error: lastError };
    }
  }

  return { ok: false, kind: 'failed_api', error: lastError, raw: lastRaw,
           latencyMs: Date.now() - started };
}

/**
 * Deterministic mock. Derives plausible values from the SHA-256 of the image
 * bytes, so the same inspection always yields the same verdict — which makes
 * the demo reproducible and the tests stable. Roughly 1 in 8 mock inspections
 * lands below the confidence threshold, so the needs_review path is visible
 * without anyone having to force it.
 */
function mockInference(images: ImageInput[]): InferenceResult {
  const h = createHash('sha256');
  for (const img of images) h.update(img.bytes);
  const digest = h.digest();
  const pick = (i: number) => digest[i % digest.length] / 255;

  const moisture = Number((8 + pick(0) * 22).toFixed(2));   // 8-30 %
  const ash = Number((3 + pick(1) * 9).toFixed(2));         // 3-12 %
  const stones = pick(2) > 0.7;
  const confidence = Number((0.55 + pick(3) * 0.44).toFixed(3));
  const qualityOk = pick(4) > 0.08;

  return {
    ok: true,
    output: {
      moisture_pct: moisture,
      ash_pct: ash,
      foreign_stones: stones,
      foreign_detail: stones ? 'Two stone fragments visible near the tailgate, approx 40-60mm.' : '',
      confidence,
      quality_ok: qualityOk,
      observations: `MOCK INFERENCE (MOCK_GEMINI=true). Derived deterministically from ${images.length} image hash(es); no API call was made.`,
    },
    raw: { mock: true, model: config.gemini.model, images: images.length },
    latencyMs: 400 + Math.floor(pick(5) * 1200),
    inputTokens: 1200 + images.length * 258,
    outputTokens: 95,
    modelVersion: 'mock-1',
  };
}

/** Rough cost estimate for unit-economics telemetry. Real rates belong in
 *  config once the billing tier is known. */
export function estimateCostUsd(inputTokens = 0, outputTokens = 0): number {
  const IN_PER_1M = 0.10, OUT_PER_1M = 0.40;
  return Number(((inputTokens / 1e6) * IN_PER_1M + (outputTokens / 1e6) * OUT_PER_1M).toFixed(6));
}
