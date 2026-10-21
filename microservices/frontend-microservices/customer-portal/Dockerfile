# Customer portal (individual policyholders). Self-contained: it shares no code with the staff app.
FROM node:20-slim AS base
WORKDIR /workspace/customer-portal
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .

FROM base AS dev
EXPOSE 3009
CMD ["npm", "run", "dev"]

FROM base AS builder
ARG NEXT_PUBLIC_WALKIN_DEMO=false
ENV NEXT_PUBLIC_WALKIN_DEMO=$NEXT_PUBLIC_WALKIN_DEMO
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM builder AS runner
ENV NODE_ENV=production
EXPOSE 3009
CMD ["npm", "start"]
