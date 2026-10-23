# Individual Insurance golden dataset

75 test cases (at least 6 in each of the 11 workflow categories), the synthetic fixtures they run against, and the tools that keep
them honest. The cases are data (JSON), not Python. The published copy of a version lives in the data lake
(`shared/evaluation`), not here; these files are what gets ingested.

```
datasets/individual-insurance/
  cases/*.json         authoring source, one array per category (compact format, see below)
  single_turn.jsonl    generated, canonical: what the lake ingests   (64 cases)
  multi_turn.jsonl     generated, canonical                          (11 cases)
  fixtures/            synthetic world (tenants, users, plans, customers, policies, claims) and documents, plus manifest.json
tools/
  verify_dataset.py    schema + fixtures + every oracle re-run against the real service code + coverage
  selftest.py          19 deliberate corruptions the verifier must catch
  build_dataset.py     verify, write the JSONL, dry-run it through the lake's own validation   (--check: fail if stale)
  make_fixtures.py     draw the document fixtures and write manifest.json                      (--check: compare only)
  oracles.py           loads the real code (with small stand-ins for the database and agent framework) and re-derives answers
```

Run from the repository root: `python evals/tools/build_dataset.py && python evals/tools/selftest.py`. Nothing needs
Docker, a database or a model key.

## Where expected values come from
Every deterministic expectation carries `metadata.truth`: oracle calls that must reproduce it from the code as it is now.
When the code changes, the oracle disagrees and the verifier fails: that is how a case is found stale. Premium arithmetic is
also checked against a second, independent implementation.

`source.verification` says how far a case can be trusted:
- `code_verified`: the code does this today, checked by an oracle (structure, formats, permissions, state transitions).
- `independently_verified`: the value comes from outside the code (the text drawn into a document fixture).
- `pending_domain_approval`: rests on a number the code itself calls a placeholder, demo or starting value (premium rates,
  tier amounts, knockout bands, the 20/80 split, delegated limits). The code's behaviour is reproduced; the business has not
  approved it. 21 of the 75 cases. Do not read these as approved insurance rules.
- `business_approved`: none yet. Nothing in the repository establishes one.

## Authoring format (cases/*.json)
A case is the GoldenCase schema plus four shorthands that `casekit.expand` resolves: `user` (a ref from
`tenant-sandbox-v1.json`: sets the actor, role and tenant), `messages` (list of strings; two or more make it multi-turn),
`layers` (which of L1 to L6 apply) and `pass`. `metadata` is required: `interface` (`chat`, `api`, `ocr`, `rules`), `env_mode`
(`strict`, `demo` or `any`: the services' `ENV_VAR` switch), and `truth`. Optional: `confirmations`
(`auto_approve`, `none`: whether the harness approves mutating-tool confirmations), `placeholder_rule`, `locale`.

## Conventions the harness will implement (Phase 4)
- `$customer.<ref>.id`, `$plan.<CODE>.id`, `$policy.<ref>.policy_number`: filled from the seeded fixtures. `{{date:today-4d}}`: a date relative to the run.
  Persons carry `dob_rule` (an age), so ages stay right whenever a case runs.
- Assertion targets: `response.text`; `result.*` (an API or rule result: `status_code`, `detail`, `body`, fields);
  `state.*` (what changed in the sandbox, e.g. `state.new_customers`, `state.policy.status`);
  `trace.executed_tools` / `trace.proposed_tools` / `trace.turn.N.*` / `trace.tool_calls.<tool>.arguments.*` (the last successful call);
  `routing.specialist` / `routing.skills`.
- Turns are numbered from 1: `trace.turn.1.*` and `state.turn.1.*` are the state and replies after the first user message.
  `response.text` of a multi-turn run is the final reply. The engine (`shared/evaluation/assertions.py`) and the verifier share
  this definition (`target_problems`), so a case that breaks it fails `verify_dataset.py`.
- Which targets a case may use: a chat case has `response`, `trace`, `state`, `routing` (and tool assertions); an `api`, `rules` or
  `ocr` case has `result`, `state` (and `trace.llm_calls`). A target the run did not produce is an error, never a pass. A key
  missing from an object the runner did write is *absent*: it equals null, and a tool that never ran has no
  `trace.tool_calls.<tool>`. So the runner must write every namespace an assertion starts with, and write `null` for a field it
  observed to be empty.
- `tool_called` / `tool_not_called` mean attempted after the permission gate: execution was tried (it may then have failed).
  A proposal still waiting for confirmation is `trace.proposed_tools`, and a call the gate refused is in neither list.
  `expected.tool_calls` lists the calls that must happen; it does not forbid others (assertions do), and the verifier requires
  every listed call to be asserted somewhere.
- `numeric_close` tolerance is an absolute amount. `refuses` is a keyword heuristic (English) and every result says so.
  A `no_leak` string must be real text from the source (a `source_contains` oracle shows it), not a phrase a good refusal
  might repeat.
- Writing cases: a title states only what the payload and assertions test (a boundary case tests one side; add a case for the
  other). Placeholders must exist in the fixtures. Run `python evals/tools/selftest.py` after changing the engine or the
  tools: it proves every rule above can fail, and runs the engine tests.
- On a list, `contains` means an element equals or contains the text. Cases run in an isolated sandbox tenant; none touches production data.
