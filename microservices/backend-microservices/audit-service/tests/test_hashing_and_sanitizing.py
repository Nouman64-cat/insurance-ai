"""Pure unit tests: canonical hashing and payload sanitizing (no database)."""
import hashlib
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from uuid import UUID, uuid4

from app.services import hash_chain
from shared.audit.sanitize import OMITTED, REDACTED, sanitize, sanitize_mapping
from shared.audit.schema import AuditIntent

CHAIN = "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222"
GENESIS = hash_chain.genesis_hash(CHAIN)


def record(**overrides):
    base = dict(
        event_id=UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), tenant_id=UUID("22222222-2222-2222-2222-222222222222"),
        environment_id=UUID("11111111-1111-1111-1111-111111111111"),
        occurred_at=datetime(2026, 10, 20, 12, 0, 0, 123456, tzinfo=timezone.utc),
        recorded_at=datetime(2026, 10, 20, 12, 0, 1, tzinfo=timezone.utc),
        actor_id="u1", actor_type="USER", actor_role="Admin", service_name="tenant-service", module="policies",
        action="policy.issued", entity_type="policy", entity_id="P1", case_id=None, correlation_id="c1",
        source_event_id="s1", previous_value=None, new_value={"status": "Active", "premium": "1500.5"},
        outcome="SUCCESS", metadata={"k": [1, 2, {"z": True}]},
    )
    base.update(overrides)
    return base


class HashingTests(unittest.TestCase):
    def test_genesis_is_deterministic_and_bound_to_the_chain(self):
        self.assertEqual(GENESIS, hashlib.sha256(b"insurance-ai/audit-genesis/v1\x00" + CHAIN.encode()).hexdigest())
        self.assertNotEqual(GENESIS, hash_chain.genesis_hash(CHAIN + "x"))

    def test_same_input_same_hash(self):
        a = hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record())
        b = hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record())
        self.assertEqual(a, b)
        self.assertRegex(a, r"^[0-9a-f]{64}$")

    def test_key_order_and_timezone_representation_do_not_matter(self):
        a = hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(new_value={"a": 1, "b": 2}))
        b = hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(new_value={"b": 2, "a": 1}))
        self.assertEqual(a, b)
        plus5 = timezone(timedelta(hours=5))
        local = datetime(2026, 10, 20, 17, 0, 0, 123456, tzinfo=plus5)
        c = hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(occurred_at=local))
        self.assertEqual(hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record()), c)

    def test_every_hashed_field_changes_the_hash(self):
        base = hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record())
        changes = dict(
            tenant_id=uuid4(), environment_id=uuid4(), actor_id="u2", actor_type="SYSTEM", actor_role="Agent",
            service_name="other", module="claims", action="policy.cancelled", entity_type="claim", entity_id="P2",
            case_id="C1", correlation_id="c2", source_event_id="s2", previous_value={"x": 1}, new_value={"status": "Lapsed"},
            outcome="FAILURE", metadata={}, event_id=uuid4(),
            occurred_at=datetime(2026, 10, 20, 12, 0, 0, 123457, tzinfo=timezone.utc),
            recorded_at=datetime(2026, 10, 20, 12, 0, 2, tzinfo=timezone.utc),
        )
        for field, value in changes.items():
            with self.subTest(field=field):
                self.assertNotEqual(base, hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(**{field: value})))

    def test_chain_position_is_part_of_the_hash(self):
        base = hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record())
        self.assertNotEqual(base, hash_chain.compute_event_hash(CHAIN, 2, GENESIS, record()))
        self.assertNotEqual(base, hash_chain.compute_event_hash(CHAIN, 1, "0" * 64, record()))
        self.assertNotEqual(base, hash_chain.compute_event_hash(CHAIN + "x", 1, GENESIS, record()))

    def test_unicode_is_stable(self):
        a = hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(new_value={"name": "علی احمد", "emoji": "✓"}))
        self.assertEqual(a, hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(new_value={"emoji": "✓", "name": "علی احمد"})))

    def test_values_without_a_canonical_form_are_refused(self):
        for bad in (1.5, Decimal("1.5"), object()):
            with self.subTest(value=bad), self.assertRaises(hash_chain.CanonicalizationError):
                hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(new_value={"x": bad}))
        with self.assertRaises(hash_chain.CanonicalizationError):
            hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(occurred_at=datetime(2026, 1, 1)))
        with self.assertRaises(hash_chain.CanonicalizationError):
            hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(new_value={1: "x"}))

    def test_unknown_hash_version_is_refused(self):
        with self.assertRaises(hash_chain.CanonicalizationError):
            hash_chain.compute_event_hash(CHAIN, 1, GENESIS, record(), hash_version=99)

    def test_timestamp_format_is_fixed_width_utc(self):
        self.assertEqual(hash_chain.format_timestamp(datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)), "2026-01-02T03:04:05.000000Z")

    def test_chain_id_derivation(self):
        env, tenant = uuid4(), uuid4()
        self.assertEqual(hash_chain.chain_id_for(env, tenant), f"{env}:{tenant}")
        self.assertEqual(hash_chain.chain_id_for(env, None), f"{env}:platform")


class Colour(Enum):
    RED = "red"


