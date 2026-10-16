"""Claims catalog and non-destructive importer regressions; no live database writes."""
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from datetime import datetime
from uuid import uuid4

from seeds.insurance_plan_claims_seed import DATA_PATH, claims_terms_for, import_terms, validate_catalog
from seeds.insurance_plans_seed import INSURANCE_PLAN_SEED_DATA


class ClaimsCatalogTests(unittest.TestCase):
    def test_covers_exactly_existing_retail_seed_catalog(self):
        data = json.loads(DATA_PATH.read_text())
        validate_catalog(data)
        self.assertEqual(set(data["plans"]), {p["code"] for p in INSURANCE_PLAN_SEED_DATA if p["category"] == "Individual"})
        self.assertIsNone(claims_terms_for("GROUP_LIFE"))
        self.assertIsNone(claims_terms_for("CUSTOM"))

    def test_waiting_periods_do_not_cross_plan_or_event_boundaries(self):
        self.assertEqual(claims_terms_for("PROTECT_PLAN")["waiting_periods"][0]["days"], 90)
        self.assertEqual(claims_terms_for("SEHAT_KAFALAT")["waiting_periods"][0]["days"], 15)
        self.assertEqual(claims_terms_for("NIGRAAN")["waiting_periods"][0]["days"], 0)
        self.assertIsNone(claims_terms_for("APNA_SAVINGS")["waiting_periods"])
        covid = claims_terms_for("COVID19_PROTECTION_PLAN")
        self.assertEqual([(p["days"], p["applies_to"]) for p in covid["waiting_periods"]], [(14, "covid_cover"), (15, "consecutive_hospitalizations")])

    def test_base_benefits_and_optional_riders_remain_distinct(self):
        salary = claims_terms_for("SALARY_PROTECTION_PLAN")
        self.assertEqual({b["event"] for b in salary["benefits"]}, {"death", "permanent_total_disability"})
        self.assertTrue(all(b["scope"] == "base" for b in salary["benefits"]))
        apna = claims_terms_for("APNA_SAVINGS")
        self.assertEqual([b["event"] for b in apna["benefits"] if b["scope"] == "optional_rider"], ["accidental_death_disability", "waiver_disability"])
        self.assertIsNone(apna["exclusions"])
        self.assertIsNone(apna["notification"])

    def test_provenance_and_reference_only_contract_are_enforced(self):
        for mutation in (lambda t: t.update(operational_adjudication_enabled=True),
                         lambda t: t["benefits"][0].update(source_ids=["invented"]),
                         lambda t: t["sources"][0].update(url="https://example.com/brochure.pdf")):
            data = json.loads(DATA_PATH.read_text())
            mutation(data["plans"]["APNA_SAVINGS"])
            with self.assertRaises(ValueError):
                validate_catalog(data)

    def test_terms_are_independent_and_do_not_change_existing_seed_rules(self):
        one = claims_terms_for("APNA_SAVINGS")
        one["benefits"].clear()
        self.assertTrue(claims_terms_for("APNA_SAVINGS")["benefits"])
        for p in INSURANCE_PLAN_SEED_DATA:
            if p["category"] == "Individual":
                self.assertEqual(p["claims_terms"], claims_terms_for(p["code"]))


class FakeSession:
    def __init__(self, tenants, plans):
        self.results = iter([tenants, plans])
        self.committed = False
        self.added = []
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def exec(self, stmt):
        return SimpleNamespace(all=lambda: next(self.results))
    def add(self, row): self.added.append(row)
    async def commit(self): self.committed = True


class ClaimsImportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tenant = SimpleNamespace(id=uuid4(), name="Test tenant")
        def plan(code, claims=None, insurer="Adamjee Life Assurance Co. Ltd."):
            return SimpleNamespace(id=uuid4(), tenant_id=self.tenant.id, code=code,
                                   claims_terms=claims, surrender_terms={"insurer": insurer},
                                   updated_at=datetime(2026, 1, 1), base_premium_rate=3.5)
        self.target = plan("APNA_SAVINGS")
        self.manual = plan("APNA_SAVINGS", {"manual": True})
        self.unrelated = plan("GROUP_LIFE")
        self.other_insurer = plan("APNA_SAVINGS", insurer="Other insurer")
        self.current = plan("APNA_SAVINGS", claims_terms_for("APNA_SAVINGS"))
        self.plans = [self.target, self.manual, self.unrelated, self.other_insurer, self.current]

    async def run_import(self, apply=False, backup=None):
        session = FakeSession([self.tenant], self.plans)
        with patch("database._session_factory", return_value=session):
            result = await import_terms([self.tenant.id], all_tenants=False, apply=apply, backup=backup)
        return result, session

    async def test_dry_run_preserves_every_row(self):
        before = deepcopy([vars(p) for p in self.plans])
        summary, session = await self.run_import()
        self.assertEqual(summary["updates"], 1)
        self.assertEqual(summary["unchanged"], 1)
        self.assertEqual(summary["unrelated_plans_skipped"], 2)
        self.assertEqual(summary["preserved_existing"], ["APNA_SAVINGS"])
        self.assertEqual([vars(p) for p in self.plans], before)
        self.assertFalse(session.committed)

    async def test_apply_backs_up_and_changes_only_claims_and_timestamp(self):
        before = deepcopy([vars(p) for p in self.plans])
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "before.json"
            summary, session = await self.run_import(True, path)
            self.assertEqual(summary["updates"], 1)
            self.assertTrue(session.committed)
            self.assertIsNone(json.loads(path.read_text())["rows"][0]["claims_terms"])
            self.assertEqual(self.target.claims_terms, claims_terms_for("APNA_SAVINGS"))
            self.assertEqual(self.target.base_premium_rate, before[0]["base_premium_rate"])
            self.assertEqual(self.target.surrender_terms, before[0]["surrender_terms"])
            self.assertEqual([vars(p) for p in self.plans[1:]], before[1:])
            repeated, _ = await self.run_import(True, path)
            self.assertEqual(repeated["updates"], 0)

    async def test_no_write_without_backup_and_no_overwriting_backup(self):
        with self.assertRaises(ValueError): await self.run_import(True)
        self.assertIsNone(self.target.claims_terms)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "before.json"
            path.write_text("existing")
            with self.assertRaises(FileExistsError): await self.run_import(True, path)
            self.assertEqual(path.read_text(), "existing")
            self.assertIsNone(self.target.claims_terms)


if __name__ == "__main__":
    unittest.main()
