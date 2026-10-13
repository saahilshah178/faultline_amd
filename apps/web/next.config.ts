import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The end-to-end tests build a second copy against a fixture data dir; see tests/e2e/prepare.mjs.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Live-mode API routes read alerts, prompts and the KB from server-data/ at runtime,
  // so those files must ship inside the function bundle on Vercel.
  outputFileTracingIncludes: {
    "/api/**/*": ["./server-data/**/*"],
  },
  // `next dev` only serves its client bundles to the origin it was opened on. Allow the
  // loopback address too, so http://127.0.0.1:3000 works the same as http://localhost:3000.
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  poweredByHeader: false,
};

export default nextConfig;
