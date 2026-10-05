"""Shared underwriting domain logic — deterministic rules + pure data shapes.

This package is imported by three containers (tenant-service, risk-engine,
api-gateway — see docker-compose.yml's ./shared:/app/shared mounts) and must
stay free of FastAPI/SQLModel/DB dependencies so none of them need extra
plumbing just to read a threshold. Anything that touches a database session
belongs in the calling service (e.g. services/tenant-service/services/
underwriting_gate.py), not here.

Modules
-------
results.py             Pure Pydantic result/status shapes shared by callers.
occupation_hazard.py    Deterministic occupation -> hazard-level keyword map.
profile.py              UnderwritingProfile model + build_profile().
requirements_rules.py   Requirements Engine (what evidence a case needs).
verification.py         Declared-vs-evidenced cross-checks.
decision_rules.py       Final rule-based decision engine (brief §9).
"""
