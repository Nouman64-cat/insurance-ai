"""Compose supplies a shared connection address and a service-private password."""
import os
from urllib.parse import urlsplit, urlunsplit, quote, unquote


def runtime_dsn():
    value = os.getenv('DOCS_FORGERY_DATABASE_URL', '').replace('postgresql+asyncpg://','postgresql://',1)
    if not value:
        raise ValueError('Document result storage is not configured')
    parsed = urlsplit(value)
    if parsed.scheme not in ('postgresql','postgres') or not parsed.username or not parsed.hostname or not parsed.path.strip('/'):
        raise ValueError('Document result storage connection is invalid')
    # Existing complete URLs remain supported for deployments and test databases.
    if parsed.password is not None:
        return value
    password = os.getenv('DOCS_FORGERY_DB_PASSWORD','')
    if not password:
        raise ValueError('The private document storage password is not configured')
    host=parsed.hostname
    if ':' in host: host='['+host+']'
    if parsed.port: host+=':'+str(parsed.port)
    authority=quote(unquote(parsed.username),safe='')+':'+quote(password,safe='')+'@'+host
    return urlunsplit(parsed._replace(netloc=authority))
