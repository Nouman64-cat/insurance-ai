# Production deployment

This is a single EC2 host deployment using the Terraform stack in `infrastructure/terraform/` and a production overlay on the repository's existing Compose services. It is a starting production configuration, not a highly available architecture: the EC2 instance, local Kafka, Memgraph and AIStor data volumes are single-host failure domains.

## Prerequisites

- Create Terraform resources first and set `allowed_web_ingress_cidrs` to the intended client CIDRs (use `0.0.0.0/0` only if the public sites should be internet-facing). The security group permits only TCP 80/443; SSH remains closed and SSM is used for administration.
- Use Ubuntu 24.04 ARM64, Docker Compose v2.24.4 or newer, and the existing repository checkout on the EC2 host. The Terraform bootstrap installs Docker and Compose.
- Set the DNS A records for the root domain and each hostname (`app`, `portal`, `api`, `ocr`, `support`, `underwriting`, `claims`, `automation`) to Terraform's `public_ipv4` output before starting Caddy. Caddy obtains and renews HTTPS certificates automatically; ports 80/443 must be reachable.
- Provide a reachable PostgreSQL database and create/restrict its network access to the EC2 host. The app expects the database roles/schemas to be provisioned using the app's provisioning jobs.
- Obtain the required MinIO AIStor license and install it at the path in `AISTOR_LICENSE_FILE`. Keep signing keys, passphrases, archive keys and all environment secrets backed up separately from the EC2 disk.

## Configure and start

1. Copy `deploy/env.production.example` to repository root as `.env.production`. Replace every example domain and `REPLACE_*` value, and set all database DSNs to the real database. Use URL-encoded database passwords. Do not commit this file.
2. Ensure Terraform's EIP is in DNS and the EC2 security-group ingress includes the users' client CIDRs. The default Terraform ingress is empty, so no public web access is allowed until configured.
3. On the host, from the repository root, validate and start the production profile:

   ```sh
   docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.production.yaml --profile production config
   docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.production.yaml --profile production up -d --build
   ```

   The overlay disables development services and source mounts, removes application port publications, and exposes only Caddy on 80/443. Application containers communicate over the Compose network.

4. Once PostgreSQL is reachable, run the request-management database provisioning job once:

   ```sh
   docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.production.yaml --profile production --profile production-tools run --rm request-management-provision
   ```

5. Initialize audit archive keys and signer keys once, following the prompts/instructions in `microservices/backend-microservices/audit-service/README.md` and the audit signer documentation. Keep resulting named volumes and their backups protected. These are one-time operations; do not reinitialize them over live production volumes.
6. Check service health and logs:

   ```sh
   docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.production.yaml --profile production ps
   docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.production.yaml --profile production logs --tail=200
   ```

   Back up PostgreSQL, EBS and named Docker volumes, and practice restore before storing production records.

## Important application prerequisites and limits

- This EC2 stack does not create or operate PostgreSQL. The DSNs in `.env.production` are placeholders and must target a production database with TLS, backups and access restricted to this host. Provisioning job passwords and app DSNs must correspond to the same roles.
- Do not put database master credentials in general-purpose runtime environment variables after initial provisioning. The current Compose provision jobs use an administrative DSN; remove or tightly restrict that credential after schema setup.
- The current tenant-service Compose configuration passes static AWS access keys. For production, create a code change to use the attached EC2 instance role and remove `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from containers. Until that is done, supply a narrowly scoped IAM identity and rotate it.
- The API gateway supports an explicit `CORS_ALLOWED_ORIGINS` list and the example sets it. The tenant-service currently configures credentialed CORS for any HTTP(S) origin in application code; restrict that in code before treating this deployment as production-ready for real customer data.
- Email delivery requires verified SES identities and SES SMTP credentials. The template lists these values; sending and deliverability still need to be confirmed in the AWS account.
- AIStor is self-hosted on the same EC2 disk. It needs its vendor license and independent off-host backups. It is not equivalent to an AWS-managed S3 archive.
- Several backend Dockerfiles are ARM-compatible Python images; Node frontend images use Debian multi-arch bases. Pin every mutable image to reviewed versions/digests as part of release management. This Compose configuration does not establish CI/CD, image signing/scanning, central log retention, host patch automation, or multi-AZ recovery.
- The existing request-management frontend has no production Dockerfile/service in the repository, so this deployment exposes its API through the gateway but does not deploy its separate UI. Confirm that this matches the desired product entry points.
- Browser-facing `NEXT_PUBLIC_*` values are baked into Next.js during image build; rebuild after changing domains. Secret values must never use `NEXT_PUBLIC_*`.
- Confirm CORS, trusted origins, cookie domain, external email/SES, OpenSanctions, LLM provider configuration, and any third-party callback allowlists for the chosen domain before opening web ingress.

## Updating the deployment

Make infrastructure changes in `infrastructure/terraform/` and application routing/runtime changes in `deploy/`. Keep secrets only in the ignored host-side `.env.production` (or migrate them to a proper secret manager), run `terraform plan` before infrastructure applies, validate Compose config before each release, and keep application code release/versioning separate from Terraform state. Do not edit production state or secrets through ad-hoc source commits.
