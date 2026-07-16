"""
phase1_audit.py — Blocker Resolution
======================================
Resolves two blockers before Phase 2 sign-off:

Blocker 1: Show horizon counts cleanly (1yr/5yr/10yr), confirm AHEAD bug fix.
Blocker 2: Prove total death count = unique respondents, mutually exclusive
           (a) EXIT1-confirmed vs (b) IWSTAT=5-only, no double-counting.
"""

import os, warnings
import pandas as pd
import numpy as np

warnings.filterwarnings("ignore")

BASE  = "/run/media/zain-ali/New Volume/insurance/project"
PROC  = os.path.join(BASE, "data/processed")
INTERIM = os.path.join(BASE, "data/interim")

# Load the saved Phase 1 parquet
df = pd.read_parquet(os.path.join(PROC, "phase1_mortality_labels.parquet"))

SEP = "=" * 68
def sep(t=""):
    print(); print(SEP)
    if t: print(f"  {t}"); print(SEP)

# ══════════════════════════════════════════════════════════════════════════════
# BLOCKER 1A — Confirm the AHEAD bug and its fix
# ══════════════════════════════════════════════════════════════════════════════
sep("BLOCKER 1A — AHEAD-1995 Bug: what it was and that it is fixed")

print("""
  WHAT THE BUG WAS:
    Phase 1 first run crashed at the AHEAD-1995 cohort-flag step with:
      FileNotFoundError: exit_ahd-1995.parquet  (dash in filename)
    The parquet was actually saved by Phase 0 as: exit_ahd_1995.parquet
    (Phase 0 converted label "AHD-1995" → "ahd_1995" via .replace('-','_').lower())

  THE FIX:
    Changed the path string from f"exit_ahd-{yr}.parquet"
                               to f"exit_ahd_{yr}.parquet"
    This is a filename mismatch only — the underlying data and logic
    were not affected. The crash happened BEFORE the horizon label
    table was printed on the first run, which is why the table was
    missing in that run's output.

  CONFIRMATION THAT FIX IS BAKED IN:
    The saved parquet has cohort_ahead_1995 column populated correctly:
""")
print(f"    cohort_ahead_1995 value counts:")
print(f"    {df['cohort_ahead_1995'].value_counts().to_dict()}")
print(f"    → {df['cohort_ahead_1995'].sum():,} respondents flagged as AHEAD-1995  (expected ~742)")
print(f"    → Column is present and non-null for all {len(df):,} rows: "
      f"{df['cohort_ahead_1995'].notna().all()}")

# ══════════════════════════════════════════════════════════════════════════════
# BLOCKER 1B — Horizon-specific counts, read from saved parquet
# ══════════════════════════════════════════════════════════════════════════════
sep("BLOCKER 1B — Horizon Label Counts (from saved phase1_mortality_labels.parquet)")

print(f"\n  Total respondents in dataset: {len(df):,}")
print(f"\n  Binary horizon label counts:")
print(f"  {'Horizon':<12}  {'Died(1)':>10}  {'Survived(0)':>12}  {'Censored(NaN)':>14}  "
      f"{'Total':>8}  {'Event rate':>11}")
print(f"  {'-'*12}  {'-'*10}  {'-'*12}  {'-'*14}  {'-'*8}  {'-'*11}")

for col in ["label_1yr", "label_5yr", "label_10yr"]:
    n_died = int((df[col] == 1).sum())
    n_surv = int((df[col] == 0).sum())
    n_cens = int(df[col].isna().sum())
    n_obs  = n_died + n_surv          # labelled (excludes censored-before-horizon)
    rate   = n_died / n_obs if n_obs > 0 else 0
    print(f"  {col:<12}  {n_died:>10,}  {n_surv:>12,}  {n_cens:>14,}  "
          f"{len(df):>8,}  {rate:>10.1%}")

# Full TTE
n_events = int(df["surv_event"].sum())
n_cens   = len(df) - n_events
print(f"  {'TTE (full)':<12}  {n_events:>10,}  {'(censored)':>12}  {n_cens:>14,}  "
      f"{len(df):>8,}  {n_events/len(df):>10.1%}")

print("""
  Interpretation:
    label_Nyr = NaN  → censored BEFORE the N-year horizon; excluded per model
                       (not labeled 0/"survived" — that would be wrong)
    label_Nyr = 0    → survived TO N years (event=0 with ≥N yrs follow-up,
                       OR event=1 but death happened AFTER the N-yr window)
    label_Nyr = 1    → confirmed death WITHIN N years of entry
    TTE              → all respondents; living at last contact = right-censored
""")

# ══════════════════════════════════════════════════════════════════════════════
# BLOCKER 2 — Death count arithmetic: unique respondents, mutually exclusive
# ══════════════════════════════════════════════════════════════════════════════
sep("BLOCKER 2 — Death Count: Unique Respondents, No Double-Counting")

