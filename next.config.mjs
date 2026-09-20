/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API routes receive only JSON metadata — image bytes go straight to
  // storage — so the default body limit is intentionally left small.
  experimental: { serverActions: { bodySizeLimit: '1mb' } },
};
export default nextConfig;
