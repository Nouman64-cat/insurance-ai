# Evaluation environment

The golden cases run against a **separate copy of the application stack**, never against production or development data.
This page is the design: what is isolated, how, which side effects exist, and how each is contained.

## Isolation layers (a tenant id is never the only barrier)

| # | Layer | How |
|---|---|---|
| 1 | **Own database server** | `eval-postgres`, its own container, volume and credentials. Production's database is on the host (`host.docker.internal`); no eval container is told where it is. |
| 2 | **No inherited secrets** | The eval services do **not** use the repo `.env` (the production compose gives every service `env_file: .env`: production `DATABASE_URL`, AWS keys, sanctions key). They read only `evals/environment/eval.env`. |
| 3 | **No route to the outside** | Every eval service except the OCR engine sits on a Docker network marked `internal`: no internet, no host, no production stack. SMTP, S3, OpenSanctions, payment and Kafka endpoints are physically unreachable. The OCR engine alone is also attached to an egress network, because reading a document calls a paid model. |
| 4 | **Application-level mocks** | `EVAL_MOCK_EXTERNALS=1` swaps the Kafka producer for a recording stub and leaves mail, S3 and sanctions unconfigured, so those calls fail fast instead of hanging. |
| 5 | **Environment guard** | `shared/evaluation/safety.py`. Before any seed, reset or run the worker checks: the database name ends in `_eval`, the host is the eval server, an `eval_environment_marker` row written at provisioning is present, and the URL differs from every production URL it can see. It refuses otherwise. Reset only ever truncates, and only after the guard passes. |
| 6 | **Two tenants** | `tenant-a` and `tenant-b` (from the fixture), so cross-tenant denial is tested against real second-tenant data. |

## Side effects of the application, and what happens in the eval stack

| Side effect | Where | In the eval stack |
|---|---|---|
| Database writes | everywhere | the eval database only |
| Event stream (Kafka) | tenant-service startup and audit relay, gateway | recording stub; nothing is sent |
| Audit trail (outbox, MinIO audit archive) | `services/audit_capture.py` | `AUDIT_ENABLED=false` |
| Email (AWS SES over SMTP) | `email_utils.py`, payment requests, policy delivery | no provider configured, and no network |
| Object storage (S3) | `ocr_worker.py`, `application_dossier.py` | no credentials, and no network |
| Sanctions / PEP screening | `services/pep_screening.py` | no key configured, and no network; the internal watchlist applies |
| Payments | the initial premium records a method; the real tenant has no card gateway here | nothing external to reach; the strict-mode reference rule applies |
| Customer-management portal provisioning | `customer_management_client.py` | `PORTAL_PROVISIONING_MODE=legacy`, no URL, no network |
| Risk engine (AI underwriting) | `risk_client.py` | not started; calls fail fast |
| OCR / vision model | `ocr_worker.py`, the OCR engine | the OCR engine runs, with egress; **this is the one paid external call** and it is counted |
| Token usage ledger | OCR, chat, risk, summariser post to `/tokens/usage` | the eval stack's own ledger; the endpoint now needs the internal secret |

## Lifecycle

1. `provision` + `up` + `snapshot`: create `eval.env`, start the services (they build their own schema and seed the system roles and rule sets), then record that as the baseline and write the marker.
2. `seed`: read the fixtures of the dataset (never Python constants), create tenants, users with the real roles, customers, plans, policies, claims. Ids are `uuid5` of `(namespace, ref)`, so they are the same every time; seeding is idempotent.
3. `reset`: truncate every table and restore the baseline (what the application seeded itself), check nothing else is left, then seed again. Done before every independent execution and before every case that writes data.
4. Results, traces and cost records are written **outside** the eval database (to files now, MinIO/Postgres in step 6) before a reset, so cleanup never loses them.

## Commands (run from the repository root)

```
python evals/environment/envctl.py provision     # once: creates eval.env with fresh random secrets (never overwrites, never prints them)
python evals/environment/envctl.py up            # start the isolated stack (postgres, tenant-service, gateway, OCR engine, runner)
python evals/environment/envctl.py snapshot      # once, on a freshly started stack: record what the application seeded itself (the baseline)
python evals/environment/envctl.py fresh         # reset to the baseline and seed the fixtures: the state every execution starts from
python evals/environment/envctl.py guard         # every safety check, and what it found
python evals/environment/envctl.py cases         # run the cases that need the stack (add ids to pick some; --repeat N for N independent runs)
python evals/environment/envctl.py test          # the integration tests (reset, isolation, roles, cleanup, token ledger, usage)
python evals/environment/envctl.py status | down [--volumes]

# cases from a published Gold version instead of the repository files (checksums are re-verified when the bundle is made):
docker compose exec tenant-service python eval_lake_cli.py bundle individual-single-turn 1.0.5 --out /tmp/bundle
#   then copy /tmp/bundle into the runner's runs/bundles/ folder and:  envctl.py cases --bundle /work/runs/bundles/<name>
python evals/tools/selftest.py                   # no stack needed: dataset checks, engine, operation, usage and environment unit tests
```

Model-backed OCR cases need a model key in `eval.env` (`OPENAI_API_KEY=`). Without one they report "could not run".

## What this environment has found in the application (not in the environment)

These are real defects the isolated stack exposed. They are recorded in `evals/tools/test_environment_integration.py` (`KNOWN_DEFECTS`)
and in the golden dataset as failing cases; nothing in production was changed to hide them.

| Where | What happens | Evidence |
|---|---|---|
| `GET /tenants/{id}/policies` | answers **any caller, including one with no login**, for any tenant | anonymous request for tenant B returns tenant B's policies |
| `GET /tenants/{id}/claims` | answers an Admin or claims user **of another tenant** | tenant A's Admin reads tenant B's claims |
| `POST /tenants/{id}/customers` as an Agent | smoking status, height and weight an agent did not give are stored as `false / 170 / 70`, although the route sets them to unknown: `None` is replaced by the model's column defaults on insert | IND-CUST-001 fails; the stored row has the defaults |
