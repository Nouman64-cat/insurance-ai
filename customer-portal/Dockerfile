# Customer portal (individual policyholders). Self-contained: it shares no code with the staff app.
FROM node:20-alpine AS base
WORKDIR /workspace/customer-portal
COPY package*.json ./
RUN npm install --no-audit --no-fund --fetch-retries=6 --fetch-retry-mintimeout=15000 --fetch-timeout=180000
COPY . .

FROM base AS dev
EXPOSE 3009
CMD ["npm", "run", "dev"]

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM builder AS runner
ENV NODE_ENV=production
EXPOSE 3009
CMD ["npm", "start"]
