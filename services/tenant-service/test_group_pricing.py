"""Unit tests for group_pricing.py and group_underwriting.member_underwriting_outcome — pure, no DB.

Run with: docker compose exec tenant-service python test_group_pricing.py
"""

from group_pricing import PricedLife, hazard_factor, price_group, size_factor
from group_underwriting import member_underwriting_outcome
from shared.pricing.calculator import POLICY_FEE, STAMP_DUTY_RATE


def _life(key, age=30, sa=1_000_000, kind="member", occupation="Accountant", loading=0.0, cls=None):
    return PricedLife(key=key, kind=kind, age=age, sum_assured=sa, occupation=occupation,
                      loading_pct=loading, benefit_class=cls)


def test_size_factor_bands():
    assert [size_factor(n) for n in (1, 24, 25, 99, 100, 999, 5000)] == [1.0, 1.0, 0.95, 0.9, 0.85, 0.8, 0.75]


def test_hazard_factor_by_sum_assured_share():
    assert hazard_factor([_life("a"), _life("b")]) == 1.0
    assert hazard_factor([_life("a", occupation="Miner"), _life("b")]) == 1.25           # half SA HIGH → +0.5×0.5
    assert hazard_factor([_life("a", occupation="Electrician"), _life("b", sa=3_000_000)]) == 1.05  # quarter MEDIUM
    # Dependents have no occupation and don't dilute the members' share.
    assert hazard_factor([_life("a", occupation="Miner"), _life("d", kind="dependent", sa=9_000_000)]) == 1.5


def test_price_simple_group_by_hand():
    r = price_group([_life("a"), _life("b")], base_rate_per_mille=3.2)
    # age 30 → band factor 1.0, 2 members → size 1.0, office → hazard 1.0
    assert r.rate_per_mille == 3.2
    assert r.by_life == {"a": 3200.0, "b": 3200.0}
    assert r.risk_premium == 6400.0
    expected_total = round((6400 + POLICY_FEE) * (1 + STAMP_DUTY_RATE), 2)
    assert r.total_premium == expected_total and r.policy_fee == POLICY_FEE


def test_loading_applies_to_that_life_only():
    r = price_group([_life("a", loading=50), _life("b")], base_rate_per_mille=3.2)
    assert r.by_life["a"] == 4800.0 and r.by_life["b"] == 3200.0


def test_weighted_age_and_dependents():
    lives = [_life("a", age=30, sa=3_000_000, cls="Staff"), _life("b", age=50, sa=1_000_000, cls="Staff"),
             _life("d", age=28, sa=1_000_000, kind="dependent", cls="Staff")]
    r = price_group(lives, base_rate_per_mille=2.0)
    assert r.weighted_average_age == round((30 * 3 + 50 + 28) / 5, 1)   # 33.6 → band 26 → 1.0
    assert r.member_count == 2 and r.dependent_count == 1
    assert r.by_class == [{"benefit_class": "Staff", "members": 2, "dependents": 1,
                           "sum_assured": 5_000_000.0, "premium": 10_000.0}]


def test_empty_or_zero_scheme_rejected():
    for lives in ([], [_life("a", sa=0)]):
        try:
            price_group(lives, 3.2)
        except ValueError:
            continue
        raise AssertionError("expected ValueError")


def test_member_outcomes():
    fcl = 1_000_000
    assert member_underwriting_outcome(900_000, fcl, "Quoted").basis == "Guaranteed"
    assert member_underwriting_outcome(5_000_000, None, "Quoted").basis == "Guaranteed"   # no FCL yet
    assert member_underwriting_outcome(5_000_000, fcl, "Approved").covered_amount == 5_000_000
    loaded = member_underwriting_outcome(5_000_000, fcl, "AcceptedWithLoadings", 75)
    assert (loaded.basis, loaded.loading_pct) == ("Loaded", 75)
    restricted = member_underwriting_outcome(5_000_000, fcl, "Declined")
    assert (restricted.basis, restricted.covered_amount) == ("Restricted", fcl) and restricted.note
    for st in ("Quoted", "Proposed", "UnderReview", "InformationRequested"):
        assert member_underwriting_outcome(5_000_000, fcl, st).basis == "Pending", st


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
