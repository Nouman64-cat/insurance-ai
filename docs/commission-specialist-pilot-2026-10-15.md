# Commission specialist pilot

## Architecture

There are now two conversational planners: the main assistant and the commission specialist. A deterministic coordinator selects one; it is not a third model call.

```text
User → coordinator → main assistant OR commission specialist
                  → shared permission/execution gate → coordinator
                  → response / clarification checkpoint
```

The commission specialist is a separate LangGraph node with its own system prompt and cached, restricted model binding. It uses the existing configured primary/fallback providers. No additional provider account, model key, child thread or database migration is required.

The pilot keeps one conversation/checkpoint and the exact authenticated execution context. This preserves customer/policy identity, clarifications, resume, regeneration and the existing backend approval constraints. The specialist has no independent executor or separate credentials.

## Routing and boundaries

- Explicit commission, agent earnings, rate-card and commission-ledger requests route to the specialist, including Urdu commission keywords.
- Financial follow-ups and selection answers keep commission context. New customer, underwriting and claim actions route back to the main assistant. Mixed requests containing an out-of-domain mutation stay with the main assistant.
- Routing is deterministic and conservative. It does not add a router LLM round trip. This is a bounded first-domain pilot, not a general semantic multi-agent supervisor.
- The specialist can bind at most **20 tools**, filtered further by user role/platform. An Admin's previous isolated commission-domain scope bound **70 tools** in the inspected registry. Mixed main-assistant turns can bind a different number.
- Onboarding, underwriting, issuance and claim mutations are excluded. Out-of-scope or unauthorized tool calls are rejected before they enter the shared executor, even if the model invents one.
- Every permitted call still passes through the existing permission gate and the domain API's authorization, maker–checker, idempotency and transaction checks. No financial approval is delegated to model judgment.
- Provider failures do not silently retry through a broader tool scope. Provider fallback and existing bounded retry/empty-response handling are retained.
- Replies and token deltas stream from both planner nodes. Internal helper calls stay hidden. Handoffs emit existing `step` events instead of requiring a new frontend protocol.

## Rollout and measurement

Enabled by default with `COMMISSION_SPECIALIST_ENABLED=true`. Docker Compose passes this setting to chat-agent. To return to the existing single-planner path:

```sh
COMMISSION_SPECIALIST_ENABLED=false docker compose up -d --no-deps chat-agent
```

Normal deployment remains `docker compose up -d --build`. Existing conversations can continue; missing specialist state in an older checkpoint defaults to the general path until a commission request selects the specialist.

Provider token usage is reported under **Chat Agent — Commission Specialist** separately from **Chat Agent**. Planner logs include service, scoped tool count and elapsed milliseconds without conversation text, credentials or customer identifiers. Latency is planner-call time, not full end-to-end conversation duration. Fewer schemas do not by themselves prove better accuracy or lower production latency; compare successful task completion, provider tokens and representative latency before adding more specialists.

## Verification

- **809 backend pytest checks passed**, including new routing, narrow binding, role restrictions, shared execution context, clarification/resume, thread isolation, provider failure and SSE streaming tests. The remaining warning is the pre-existing multipart deprecation.
- Live signed-in read-only test: the specialist identified Sana Abbasi for the labeled QA customer and reported missing configuration/no policy. The same chat then answered claims dashboard totals through the main agent and returned to commission guidance on request.
- The live specialist planner log reported 20 tools. That single observation is not a performance benchmark.
- No live customer/policy/commission records were mutated. Test chat history and normal usage telemetry were created.
- Evidence: `/tmp/insurance-commission-specialist/`; reusable tests: `services/chat-agent/test_commission_specialist.py`.

The earlier transport authentication/thread ownership audit remains a separate issue. This pilot does not claim to repair those boundaries. Financial safeguards continue to depend on backend authentication and authorization, not the specialist prompt.
