/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  optimizeFonts: false,
  async headers() {
    const parents = [process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3000", process.env.NEXT_PUBLIC_UNDERWRITING_URL || "http://localhost:3005"]
      .map(value => new URL(value).origin).join(" ");
    return [{source: "/embed", headers: [{key: "Content-Security-Policy", value: `frame-ancestors 'self' ${parents}`}]}];
  },
  // Lets client code tell demo from prod (see lib/envMode.ts).
  env: { NEXT_PUBLIC_ENV_VAR: process.env.ENV_VAR || "" },
};

export default nextConfig;
