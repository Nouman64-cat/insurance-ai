import ast, json
from pathlib import Path
rows=[]
for file in sorted(Path('microservices/backend-microservices').rglob('*.py')):
    if any(x in file.parts for x in ('__pycache__','shared','tests')) or file.name.startswith('test'): continue
    try: tree=ast.parse(file.read_text())
    except (SyntaxError,UnicodeError): continue
    prefixes={}
    for n in ast.walk(tree):
        if isinstance(n,ast.Assign) and isinstance(n.value,ast.Call) and getattr(n.value.func,'id','')=='APIRouter':
            for k in n.value.keywords:
                if k.arg=='prefix' and isinstance(k.value,ast.Constant):
                    for target in n.targets:
                        if isinstance(target,ast.Name): prefixes[target.id]=k.value.value
    for n in ast.walk(tree):
        if not isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)): continue
        for d in n.decorator_list:
            if not isinstance(d,ast.Call) or not isinstance(d.func,ast.Attribute) or d.func.attr not in ('post','put','patch','delete'):continue
            path=d.args[0].value if d.args and isinstance(d.args[0],ast.Constant) else '<dynamic>'
            prefix=prefixes.get(getattr(d.func.value,'id',''),'')
            segment=ast.get_source_segment(file.read_text(),n) or ''
            evidence=[]
            for term,label in [('with_for_update','row lock'),('idempotency','existing idempotency reference'),('on_conflict','conflict handling'),('processed_messages','message deduplication')]:
                if term in segment.lower(): evidence.append(label)
            integrated = any(isinstance(dec, ast.Call) and getattr(dec.func, 'id', '') == 'database_operation' for dec in n.decorator_list)
            rows.append(dict(file=str(file), line=n.lineno, handler=n.name, method=d.func.attr.upper(),
                router_path=prefix+path, observed_protection='; '.join(evidence) or 'not established',
                integration_status='SHARED_DATABASE_ADAPTER' if integrated else 'PENDING_REVIEW',
                test_status='See README test evidence; endpoint coverage not inferred'))
Path('docs/idempotency').mkdir(parents=True, exist_ok=True)
Path('docs/idempotency/coverage.json').write_text(json.dumps(rows, indent=2) + '\n')
print(f'Inventoried {len(rows)} mutation handlers; router mount prefixes may apply')
