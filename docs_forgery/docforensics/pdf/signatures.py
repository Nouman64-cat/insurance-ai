"""Digital signature integrity via pyHanko.

Integrity (has the signed content changed?) is cryptographic and certain.
Trust (does the certificate really belong to the bank?) needs a trust list for
your region and is not decided here; the signer and issuer are reported so a
reviewer or a later rule can check them.
"""

from __future__ import annotations

import io
import logging

from ..report import Category, Finding, Severity

logging.getLogger("pyhanko").setLevel(logging.CRITICAL)


def _name(cert) -> str:
    try:
        return cert.subject.human_friendly
    except Exception:
        return "unknown"


def check_signatures(data: bytes) -> tuple[list[Finding], list[str]]:
    if b"/Sig" not in data and b"/ByteRange" not in data:
        return [], []
    try:
        from pyhanko.pdf_utils.reader import PdfFileReader
        from pyhanko.sign.validation import validate_pdf_signature
        from pyhanko.sign.validation.status import SignatureCoverageLevel
        from pyhanko.sign.diff_analysis import ModificationLevel
        from pyhanko_certvalidator import ValidationContext
    except ImportError:
        return [], ["signatures: pyhanko not installed, signatures not checked"]

    findings: list[Finding] = []
    errors: list[str] = []
    try:
        reader = PdfFileReader(io.BytesIO(data), strict=False)
        signatures = list(reader.embedded_signatures)
    except Exception as exc:
        return [], [f"signatures: could not read signature fields: {exc}"]

    for sig in signatures:
        field = sig.field_name or "unnamed"
        try:
            vc = ValidationContext(allow_fetching=False, trust_roots=[])
            status = validate_pdf_signature(sig, signer_validation_context=vc)
        except Exception as exc:
            findings.append(Finding(
                "SIGNATURE_UNVERIFIABLE", Severity.MEDIUM, Category.TAMPERING,
                f"Digital signature '{field}' could not be verified",
                "The signature is malformed or uses an unsupported format, so its integrity is unknown.",
                {"field": field, "error": str(exc)[:300]},
            ))
            continue

        cert = status.signing_cert
        signer, issuer = _name(cert), (cert.issuer.human_friendly if cert is not None else "unknown")
        self_signed = getattr(cert, "self_signed", "no") if cert is not None else "unknown"
        evidence = {"field": field, "signer": signer, "issuer": issuer, "self_signed": str(self_signed),
                    "coverage": status.coverage.name if status.coverage else None,
                    "signed_at": str(status.signer_reported_dt) if status.signer_reported_dt else None}

        if not status.intact:
            findings.append(Finding(
                "SIGNATURE_BROKEN", Severity.CRITICAL, Category.TAMPERING,
                f"Digital signature '{field}' is broken",
                f"The bytes signed by {signer} no longer match the signature, so the signed content was altered.",
                evidence,
            ))
            continue

        level = getattr(status, "modification_level", None)
        if status.coverage == SignatureCoverageLevel.ENTIRE_FILE:
            findings.append(Finding(
                "SIGNATURE_INTACT", Severity.INFO, Category.AUTHENTICITY,
                f"Document is unchanged since it was signed by {signer}",
                "The signature covers the whole file and matches it. Check that the signer is the institution "
                "that issued the document"
                + (" — the certificate is self-signed, so anyone could have made it." if self_signed == "yes" else "."),
                evidence,
            ))
        elif (level is not None and level >= ModificationLevel.OTHER) or status.docmdp_ok is False:
            findings.append(Finding(
                "MODIFIED_AFTER_SIGNING", Severity.CRITICAL, Category.TAMPERING,
                f"Document was changed after it was signed by {signer}",
                "The signed version is intact, but later saves changed page content rather than only adding "
                "signatures, form values or annotations.",
                {**evidence, "modification_level": level.name if level is not None else None},
            ))
        else:
            findings.append(Finding(
                "SIGNATURE_INTACT_WITH_ADDITIONS", Severity.LOW, Category.AUTHENTICITY,
                f"Signature by {signer} is intact; later saves only added annotations or form data",
                "The signed content is unchanged. Items added afterwards (comments, stamps, form values) are not covered by the signature.",
                {**evidence, "modification_level": level.name if level is not None else None},
            ))
    return findings, errors
