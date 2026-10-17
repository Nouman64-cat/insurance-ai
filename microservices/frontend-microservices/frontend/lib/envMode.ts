// Mirrors the backend switch: only ENV_VAR=demo enables demo-only features.
// ENV_VAR is exposed to the browser as NEXT_PUBLIC_ENV_VAR by next.config.mjs.
export const IS_DEMO = (process.env.NEXT_PUBLIC_ENV_VAR || "").trim().toLowerCase() === "demo";
