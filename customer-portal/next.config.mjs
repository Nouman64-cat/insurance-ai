const dev = process.env.NODE_ENV !== "production";

// The browser only ever talks to this app. Tokens live in httpOnly cookies set by app/api/portal/*, which forward to
// Customer Management (through the API gateway) server-to-server. Nothing here is reachable cross-origin.
const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  optimizeFonts: false,
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
        { key: "Cache-Control", value: "no-store" },
      ],
    }];
  },
};

export default nextConfig;
