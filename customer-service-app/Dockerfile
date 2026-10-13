FROM node:20-alpine AS base
WORKDIR /workspace/customer-service-app
COPY customer-service-app/package*.json ./
RUN npm install
COPY customer-service-app/ ./
COPY frontend/ /workspace/frontend/
FROM base AS dev
EXPOSE 3008
CMD ["npm","run","dev"]
FROM base AS builder
ARG NEXT_PUBLIC_API_URL=http://localhost:8010
ARG NEXT_PUBLIC_PORTAL_URL=http://localhost:3000
ARG NEXT_PUBLIC_CUSTOMER_SERVICE_URL=http://localhost:3008
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_PORTAL_URL=$NEXT_PUBLIC_PORTAL_URL NEXT_PUBLIC_CUSTOMER_SERVICE_URL=$NEXT_PUBLIC_CUSTOMER_SERVICE_URL
RUN npm run build
FROM builder AS runner
EXPOSE 3008
CMD ["npm","start"]