class SanitizerTests(unittest.TestCase):
    def test_credentials_are_redacted_by_key(self):
        out = sanitize({"password": "hunter2", "new_password": "x", "hashed_password": "$2b$", "access_token": "abc", "refreshToken": "r",
                        "api_key": "k", "apiKey": "k", "private_key": "pk", "Authorization": "Bearer x", "otp": "123456",
                        "card_number": "4111111111111111", "cvv": "123", "client_secret": "s", "token_hash": "t",
                        "api_key_encrypted": "enc", "session_id": "sid"})
        self.assertTrue(all(v == REDACTED for v in out.values()), out)

    def test_usage_metrics_that_mention_tokens_are_kept(self):
        out = sanitize({"total_tokens": 10, "input_tokens": 4, "output_tokens": 6, "token_count": 3})
        self.assertEqual(out, {"total_tokens": 10, "input_tokens": 4, "output_tokens": 6, "token_count": 3})

    def test_personal_identifiers_are_masked_or_redacted(self):
        out = sanitize({"cnic": "35202-1234567-1", "phone": "03001234567", "contact_email": "ali@example.com",
                        "date_of_birth": "1990-01-01", "address": "12 Street", "claimant_cnic": "42101-7654321-9"})
        self.assertEqual(out["cnic"], "*****-*******-1")
        self.assertEqual(out["phone"], "***567")
        self.assertEqual(out["contact_email"], "a***@example.com")
        self.assertEqual(out["date_of_birth"], REDACTED)
        self.assertEqual(out["address"], REDACTED)
        self.assertEqual(out["claimant_cnic"], "*****-*******-9")
        self.assertNotIn("3520", str(out))

    def test_raw_medical_and_document_content_is_omitted(self):
        out = sanitize({"ocr_result": "patient has ...", "extracted_text": "x", "results_json": {"hba1c": 9}, "diagnosis": "d",
                        "file_content": "zz", "abnormal_findings": ["a"], "status": "ok"})
        self.assertEqual({k: v for k, v in out.items() if k != "status"}, {k: OMITTED for k in out if k != "status"})
        self.assertEqual(out["status"], "ok")

    def test_blobs_and_bytes_are_never_stored(self):
        self.assertEqual(sanitize({"x": b"\x00\x01"})["x"], "[binary 2 bytes]")
        self.assertEqual(sanitize({"note": "data:image/png;base64," + "A" * 400})["note"], OMITTED)
        import base64, os
        self.assertEqual(sanitize({"scan": base64.b64encode(os.urandom(600)).decode()})["scan"], OMITTED)
        self.assertNotEqual(sanitize({"note": "word " * 200})["note"], OMITTED)

    def test_values_become_canonical_json_types(self):
        out = sanitize({"f": 0.1, "d": Decimal("12.50"), "big": 10 ** 20, "u": UUID(int=1), "e": Colour.RED, "nan": float("nan"),
                        "t": datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc), "s": {3, 1, 2}, "b": True, "n": None})
        self.assertEqual(out["f"], "0.1")
        self.assertEqual(out["d"], "12.5")
        self.assertEqual(out["big"], 10 ** 20)
        self.assertEqual(out["u"], "00000000-0000-0000-0000-000000000001")
        self.assertEqual(out["e"], "red")
        self.assertEqual(out["nan"], "NaN")
        self.assertEqual(out["t"], "2026-01-01T00:00:00.000000Z")
        self.assertEqual(out["s"], [1, 2, 3])
        self.assertIs(out["b"], True)
        self.assertIsNone(out["n"])
        hash_chain.canonical_bytes(out)  # whatever comes out can be hashed

    def test_nul_bytes_long_text_and_depth_are_bounded(self):
        out = sanitize({"a": "x\x00y", "long": "z" * 5000})
        self.assertEqual(out["a"], "xy")
        self.assertIn("truncated 4500 chars", out["long"])
        deep: dict = {}
        node = deep
        for _ in range(20):
            node["n"] = {}
            node = node["n"]
        hash_chain.canonical_bytes(sanitize(deep))
        self.assertLessEqual(len(sanitize({"k": list(range(1000))})["k"]), 101)

    def test_oversized_mappings_are_summarised(self):
        out = sanitize_mapping({f"field_{i}": "lorem ipsum dolor " * 22 for i in range(100)})
        self.assertTrue(out.get("_truncated"))
        self.assertLess(len(str(out)), 16_384)

    def test_sanitizing_is_idempotent(self):
        once = sanitize({"cnic": "35202-1234567-1", "password": "p", "n": 1.5, "nested": {"phone": "03001234567"}})
        self.assertEqual(sanitize(once), once)

    def test_intent_sanitizes_its_payloads_on_construction(self):
        i = AuditIntent(source_service="s", source_event_id="1", module="m", action="a.b", entity_type="e",
                        previous_value={"password": "x"}, new_value={"cnic": "35202-1234567-1", "amount": 12.5}, metadata={"token": "t"})
        self.assertEqual(i.previous_value, {"password": REDACTED})
        self.assertEqual(i.new_value, {"cnic": "*****-*******-1", "amount": "12.5"})
        self.assertEqual(i.metadata, {"token": REDACTED})

    def test_intent_validates_enums_and_normalises_time(self):
        i = AuditIntent(source_service="s", source_event_id="1", module="m", action="a", entity_type="e",
                        occurred_at=datetime(2026, 1, 1, 5, 0), outcome="denied", actor_type="user")
        self.assertEqual((i.outcome, i.actor_type, i.occurred_at.tzinfo), ("DENIED", "USER", timezone.utc))
        with self.assertRaises(ValueError):
            AuditIntent(source_service="s", source_event_id="1", module="m", action="a", entity_type="e", outcome="MAYBE")


if __name__ == "__main__":
    unittest.main()