print(f"""
  CONFIRMING THE LOGIC:
    Each respondent appears EXACTLY ONCE in this dataset (one row per HHIDPN).
    The 'event' column = 1 simply if the respondent is confirmed dead by ANY
    source — it is a respondent-level flag, NOT a wave-level count.

    The IWSTAT values printed in Phase 0 (IWSTAT=4: 43,709; IWSTAT=5: 19,334)
    ARE person-wave counts — each deceased respondent shows up in every
    subsequent wave with the dead-status code.  Those numbers were for coding
    verification only and were NEVER used to count deaths.

    The death-count pipeline was:
      1. For each respondent: scan all 16 IWSTAT columns → record FIRST wave
         where IWSTAT ∈ {{4,5}} → ONE death record per respondent
      2. Then left-merge Finder (EXIT1) onto that — EXIT1 is already one row
         per respondent
      3. event=1 assigned at the respondent level → no summation across waves
""")

# Verify: unique HHIDPN
assert df["hhidpn"].nunique() == len(df), "DUPLICATE HHIDPNs FOUND — BUG"
print(f"  ✓ Assert: every HHIDPN is unique  ({df['hhidpn'].nunique():,} unique == {len(df):,} rows)")

# ── Mutually exclusive categories ─────────────────────────────────────────────
# (a) EXIT1-confirmed: finder_death_year is not null
# (b) IWSTAT=5-only:   event=1 AND finder_death_year IS null  (no exit interview)
# (c) censored:        event=0

cat_a = df["finder_death_year"].notna()                          # EXIT1 confirmed
cat_b = (df["event"] == 1) & df["finder_death_year"].isna()     # IWSTAT=5 only
cat_c = df["event"] == 0                                         # alive / censored

# Verify mutual exclusivity
assert (cat_a & cat_b).sum() == 0, "Categories A and B overlap — BUG"
assert (cat_a & cat_c).sum() == 0, "Categories A and C overlap — BUG"
assert (cat_b & cat_c).sum() == 0, "Categories B and C overlap — BUG"
print(f"  ✓ Assert: categories (a), (b), (c) are mutually exclusive")

# Verify they sum to total
assert cat_a.sum() + cat_b.sum() + cat_c.sum() == len(df), "Categories don't sum to total — BUG"
print(f"  ✓ Assert: (a) + (b) + (c) = {cat_a.sum()} + {cat_b.sum()} + {cat_c.sum()} "
      f"= {cat_a.sum()+cat_b.sum()+cat_c.sum():,}  == total {len(df):,}")

print(f"""
  CLEAN DEATH COUNT BREAKDOWN — UNIQUE RESPONDENTS:
  ──────────────────────────────────────────────────
  (a) EXIT1-confirmed deaths    : {cat_a.sum():>7,}
        EXIT interview obtained; death year = EXIT1 year (exact)
        Source: Finder File EXIT1 column (per README)

  (b) IWSTAT=5 deaths (no EXIT) : {cat_b.sum():>7,}
        Confirmed deceased by IWSTAT=5 in ≥1 wave; no exit interview conducted
        Death year = first wave where IWSTAT=5 (±2yr biennial approximation)
        Quality flag: iwstat_death_type='no_exit' in dataset
        Per Q1 approval: included in main label; sensitivity lever for Phase 5
        (Phase 5 will run models with/without this group to test signal quality)

  (c) Censored / alive          : {cat_c.sum():>7,}
        No confirmed death by any source through 2022
        Last contact = last wave where IWSTAT ∈ {{1,2}}

  TOTAL                         : {len(df):>7,}
  ─────────────────────────────────────────────────

  FULL-TTE EVENT COUNT:  {n_events:,}  unique respondents  (= a + b = {cat_a.sum()}+{cat_b.sum()}={cat_a.sum()+cat_b.sum()})
  (This is the number that matters for survival modeling — confirmed unique.)
""")

# Extra sanity: verify death_year source breakdown
exit1_dy  = df[cat_a]["death_year"].notna().sum()
iwstat_dy = df[cat_b]["death_year"].notna().sum()
print(f"  death_year populated for (a): {exit1_dy:,}  (b): {iwstat_dy:,}")

# ── AHEAD-1995 cohort cross-tab ────────────────────────────────────────────────
print(f"\n  AHEAD-1995 cohort cross-tab with event status:")
ct = pd.crosstab(df["cohort_ahead_1995"], df["event"],
                 rownames=["AHEAD-1995"], colnames=["event(dead=1)"])
print(ct.to_string())

sep("PHASE 1 SIGN-OFF SUMMARY")
print(f"""
  Blocker 1 resolved:
    ✓ AHEAD bug = filename dash/underscore mismatch only; no logic error.
    ✓ Horizon counts now shown explicitly from saved parquet (table above).

  Blocker 2 resolved:
    ✓ 18,423 confirmed deaths = {cat_a.sum():,} (EXIT1) + {cat_b.sum():,} (IWSTAT=5-only)
    ✓ Unique respondents — NOT wave-level sum (wave-level IWSTAT counts
      were only for coding verification, never for death counting)
    ✓ Three categories are mutually exclusive and exhaustive (asserts passed)

  Q1/Q2 approvals baked in:
    ✓ IWSTAT=5 deaths included with 'iwstat_death_type' quality flag
    ✓ Phase 5 sensitivity lever noted for with/without IWSTAT=5 comparison
    ✓ Horizon-NaN rows kept in parquet; filtered per model downstream

  ─── READY FOR PHASE 2 ON YOUR GREEN LIGHT ───
""")
