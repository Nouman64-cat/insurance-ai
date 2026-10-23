"""Coverage guard: the idempotency matrix must be current, fully reviewed, and honest about tests.

Run from the repository root:  python3 -m unittest scripts.idempotency.test_coverage
(or  python3 scripts/idempotency/test_coverage.py). No services or database needed.
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'idempotency'))
import os
os.chdir(ROOT)
import inventory  # noqa: E402

# P0 money paths: every mutation handler in these files must be integrated AND covered by a route-level keyed test.
P0_FILES = ('tenant-service/routers/policies.py', 'tenant-service/routers/initial_premium_payment.py', 'tenant-service/routers/commissions.py',
            'tenant-service/routers/commission_disbursements.py',
            'tenant-service/routers/claim_workflow.py')
P0_HANDLERS = {'tenant-service/routers/customer_portal_internal.py::pay_installment', 'tenant-service/routers/customer_portal_internal.py::request_surrender',
               'tenant-service/routers/customer_portal_internal.py::intimate_claim',
               'tenant-service/routers/claims.py::create_claim', 'tenant-service/routers/claims.py::update_claim_status',
               'tenant-service/routers/claims.py::adjudicate_claim', 'tenant-service/routers/claims.py::create_claim_payout',
               'tenant-service/routers/post_issuance.py::collect_installment', 'tenant-service/routers/post_issuance.py::bulk_collect',
               'tenant-service/routers/group_policies.py::issue_master_policy', 'tenant-service/routers/group_policies.py::record_group_payment',
               'tenant-service/routers/group_claims.py::group_payout'}
FINAL = {'INTEGRATED', 'NATURAL', 'NOT_APPLICABLE', 'EXISTING', 'PROXY', 'DEFERRED'}


class Matrix(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows, cls.review = inventory.build()

    def test_every_mutation_handler_has_a_final_decision(self):
        pending = [r['review_key'] for r in self.rows if r['integration_status'] not in FINAL]
        self.assertEqual(pending, [], 'unreviewed mutation endpoints: add an adapter or a reasoned entry in docs/idempotency/review.json')

    def test_every_exemption_has_a_reason_and_deferred_ones_are_few_and_named(self):
        for r in self.rows:
            if r['integration_status'] != 'INTEGRATED':
                self.assertTrue(r.get('reason'), r['review_key'])
        deferred = [r['review_key'] for r in self.rows if r['integration_status'] == 'DEFERRED']
        self.assertLessEqual(len(deferred), 10, deferred)

    def test_integrated_handlers_are_tested_or_openly_flagged(self):
        for r in self.rows:
            if r['integration_status'] == 'INTEGRATED':
                self.assertTrue(r.get('tests') or r.get('untested'), r['review_key'])
            for path in r.get('tests', []):
                self.assertTrue((ROOT / path).is_file(), f"{r['review_key']}: missing test file {path}")

    def test_money_paths_are_integrated_and_tested(self):
        for r in self.rows:
            key, file = r['review_key'], r['review_key'].split('::')[0]
            if file in P0_FILES and r['integration_status'] == 'INTEGRATED':
                self.assertFalse(r.get('untested'), f'P0 handler without a keyed test: {key}')
            if key in P0_HANDLERS:
                self.assertEqual(r['integration_status'], 'INTEGRATED', key)
                self.assertTrue(r.get('tests'), key)

    def test_the_committed_matrix_is_current(self):
        committed = json.loads((ROOT / 'docs/idempotency/coverage.json').read_text())
        self.assertEqual(committed, json.loads(json.dumps(self.rows)), 'run: python3 scripts/idempotency/inventory.py')

    def test_every_decision_still_matches_a_handler(self):
        keys = {r['review_key'] for r in self.rows}
        self.assertEqual([k for k in self.review if not k.startswith('@file:') and k not in keys], [])


if __name__ == '__main__':
    unittest.main()
