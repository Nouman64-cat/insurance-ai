"""
Memgraph applicant writer — persists evaluated applicants into the graph so the
fraud-ring detection queries in workflow.py have data to reason over.

Called fire-and-forget after every successful risk evaluation (SSE path in
main.py and Kafka path in consumer.py). Every Memgraph interaction is wrapped in
try/except: if the graph DB is unreachable the failure is logged and swallowed
so the evaluation pipeline is never blocked or crashed by a graph-DB outage.

Uses the synchronous neo4j driver (GraphDatabase.driver) with the same
connection config as workflow.py.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from neo4j import GraphDatabase

logger = logging.getLogger("risk-engine.graph_writer")

# ── Memgraph connection config (same env vars as workflow.py) ─────────────────

MEMGRAPH_URI  = os.getenv("MEMGRAPH_URI",      "bolt://memgraph:7687")
MEMGRAPH_USER = os.getenv("MEMGRAPH_USERNAME", "")
MEMGRAPH_PASS = os.getenv("MEMGRAPH_PASSWORD", "")


# ── Cypher ────────────────────────────────────────────────────────────────────

# Upsert the applicant node. MERGE (not CREATE) so re-evaluating the same CNIC
# within a tenant updates the node in place instead of duplicating it.
_UPSERT_NODE = """
MERGE (a:Applicant {cnic: $cnic, tenant_id: $tenant_id})
SET a.occupation        = $occupation,
    a.declared_income   = $declared_income,
    a.coverage_amount   = $coverage_amount,
    a.medical_score     = $medical_score,
    a.financial_score   = $financial_score,
    a.fraud_probability = $fraud_probability,
    a.evaluated_at      = $evaluated_at
"""

# Link applicants who share the same 5-digit CNIC prefix (same geographic area).
# Tenant-scoped on both sides so applicants from different tenants never link.
_LINK_SAME_AREA = """
MATCH (a:Applicant {cnic: $cnic, tenant_id: $tenant_id})
MATCH (b:Applicant)
WHERE b.cnic <> a.cnic
  AND b.tenant_id = a.tenant_id
  AND left(b.cnic, 5) = left($cnic, 5)
MERGE (a)-[:SAME_AREA]->(b)
MERGE (b)-[:SAME_AREA]->(a)
RETURN count(b) AS linked
"""

# Link applicants in the same occupation cluster within a tenant.
_LINK_SAME_OCCUPATION = """
MATCH (a:Applicant {cnic: $cnic, tenant_id: $tenant_id})
MATCH (b:Applicant)
WHERE b.cnic <> a.cnic
  AND b.tenant_id = a.tenant_id
  AND b.occupation = a.occupation
MERGE (a)-[:SAME_OCCUPATION_CLUSTER]->(b)
MERGE (b)-[:SAME_OCCUPATION_CLUSTER]->(a)
RETURN count(b) AS linked
"""


def write_applicant_to_graph(
    cnic: str,
    tenant_id: str,
    occupation: str,
    declared_income: float,
    coverage_amount: float,
    medical_score: int,
    financial_score: int,
    fraud_probability: float,
) -> None:
    """Persist an evaluated applicant (node + relationships) into Memgraph.

    Fire-and-forget: any connectivity or query failure is logged and swallowed
    so a Memgraph outage never blocks or crashes the evaluation pipeline.
    """
    try:
        evaluated_at = datetime.now(timezone.utc).isoformat()

        with GraphDatabase.driver(
            MEMGRAPH_URI, auth=(MEMGRAPH_USER, MEMGRAPH_PASS)
        ) as driver:
            driver.verify_connectivity()
            with driver.session() as session:
                # 1. Upsert the node before creating any relationships.
                session.run(
                    _UPSERT_NODE,
                    cnic=cnic,
                    tenant_id=tenant_id,
                    occupation=occupation,
                    declared_income=declared_income,
                    coverage_amount=coverage_amount,
                    medical_score=medical_score,
                    financial_score=financial_score,
                    fraud_probability=fraud_probability,
                    evaluated_at=evaluated_at,
                )
                logger.info("applicant %s written to Memgraph (tenant=%s)", cnic, tenant_id)

                # 2. Same-area links (shared 5-digit CNIC prefix).
                area_rec = session.run(
                    _LINK_SAME_AREA, cnic=cnic, tenant_id=tenant_id
                ).single()
                area_links = area_rec["linked"] if area_rec else 0
                logger.info("%s SAME_AREA relationships created (cnic=%s)", area_links, cnic)

                # 3. Same-occupation-cluster links.
                occ_rec = session.run(
                    _LINK_SAME_OCCUPATION, cnic=cnic, tenant_id=tenant_id
                ).single()
                occ_links = occ_rec["linked"] if occ_rec else 0
                logger.info(
                    "%s SAME_OCCUPATION_CLUSTER relationships created (cnic=%s)",
                    occ_links, cnic,
                )

    except Exception as exc:
        # Never let a Memgraph failure surface to the evaluation pipeline.
        logger.error("Memgraph write failed (cnic=%s): %s", cnic, exc)
