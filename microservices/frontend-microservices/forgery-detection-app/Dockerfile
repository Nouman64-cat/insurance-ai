FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund

FROM deps AS dev
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3012
CMD ["npm", "run", "dev"]

FROM dev AS builder
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3012 HOSTNAME=0.0.0.0
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3012
CMD ["node", "server.js"]
