# Customer Service app

Independent Next.js app at http://localhost:3008/customer-service. Sign in on the portal first.
Shares the portal's SSO cookie and verifies the session through the gateway.

```sh
docker compose up -d --build customer-service-app
```

Native development:

```sh
cp .env.example .env.local
npm install
npm run dev
```

The service desk offers search, status filters, pagination, ticket creation, conversation/history,
claim/release assignment, status changes, resolution, reopening, and staff-only internal notes.
Optional customer/policy links currently accept record UUIDs and validate access on the backend.

`NEXT_PUBLIC_CUSTOMER_SERVICE_URL` must be set on the portal and this app for custom deployment origins.
`API_GATEWAY_INTERNAL_URL` is localhost:8010 natively and api-gateway:8000 inside Docker.
Use matching SSO_COOKIE_NAME/SSO_COOKIE_DOMAIN settings, HTTPS, and Secure cookies for subdomain deployment.

```sh
npm run typecheck
npm run build
```

Dockerfile targets: dev for local Compose, runner for a production build. Build-time public URLs are ARGs.
