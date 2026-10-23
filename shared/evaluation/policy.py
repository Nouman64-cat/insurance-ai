"""Which cases may become authoritative Gold data.

A case records how far its expected value has been verified (`source.verification`). Two things are different and are kept
apart everywhere (command line, API, page):

  technical verification   `source.verification`: code_verified, independently_verified, business_approved, or
                           pending_domain_approval (the code's behaviour is reproduced, but it rests on a number the code itself
                           calls a placeholder, so nobody has said it is the right rule);
  review approval          the Silver `status` (draft, in_review, approved ...): a person looked at the case.

Review approval alone does not make a pending_domain_approval case authoritative: it stays in the editable working set
and is left out of bulk approval and of publication until the business confirms the rule (the case is edited to
`business_approved`, which is a new revision that is reviewed like any other change).
"""
from __future__ import annotations

from typing import Any, Dict

UNCONFIRMED = "pending_domain_approval"


def verification_of(content: Dict[str, Any]) -> str:
    """The technical verification a case claims (empty when it names none)."""
    source = content.get("source") if isinstance(content, dict) else None
    return (source or {}).get("verification") or ""


def is_unconfirmed(content: Dict[str, Any]) -> bool:
    """True when the case rests on a rule the business has not confirmed, so it is not authoritative."""
    return verification_of(content) == UNCONFIRMED
