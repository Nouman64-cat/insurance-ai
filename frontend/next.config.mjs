/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  optimizeFonts: false,
  // Lets client code tell demo from prod (see lib/envMode.ts).
  env: { NEXT_PUBLIC_ENV_VAR: process.env.ENV_VAR || "" },
};

export default nextConfig;
