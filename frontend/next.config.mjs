/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  optimizeFonts: false,
  // Dev only: keep compiled routes warm. The defaults evict a page after ~1 min
  // idle (keeping only 5), so moving around the 30+ dashboard routes kept
  // triggering full recompiles on click.
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 50,
  },
  // Lets client code tell demo from prod (see lib/envMode.ts).
  env: { NEXT_PUBLIC_ENV_VAR: process.env.ENV_VAR || "" },
};

export default nextConfig;
