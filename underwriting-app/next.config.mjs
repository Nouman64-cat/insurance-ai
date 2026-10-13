import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ownModules = path.join(here, "node_modules");

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
    NEXT_PUBLIC_ENV_VAR: process.env.ENV_VAR || "",
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
