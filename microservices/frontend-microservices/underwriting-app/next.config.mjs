import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ownModules = path.join(here, "node_modules");

/**
 * A setting from the environment, or else from the repository's root .env. Docker Compose passes these explicitly;
 * a native `npm run dev` only reads this app's own .env files, so demo mode (ENV_VAR=demo) would otherwise be lost.
 */
function rootSetting(name) {
  if (process.env[name] !== undefined) return process.env[name];
  try {
    const line = fs.readFileSync(path.join(here, "..", "..", "..", ".env"), "utf8").match(new RegExp(`^\\s*${name}\\s*=(.*)$`, "m"));
    return line ? line[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

/**
 * The Underwriting Workbench. Code it shares with the portal (API clients, components, i18n, utilities) stays in
 * ../frontend and is compiled into this app from there: tsconfig maps "@/x" to ./x first and ../frontend/x second,
 * so this app's own files win and everything else comes from the portal. See README.md, "Shared code".
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: "standalone",
  optimizeFonts: false,
  // Compile the portal files this app imports (they live outside this directory).
  experimental: { externalDir: true },
  // Dev only: keep the few workbench routes compiled once visited.
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 20,
  },
  env: {
    // Read by lib/appLinks.ts (shared): which links stay in this app and which go to the portal.
    NEXT_PUBLIC_APP_NAME: "underwriting",
    // Lets client code tell demo from prod (see the portal's lib/envMode.ts).
    NEXT_PUBLIC_ENV_VAR: rootSetting("ENV_VAR"),
    // Browser-facing addresses, also from the root .env when the app runs natively. An empty value falls back to the
    // localhost default in the code that reads it.
    ...Object.fromEntries(["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_OCR_URL", "NEXT_PUBLIC_PORTAL_URL",
      "NEXT_PUBLIC_UNDERWRITING_URL", "NEXT_PUBLIC_REQUESTS_URL", "NEXT_PUBLIC_AUTOMATION_URL"].map((name) => [name, rootSetting(name)])),
  },
  webpack(config) {
    // Packages always come from this app's node_modules, also for the portal files compiled into it. Otherwise a
    // portal file would load ../frontend/node_modules/next (a second copy of the router: hooks fail) or nothing at
    // all in Docker, where only this app's node_modules exist.
    config.resolve.modules = [ownModules, ...(config.resolve.modules ?? ["node_modules"])];
    return config;
  },
};

export default nextConfig;
