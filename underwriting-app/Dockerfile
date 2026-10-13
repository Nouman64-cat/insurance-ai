# Underwriting Workbench. Built from the repository root (docker-compose: context ".", dockerfile
# underwriting-app/Dockerfile) because it compiles the portal code it shares (frontend/app/services, components, lib).
# Dockerfile.dockerignore next to this file keeps everything else out of the build context.
#
# Layout inside the image mirrors the repository, so tsconfig's "../frontend/*" fallback resolves:
#   /repo/underwriting-app   this app (WORKDIR)
#   /repo/frontend/...       the shared portal folders, read-only
FROM node:20-slim AS base
WORKDIR /repo/underwriting-app

# ── Dependency layer
FROM base AS deps
COPY underwriting-app/package.json underwriting-app/package-lock.json* ./
RUN npm install --no-audit --no-fund

# ── Development server (docker-compose mounts the sources over these copies for hot reload)
FROM base AS dev
COPY --from=deps /repo/underwriting-app/node_modules ./node_modules
# Shared portal files resolve their packages (react, axios...) by walking up from /repo/frontend: point that walk at
# this app's node_modules. (next.config.mjs does the same for the bundler.)
RUN ln -s /repo/underwriting-app/node_modules /repo/node_modules
COPY underwriting-app/ ./
COPY frontend/app/services /repo/frontend/app/services
COPY frontend/app/globals.css /repo/frontend/app/globals.css
COPY frontend/components /repo/frontend/components
COPY frontend/lib /repo/frontend/lib
EXPOSE 3005
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
CMD ["npm", "run", "dev"]

# ── Production build
FROM base AS builder
COPY --from=deps /repo/underwriting-app/node_modules ./node_modules
RUN ln -s /repo/underwriting-app/node_modules /repo/node_modules
COPY underwriting-app/ ./
COPY frontend/app/services /repo/frontend/app/services
COPY frontend/app/globals.css /repo/frontend/app/globals.css
COPY frontend/components /repo/frontend/components
COPY frontend/lib /repo/frontend/lib
# Browser-facing settings are compiled into the client bundle, so they are build arguments.
ARG NEXT_PUBLIC_API_URL=http://localhost:8010
ARG NEXT_PUBLIC_OCR_URL=http://localhost:8014
ARG NEXT_PUBLIC_SUMMARIZER_URL=http://localhost:8015
ARG NEXT_PUBLIC_PORTAL_URL=http://localhost:3000
ARG NEXT_PUBLIC_UNDERWRITING_URL=http://localhost:3005
ARG NEXT_PUBLIC_AUTOMATION_URL=http://localhost:3004
ARG ENV_VAR=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_OCR_URL=$NEXT_PUBLIC_OCR_URL \
    NEXT_PUBLIC_SUMMARIZER_URL=$NEXT_PUBLIC_SUMMARIZER_URL \
    NEXT_PUBLIC_PORTAL_URL=$NEXT_PUBLIC_PORTAL_URL \
    NEXT_PUBLIC_UNDERWRITING_URL=$NEXT_PUBLIC_UNDERWRITING_URL \
    NEXT_PUBLIC_AUTOMATION_URL=$NEXT_PUBLIC_AUTOMATION_URL \
    ENV_VAR=$ENV_VAR \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Production server: the standalone output only (no source, no dev dependencies)
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3005
ENV HOSTNAME=0.0.0.0
# The shared portal files are compiled into the bundles, so the server needs nothing from ../frontend at runtime.
COPY --from=builder /repo/underwriting-app/.next/standalone ./
COPY --from=builder /repo/underwriting-app/.next/static ./.next/static
COPY --from=builder /repo/underwriting-app/public ./public
EXPOSE 3005
CMD ["node", "server.js"]
