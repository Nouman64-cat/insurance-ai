"""Inventory of every HTTP mutation handler and how it is (or is not yet) protected against duplicate execution.

    python scripts/idempotency/inventory.py            # writes docs/idempotency/coverage.json and prints a summary
    python scripts/idempotency/inventory.py --pending  # also lists handlers that still need a decision

Three sources are combined, in this order of authority:
  1. the code itself: a handler wrapped by one of the shared adapters is `INTEGRATED` (mechanism = the adapter);
  2. docs/idempotency/review.json: a reviewed decision for a handler (`NATURAL`, `NOT_APPLICABLE`, `DEFERRED`, `EXISTING`), with a reason and
     the tests that evidence it. Decisions never override what the code shows;
  3. everything else stays PENDING_REVIEW: no claim of coverage is made for it.
`observed` records signals the scanner found (row locks, existing keys, e-mail/network/upload calls, AI calls) to guide the review.
"""
import ast
import json
import sys
from pathlib import Path

ROOT = Path('microservices/backend-microservices')
ADAPTERS = {
    'database_operation': 'atomic receipt (business + outbox + receipt in one transaction)',
    'side_effect_operation': 'durable reservation, handler, then receipt (non-transactional side effects)',
    'workflow_operation': 'case-workflow receipt (ids only; overview rebuilt on replay)',
    'read_model_operation': 'atomic receipt rendered through the route read model',
    'notification_operation': 'notification receipt (never re-sent once completed)',
    'tenant_operation': 'atomic receipt (small tenant-scoped response, no personal data)',
    'sanitized_operation': 'atomic receipt with personal-data fields rebuilt on replay',
    '_claim_step': 'atomic receipt (claim workflow step; workspace rebuilt on replay)',
    '_claim_register_step': 'atomic receipt (claim register step; claim card rebuilt on replay)',
    '_family_confirm': 'atomic receipt (family enrolment; nominees rebuilt on replay)',
    'records_operation': 'atomic receipt (record ids only; response rebuilt from the records on replay)',
    'reviewed_operation': 'receipt of a reviewed non-personal response schema (atomic, or durable reservation when it also notifies)',
    'step_operation': 'workflow-step receipt (ids and small outcome facts; view rebuilt on replay)',
    'secret_link_operation': 'durable reservation; one-time links/passwords are never kept, recipients masked',
    'token_operation': 'public link-token endpoint; scope = digest of the link, link re-checked on every replay',
    'outcome_operation': 'durable reservation for a notifying action (masked outcome + rebuilt view)',
    'billing_operation': 'atomic receipt (premium ledger action; billing view rebuilt on replay)',
    '_upload_operation': 'durable reservation for a document upload (one object/row/OCR job per operation)',
    '_user_login_operation': 'durable reservation for a user-creating action (password e-mailed once, never stored)',
    '_source_login_operation': 'durable reservation for a login-issuing action (password e-mailed once, never stored)',
    '_group_issue_operation': 'atomic receipt (group scheme issuance/payment)',
    '_payment_request_operation': 'durable reservation (payment-request e-mail)',
    '_ipp_state_operation': 'durable reservation with domain evidence (initial premium state)',
    'required_uuid_header': 'header key mapped to the domain unique key',
}
SIGNALS = [('with_for_update', 'row lock'), ('on_conflict', 'conflict handling'), ('idempotency', 'existing idempotency reference'),
           ('processed_messages', 'message deduplication'), ('email_utils', 'sends e-mail'), ('send_email', 'sends e-mail'), ('httpx', 'network call'),
           ('UploadFile', 'file upload'), ('_upload_to_s3', 'object storage write'), ('FileResponse', 'file download'), ('StreamingResponse', 'streaming'),
           ('BackgroundTasks', 'background task'), ('create_task', 'background task'), ('payment_gateway', 'payment gateway'),
           (' llm', 'LLM'), ('llm_', 'LLM'), ('call_llm', 'LLM'), ('ChatAnthropic', 'LLM'), ('evaluate_risk', 'risk evaluation'), ('document_generator', 'renders a document')]


def deco_name(d):
    node = d.func if isinstance(d, ast.Call) else d
    while isinstance(node, ast.Call):
        node = node.func
    return node.id if isinstance(node, ast.Name) else (node.attr if isinstance(node, ast.Attribute) else '')


def scan():
    rows = []
    for file in sorted(ROOT.rglob('*.py')):
        if any(x in file.parts for x in ('__pycache__', 'shared', 'tests', 'seeds')) or file.name.startswith('test') or file.name == 'idem_testkit.py':
            continue
        text = file.read_text()
        try:
            tree = ast.parse(text)
        except (SyntaxError, UnicodeError):
            continue
        prefixes = {}
        for n in ast.walk(tree):
            if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and getattr(n.value.func, 'id', '') == 'APIRouter':
                for k in n.value.keywords:
                    if k.arg == 'prefix' and isinstance(k.value, ast.Constant):
                        for target in n.targets:
                            if isinstance(target, ast.Name):
                                prefixes[target.id] = k.value.value
        for n in ast.walk(tree):
            if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for d in n.decorator_list:
                if not isinstance(d, ast.Call) or not isinstance(d.func, ast.Attribute) or d.func.attr not in ('post', 'put', 'patch', 'delete'):
                    continue
                first = d.args[0] if d.args else None
                path = first.value if isinstance(first, ast.Constant) else '<dynamic>'
                prefix = prefixes.get(getattr(d.func.value, 'id', ''), '')
                segment = ast.get_source_segment(text, n) or ''
                signals = []
                for term, label in SIGNALS:
                    if term in segment and label not in signals:
                        signals.append(label)
                adapters = [deco_name(x) for x in n.decorator_list if deco_name(x) in ADAPTERS]
                operation = None
                for x in n.decorator_list:
                    if deco_name(x) in ADAPTERS and isinstance(x, ast.Call) and x.args and isinstance(x.args[0], ast.Constant):
                        operation = x.args[0].value
                rows.append(dict(
                    file=str(file), line=n.lineno, handler=n.name, method=d.func.attr.upper(), router_path=prefix + path,
                    observed=signals,
                    integration_status='INTEGRATED' if adapters else 'PENDING_REVIEW',
                    mechanism=ADAPTERS[adapters[0]] if adapters else None, operation=operation))
    return rows


