#!/bin/sh
# Accept a license string from .env, or a read-only mounted license file.
set -eu
root_password="${MINIO_ROOT_PASSWORD:-}"
if [ -z "${MINIO_ROOT_USER:-}" ] || [ "${#root_password}" -lt 16 ]; then
    echo 'Set MINIO_ROOT_USER and a MINIO_ROOT_PASSWORD of at least 16 characters in .env.' >&2
    exit 1
fi
license_file="${MINIO_LICENSE:-/run/license/minio.license}"
if [ -n "${AISTOR_LICENSE_KEY:-}" ]; then
    umask 077
    license_file="$(mktemp /tmp/minio-license.XXXXXX)"
    printf '%s\n' "$AISTOR_LICENSE_KEY" > "$license_file"
    unset AISTOR_LICENSE_KEY
elif [ ! -s "$license_file" ]; then
    echo 'Set AISTOR_LICENSE_KEY in .env, or set AISTOR_LICENSE_FILE to an existing license file. Leave AISTOR_LICENSE_FILE blank when using a key.' >&2
    exit 1
fi
export MINIO_LICENSE="$license_file"
exec minio server /data --address :9000 --console-address :9001 --license "$license_file"
