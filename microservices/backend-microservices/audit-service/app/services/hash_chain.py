"""Compatibility alias: the hash-chain implementation lives in shared/audit/hashing.py so the independent checkpoint signer
recomputes chains with exactly the same code."""
from shared.audit.hashing import *  # noqa: F401,F403
from shared.audit.hashing import __all__  # noqa: F401
