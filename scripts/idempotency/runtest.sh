#!/bin/sh
# Run unittest modules inside a service container against a THROWAWAY PostgreSQL database.
#
#   scripts/idempotency/runtest.sh insurance-tenant-service test_policy_payment_idempotency test_claim_register_idempotency
#   scripts/idempotency/runtest.sh insurance-tenant-service shared.idempotency.tests.test_postgres
#
# The container's POSTGRES_USER / POSTGRES_PASSWORD (must be allowed to create databases) create a random database,
# the tests run against it, and it is dropped afterwards. Your real data is never touched. No secrets are printed.
set -e
[ $# -ge 2 ] || { echo "usage: $0 <container> <unittest module>..." >&2; exit 2; }
CONTAINER=$1; shift
docker exec -e DISABLE_PGVECTOR=true -w /app "$CONTAINER" sh -c '
cat > /tmp/idem_db.py <<PY
import asyncio, os, sys, asyncpg
async def go(action, name):
    c = await asyncpg.connect(host="host.docker.internal", user=os.environ["POSTGRES_USER"],
                              password=os.environ["POSTGRES_PASSWORD"], database="postgres")
    if action == "create":
        await c.execute(f"CREATE DATABASE \"{name}\"")
    else:
        await c.execute(f"DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")
    await c.close()
asyncio.run(go(sys.argv[1], sys.argv[2]))
PY
NAME=idem_run_$(date +%s)
python /tmp/idem_db.py create "$NAME"
URL=$(NAME=$NAME python -c "
import os, urllib.parse as u
print(\"postgresql+asyncpg://%s:%s@host.docker.internal:5432/%s\" % (u.quote(os.environ[\"POSTGRES_USER\"], safe=\"\"), u.quote(os.environ[\"POSTGRES_PASSWORD\"], safe=\"\"), os.environ[\"NAME\"]))")
export IDEMPOTENCY_TEST_DATABASE_URL="$URL" DATABASE_URL="$URL"
STATUS=0
python -m unittest '"$*"' 2>&1 | grep -v "Deprecat\|utcnow\|^  " | tail -40 || STATUS=$?
python /tmp/idem_db.py drop "$NAME"
exit $STATUS'
