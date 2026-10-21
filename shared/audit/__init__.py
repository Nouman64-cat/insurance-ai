"""Shared audit contract, sanitizer, request context and transactional-outbox helpers.

Producers import from here; the Audit Service (microservices/backend-microservices/audit-service) owns the ledger.
"""