def markdown(rows):
    """Human-readable matrix generated from the same rows as coverage.json (edit review.json, never this file)."""
    order = ['INTEGRATED', 'EXISTING', 'PROXY', 'NATURAL', 'NOT_APPLICABLE', 'DEFERRED']
    counts = {k: sum(1 for r in rows if r['integration_status'] == k) for k in order}
    untested = sum(1 for r in rows if r.get('untested'))
    out = ['# Idempotency coverage matrix', '',
           'Generated by `python3 scripts/idempotency/inventory.py` from the code (adapters found on each handler) and '
           '`docs/idempotency/review.json` (reasoned decisions). Do not edit by hand; `scripts/idempotency/test_coverage.py` fails when it is stale.', '',
           f'{len(rows)} HTTP mutation handlers.', '', '| Status | Handlers | Meaning |', '| --- | ---: | --- |']
    meaning = {'INTEGRATED': 'Wrapped by a shared adapter (a keyed request is deduplicated, replayed, or refused on conflict)',
               'EXISTING': 'Already protected by the owning service\'s own durable mechanism (or forwards the key to the service that is)',
               'PROXY': 'API-gateway hop; forwards the key and the replay headers to the protected service',
               'NATURAL': 'Naturally idempotent (overwrite, delete, state-guarded or converging sweep)',
               'NOT_APPLICABLE': 'Read-only, preview, stateless compute, conversation or credential flow',
               'DEFERRED': 'Known gap, named with a reason'}
    for k in order:
        out.append(f'| {k} | {counts[k]} | {meaning[k]} |')
    out += ['', f'Of the {counts["INTEGRATED"]} integrated handlers, {untested} do not yet have a route-level keyed test (flagged `untested` in coverage.json); the money paths all do.', '']
    by_file = {}
    for r in rows:
        by_file.setdefault(str(Path(r['file']).relative_to(ROOT)), []).append(r)
    for file in sorted(by_file):
        out += [f'## {file}', '', '| Endpoint | Handler | Status | Mechanism / reason | Tests |', '| --- | --- | --- | --- | --- |']
        for r in sorted(by_file[file], key=lambda x: x['line']):
            why = (r.get('mechanism') or r.get('reason') or '').replace('|', '/')
            tests = '<br>'.join(Path(t).name for t in r.get('tests', [])) or ('**untested**' if r.get('untested') else '')
            out.append(f"| {r['method']} `{r['router_path']}` | {r['handler']} | {r['integration_status']} | {why} | {tests} |")
        out.append('')
    return '\n'.join(out)


def build():
    """The matrix: the scan of the code with the reviewed overlay applied. Returns (rows, review)."""
    rows = scan()
    review_path = Path('docs/idempotency/review.json')
    review = json.loads(review_path.read_text()) if review_path.exists() else {}
    for r in rows:
        key = f"{Path(r['file']).relative_to(ROOT)}::{r['handler']}"
        decision = review.get(key)
        r['review_key'] = key
        if r['integration_status'] == 'INTEGRATED':
            # Tests come from the handler's own entry, else from the file-level default ("@file:<path>") in review.json.
            if (decision or {}).get('untested'):
                r['tests'], r['untested'] = [], True       # integrated, but no route-level keyed test yet: reported, never hidden
            else:
                r['tests'] = (decision or {}).get('tests') or review.get('@file:' + str(Path(r['file']).relative_to(ROOT)), {}).get('tests', [])
        elif decision:
            r['integration_status'] = decision['status']
            r['mechanism'] = decision.get('mechanism')
            r['reason'] = decision['reason']
            r['tests'] = decision.get('tests', [])
    return rows, review


def main():
    rows, review = build()
    Path('docs/idempotency').mkdir(parents=True, exist_ok=True)
    Path('docs/idempotency/coverage.json').write_text(json.dumps(rows, indent=2) + '\n')
    Path('docs/idempotency/COVERAGE.md').write_text(markdown(rows))
    counts = {}
    for r in rows:
        counts[r['integration_status']] = counts.get(r['integration_status'], 0) + 1
    print(f'Inventoried {len(rows)} mutation handlers; router mount prefixes may apply')
    for status, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f'  {status:16} {n}')
    stale = [k for k in review if not k.startswith('@file:') and k not in {r['review_key'] for r in rows}]
    if stale:
        print('  review entries with no matching handler:', stale)
    if '--pending' in sys.argv:
        for r in rows:
            if r['integration_status'] == 'PENDING_REVIEW':
                print(f"{r['review_key']:70} {r['method']:6} {r['router_path'][:60]:60} {','.join(r['observed'])}")


if __name__ == '__main__':
    main()
