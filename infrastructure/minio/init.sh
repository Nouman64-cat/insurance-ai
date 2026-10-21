#!/bin/sh
# Idempotent MinIO AIStor bootstrap for the audit archive. Runs once per `docker compose up` (safe to repeat).
# Creates: a PRIVATE bucket with versioning + Object Lock, and least-privilege identities:
#   audit-writer  put/get/list/retention, NO delete        audit-reader  get/list only
# The root credentials are used only here.
set -eu
: "${MINIO_ROOT_USER:?set MINIO_ROOT_USER in .env}" "${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD in .env}"
: "${AUDIT_ARCHIVE_WRITER_KEY:?set AUDIT_ARCHIVE_WRITER_KEY}" "${AUDIT_ARCHIVE_WRITER_SECRET:?set AUDIT_ARCHIVE_WRITER_SECRET}"
: "${AUDIT_ARCHIVE_READER_KEY:?set AUDIT_ARCHIVE_READER_KEY}" "${AUDIT_ARCHIVE_READER_SECRET:?set AUDIT_ARCHIVE_READER_SECRET}"
B="${AUDIT_ARCHIVE_BUCKET:-insurance-audit-archive}"
mc alias set local "${MINIO_ENDPOINT:-http://minio:9000}" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

# Object Lock can only be enabled when a bucket is created; --ignore-existing keeps a re-run harmless.
mc mb --with-lock --ignore-existing "local/$B"
mc version enable "local/$B" >/dev/null
mc anonymous set none "local/$B" >/dev/null

cat > /tmp/writer.json <<EOF2
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:GetObjectVersion","s3:PutObjectRetention","s3:GetObjectRetention","s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetBucketVersioning","s3:GetBucketObjectLockConfiguration"],
  "Resource":["arn:aws:s3:::$B","arn:aws:s3:::$B/*"]}]}
EOF2
cat > /tmp/reader.json <<EOF2
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion","s3:GetObjectRetention","s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetBucketVersioning","s3:GetBucketObjectLockConfiguration"],
  "Resource":["arn:aws:s3:::$B","arn:aws:s3:::$B/*"]}]}
EOF2
mc admin policy create local audit-writer /tmp/writer.json >/dev/null
mc admin policy create local audit-reader /tmp/reader.json >/dev/null
mc admin user add local "$AUDIT_ARCHIVE_WRITER_KEY" "$AUDIT_ARCHIVE_WRITER_SECRET" >/dev/null
mc admin user add local "$AUDIT_ARCHIVE_READER_KEY" "$AUDIT_ARCHIVE_READER_SECRET" >/dev/null
mc admin policy attach local audit-writer --user "$AUDIT_ARCHIVE_WRITER_KEY" >/dev/null 2>&1 || true
mc admin policy attach local audit-reader --user "$AUDIT_ARCHIVE_READER_KEY" >/dev/null 2>&1 || true

echo "bucket:   $B (private)"
mc version info "local/$B"
# Do not trust the creation flags: prove Object Lock works by locking a probe object, then removing it with the root bypass.
echo probe > /tmp/probe.txt
mc cp /tmp/probe.txt "local/$B/_probe/lock-check.txt" >/dev/null
if mc retention set governance 1d "local/$B/_probe/lock-check.txt" >/dev/null 2>&1; then
  echo "object lock: VERIFIED (retention applied to a probe object)"
else
  echo "object lock: NOT ENABLED on bucket $B -- it cannot be added later; recreate the bucket" >&2; exit 1
fi
mc rm --versions --force --bypass --recursive "local/$B/_probe/" >/dev/null
echo "identities: audit-writer (no delete), audit-reader (read-only)"

# ── Evaluation data lake (shared/evaluation): its own bucket and its own identity, nothing shared with the audit archive ──
# Skipped when EVAL_LAKE_ACCESS_KEY is not set, so an install that only uses the audit archive is unaffected.
# eval-lake-app: put/get/list/retention on the lake bucket. It may delete (with governance bypass) ONLY under _smoke/, which is
# what `eval_lake_cli.py smoke` uses; a published (Gold) object can never be deleted through this identity.
if [ -n "${EVAL_LAKE_ACCESS_KEY:-}" ]; then
  : "${EVAL_LAKE_SECRET_KEY:?set EVAL_LAKE_SECRET_KEY}"
  E="${EVAL_LAKE_BUCKET:-eval-lake}"
  mc mb --with-lock --ignore-existing "local/$E"
  mc version enable "local/$E" >/dev/null
  mc anonymous set none "local/$E" >/dev/null
  cat > /tmp/eval-lake.json <<EOF2
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:GetObjectVersion","s3:PutObjectRetention","s3:GetObjectRetention","s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetBucketVersioning","s3:GetBucketObjectLockConfiguration"],
  "Resource":["arn:aws:s3:::$E","arn:aws:s3:::$E/*"]},
 {"Effect":"Allow","Action":["s3:DeleteObject","s3:DeleteObjectVersion","s3:BypassGovernanceRetention"],
  "Resource":["arn:aws:s3:::$E/_smoke/*"]}]}
EOF2
  mc admin policy create local eval-lake-app /tmp/eval-lake.json >/dev/null
  mc admin user add local "$EVAL_LAKE_ACCESS_KEY" "$EVAL_LAKE_SECRET_KEY" >/dev/null
  mc admin policy attach local eval-lake-app --user "$EVAL_LAKE_ACCESS_KEY" >/dev/null 2>&1 || true
  echo "bucket:   $E (private)"
  mc version info "local/$E"
  echo probe > /tmp/eval-probe.txt
  mc cp /tmp/eval-probe.txt "local/$E/_probe/lock-check.txt" >/dev/null
  if mc retention set governance 1d "local/$E/_probe/lock-check.txt" >/dev/null 2>&1; then
    echo "object lock: VERIFIED on $E"
  else
    echo "object lock: NOT ENABLED on bucket $E -- it cannot be added later; recreate the bucket" >&2; exit 1
  fi
  mc rm --versions --force --bypass --recursive "local/$E/_probe/" >/dev/null
  echo "identity: eval-lake-app (no delete outside _smoke/)"
fi
