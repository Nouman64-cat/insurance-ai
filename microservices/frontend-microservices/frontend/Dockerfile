FROM node:20-slim AS base

WORKDIR /app

# ── Dependency layer
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

# ── Development server (used by docker-compose) ────────────────────────────
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
CMD ["npm", "run", "dev"]

# ── Production build ───────────────────────────────────────────────────────
FROM base AS builder
ARG NEXT_PUBLIC_API_URL=http://localhost:8010
ARG NEXT_PUBLIC_OCR_URL=http://localhost:8014
ARG NEXT_PUBLIC_CUSTOMER_SERVICE_URL=http://localhost:3008
ARG NEXT_PUBLIC_AUTOMATION_URL=http://localhost:3004
ARG NEXT_PUBLIC_UNDERWRITING_URL=http://localhost:3005
ARG NEXT_PUBLIC_CLAIMS_URL=http://localhost:3011
ARG NEXT_PUBLIC_PORTAL_URL=http://localhost:3000
ARG ENV_VAR=
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_OCR_URL=$NEXT_PUBLIC_OCR_URL \
    NEXT_PUBLIC_CUSTOMER_SERVICE_URL=$NEXT_PUBLIC_CUSTOMER_SERVICE_URL \
    NEXT_PUBLIC_AUTOMATION_URL=$NEXT_PUBLIC_AUTOMATION_URL \
    NEXT_PUBLIC_UNDERWRITING_URL=$NEXT_PUBLIC_UNDERWRITING_URL \
    NEXT_PUBLIC_CLAIMS_URL=$NEXT_PUBLIC_CLAIMS_URL \
    NEXT_PUBLIC_PORTAL_URL=$NEXT_PUBLIC_PORTAL_URL \
    ENV_VAR=$ENV_VAR
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
