# Skill-driven capability discovery

The implementation extends the existing LangGraph coordinator, specialist agents,
permission gate, executor, checkpoints and SSE transport. It adds 23 trusted local
skills and indexes 222 implemented capabilities (plus two discovery tools). It
does not expose arbitrary HTTP endpoints or make skill metadata an authorization
source.

## Execution path

1. The existing deterministic coordinator chooses the specialist. Medical and
   Financial Underwriters retain their pinned track; ClaimsManager retains its
   claims specialist. Finance also routes to claims, with payment execution
   separated from manager authorization.
2. `selector.py` retrieves at most three skill metadata records using intent
   phrases, synonym expansion, role authorization, specialist boundaries and
   short-reply carry-over. The LLM performs semantic interpretation during its
   ordinary planning call; this selector does not add an embedding/provider call.
3. `loader.py` reads instructions only for those skills. Definitions are typed,
   validated at startup and local to the repository. The selected guidance and
   dependency plan supplement existing prompts. The existing global prompt has
   not been rewritten wholesale.
4. General-planner bindings include up to 24 explicitly loaded/relevant authorized
   capabilities. The provider hard limit remains 128. Dynamic binding cache size
   is bounded to 128 entries. Specialists retain their explicit tool scopes; the
   underwriting scope now includes verified proposal/payment adapters.
5. If an operation was omitted, `search_capabilities` returns compact authorized
   metadata. `get_capability_schema` returns its schema and adds its real tool name
   to the conversation's checkpointed `active_capabilities`. It executes nothing.
   The next planner turn binds that name, rechecking current RBAC/platform scope.
6. The normal named tool then traverses the existing permission gate, interactive
   parameter questions, approval rules, graph/client journey routing and central
   executor. No generic execution shortcut bypasses these paths. Role checks now
   also occur inside the central executor for model-facing tools.

`executor.py` describes dependencies and handoff blockers; it does not create a
second workflow engine. Existing `operations.py` remains the durable source for
completed/failed/cancelled operations and safe resume. Successful results, quick
actions, upload interrupts and navigation retain their existing protocol.

## Corrected contracts

- `list_customers` had a declaration and handler but was absent from `ALL_TOOLS`.
  It is now registered and bound, including the existing fresh-customer shortcut.
- Individual proposals remain Draft on creation. Submission/review and initial
  premium receipt precede case creation. The autonomous node order is now intake
  → proposal → case → existing underwriting stages. Node and SSE stage IDs remain
  stable. Resume reuses the persisted customer/proposal and reads current state.
- `_ensure_case` and `create_case` enforce submitted proposal/payment prerequisites
  for individuals. Family/group contracts remain distinct. A failed service read
  is not interpreted as an absent proposal or payment.
- The backend claims authority contract reserves settlement authorization for
  ClaimsManager and payment execution for Finance. The chat matrix now reflects
  this, including Admin/SuperAdmin restrictions on decisions/payment. These
  security corrections remain active when progressive skills are disabled.

`capability_tools.py` adds nine fixed-path adapters: platform configuration,
tenant creation, global role creation/update, model selection (without API keys),
token usage, proposal transitions, initial-premium status, payment-link requests,
and explicit payment-proof review. Request schemas reject extra fields, tenant
IDs and arbitrary URLs. IDs are typed UUIDs. Platform operations require
SuperAdmin. The original backend validates record ownership, lifecycle and
financial evidence. A live payment request is reused instead of emailing a
second link. These adapters never automatically accept evidence or simulate a
payment.

## Failure recovery and observability

Registered reads may retry once after a transient failure; mutation calls are
never automatically replayed after dispatch. An unknown mutation outcome requires
live state verification before retry. Existing request/ticket idempotency keys,
claim duplicate checks, proposal reuse and backend uniqueness/payment checks are
retained. There is no new universal exactly-once guarantee across a crash between
a service commit and a graph checkpoint.

Structured `insurance.capabilities` events contain only capability name, role,
duration, attempt count, result code and recovery action. Arguments, results,
customer identifiers, medical evidence, tokens and credentials are excluded.
Skill selection and specialist are logged separately; existing `usage.record`
continues provider token accounting. Tool output and documents remain data and
cannot supply authority or register a capability.

## Inventory and verification

`reports/coverage.md` and `role-skill-tool-coverage.csv` map roles, skills and real
registered tools. `capabilities.json` includes schemas and handler source evidence.
`backend-routes.json` inventories 719 route declarations across 10 services;
`client-surfaces.json` identifies 11 web/mobile applications. Dynamic route
expressions and router prefixes are source evidence, not a promise of a resolved
external URL. Route-to-adapter mappings not explicitly established are marked
`requires_contract_mapping`; those endpoints are never automatically exposed.

`demo-scenarios.json` generates 2,664 positive/negative role-capability cases.
`test_skills.py` additionally covers realistic phrasings, dependent plans,
track isolation, missing parameters, unsupported tools, discovery, checkpoint
persistence, cross-tenant headers, retries, duplicate payment requests and
PII-safe telemetry. Existing tests cover interruption/correction/resume, claims,
group/family workflows, providers, voice and SSE.

Reproduce from repository root:

```sh
docker compose exec -T chat-agent python -m pytest --ignore=test_gemini.py -q \
  --junitxml=skills/reports/chat-regression-tests.xml
docker compose exec -T chat-agent python -m skills.demo_validation
python scripts/inventory_insurance_capabilities.py
INSURANCE_SYNTHETIC_LIVE_TESTS=1 python scripts/validate_insurance_agent_live.py
docker compose exec -T tenant-service python test_ipp_proposal.py
docker compose exec -T tenant-service python test_underwriting_tracks.py
```

The live smoke harness explicitly creates labeled synthetic tenants/users/policies,
keeps JWTs only in memory and deletes its fixtures. It performs no payments or
provider changes. It skips unconfigured roles and reports them. `test_gemini.py`
is excluded because it makes an unconditional real-provider request at module
import. See `reports/test-report.md` for results and remaining limitations.

## Rollout and rollback

`SKILL_AGENT_ENABLED=true` is the default and is passed through Compose. Set it
false and recreate/restart chat-agent to disable skill selection/instructions,
discovery tools and dynamic loaded bindings. Existing graphs, tools, providers,
SSE and clients continue using the existing domain-pack path. No migration or
frontend/mobile API change is required. The corrected business ordering, claims
authority and new named adapters remain; reverting those requires reverting the
corresponding code change, not weakening backend validation.

For a new capability, implement a fixed authorized adapter first, declare its
schema and safe/mutating classification, add a tool pack and skill mapping, and
add owning-service contract tests. Do not register an endpoint merely because it
appears in the route inventory. Inventory coverage is distinct from live execution
coverage, and neither establishes real-provider demo completion rates.
