"""
phase3_feature_engineering.py
=============================
PHASE 3 — Relative Re-indexing & Baseline Feature Extraction

Implements dynamic `entry_wave`-relative indexing to prevent calendar-wave
cohort leakage. 

Spot-checks 4 distinct cohorts before applying extraction globally.
Produces the clean baseline (wave_0) underwriting feature set.
"""

import os, gc, warnings
import pandas as pd
import numpy as np

warnings.filterwarnings("ignore")

BASE    = "/run/media/zain-ali/New Volume/insurance/project"
INTERIM = os.path.join(BASE, "data/interim")
PROC    = os.path.join(BASE, "data/processed")
REPORTS = os.path.join(BASE, "reports")

LOG_PATH = os.path.join(REPORTS, "phase3_output.log")
_fh = open(LOG_PATH, "w", buffering=1)

def log(msg=""):
    print(msg, flush=True)
    _fh.write(msg + "\n"); _fh.flush()

SEP = "=" * 70
def sep(t=""):
    log(); log(SEP)
    if t: log(f"  {t}"); log(SEP)

# ══════════════════════════════════════════════════════════════════════════════
# 1. LOAD DATA & PREPARE MERGE
# ══════════════════════════════════════════════════════════════════════════════
sep("1. LOAD PHASE 1 LABELS & PHASE 2 PARQUETS")

labels = pd.read_parquet(os.path.join(PROC, "phase1_mortality_labels.parquet"))
fin    = pd.read_parquet(os.path.join(INTERIM, "phase2_financial.parquet"))
hlth   = pd.read_parquet(os.path.join(INTERIM, "phase2_health.parquet"))
dem    = pd.read_parquet(os.path.join(INTERIM, "phase2_demographic.parquet"))

log(f"  Labels      : {labels.shape[0]:,} rows")
log(f"  Financial   : {fin.shape[0]:,} rows")
log(f"  Health      : {hlth.shape[0]:,} rows")
log(f"  Demographic : {dem.shape[0]:,} rows")

# Merge all into one wide dataframe
df = labels[["hhidpn", "entry_wave", "entry_year", "cohort_ahead_1995", "event", "tte_years", "label_1yr", "label_5yr", "label_10yr"]].copy()
for sub_df in [fin, hlth, dem]:
    df = df.merge(sub_df, on="hhidpn", how="left")

del fin, hlth, dem, labels; gc.collect()

# Convert entry_wave (e.g., 'r4') to integer
df["entry_w_int"] = df["entry_wave"].str.replace("r", "").astype(int)

# ══════════════════════════════════════════════════════════════════════════════
# 2. RELATIVE INDEXING ENGINE
# ══════════════════════════════════════════════════════════════════════════════
sep("2. RELATIVE INDEXING ENGINE")

def get_relative_wave_col(stem, wave_offset):
    """
    Given a stem with {w} (e.g., 'r{w}bmi') and a relative wave offset (0=baseline),
    returns a pandas Series extracting the respondent-specific value.
    """
    # Create an empty Series to hold the results
    result = pd.Series(np.nan, index=df.index, dtype=float)
    
    # We iterate over all possible entry waves (1 to 16)
    for entry_w in df["entry_w_int"].unique():
        target_w = entry_w + wave_offset
        if target_w < 1 or target_w > 16:
            continue
            
        col_name = stem.replace("{w}", str(target_w))
        if col_name in df.columns:
            mask = df["entry_w_int"] == entry_w
            result.loc[mask] = df.loc[mask, col_name]
            
    return result

log("  Engine built: `get_relative_wave_col(stem, offset)` maps calendar columns dynamically.")

# ══════════════════════════════════════════════════════════════════════════════
# 3. SPOT-CHECK: 4 DISTINCT COHORTS
# ══════════════════════════════════════════════════════════════════════════════
sep("3. SPOT-CHECK: 4 COHORTS (Wave 0 / Wave 1 / Wave 2 mapping)")

np.random.seed(42)

# Pick 4 respondents
# 1. Original 1992 HRS (entry_w_int = 1)
# 2. AHEAD 1995 (cohort_ahead_1995 = 1, entry_w_int = 2 or 3)
# 3. War Baby (entry_w_int = 4, year 1998)
# 4. Mid Boomer (entry_w_int = 10, year 2010)

idx_hrs   = df[df["entry_w_int"] == 1].sample(1).index[0]
idx_ahead = df[df["cohort_ahead_1995"] == 1].sample(1).index[0]
idx_wb    = df[(df["entry_w_int"] == 4) & (df["cohort_ahead_1995"] == 0)].sample(1).index[0]
idx_mbb   = df[df["entry_w_int"] == 10].sample(1).index[0]

test_stem = "r{w}bmi"

for name, idx in [("Original HRS (1992)", idx_hrs), 
                  ("AHEAD Cohort (1995)", idx_ahead), 
                  ("War Baby Cohort (1998)", idx_wb), 
                  ("Mid Boomer Cohort (2010)", idx_mbb)]:
    
    row = df.loc[idx]
    ew = row["entry_w_int"]
    ey = row["entry_year"]
    
    log(f"  ── {name} | HHIDPN: {row['hhidpn']} | Entry Wave: {ew} ({ey}) ──")
    
    # Show mapping manually
    for offset in [0, 1, 2]:
        target_w = ew + offset
        calendar_col = test_stem.replace("{w}", str(target_w))
        
        # What our engine extracts
        # (We run the engine over the whole df, but just print this row)
        engine_val = get_relative_wave_col(test_stem, offset).loc[idx]
        
        # What is actually in the calendar column
        actual_val = row[calendar_col] if calendar_col in df.columns else np.nan
        
        log(f"    wave_{offset} --> maps to calendar column [{calendar_col:<7}] "
            f"| Engine extracted: {engine_val:<5.1f} | Actual col value: {actual_val:<5.1f}")
        assert (pd.isna(engine_val) and pd.isna(actual_val)) or (engine_val == actual_val), "MAPPING BUG!"
        
    log("    ✓ Mapping passed assertion.\n")

# ══════════════════════════════════════════════════════════════════════════════
# 4. BASELINE FEATURE EXTRACTION (WAVE_0)
# ══════════════════════════════════════════════════════════════════════════════
sep("4. EXTRACTING BASELINE (WAVE_0) FEATURES FOR ENTIRE SAMPLE")

# Initialize baseline dataframe with identifiers
baseline = df[["hhidpn", "entry_wave", "entry_year", "cohort_ahead_1995"]].copy()

# Time-invariant demographics
baseline["gender"] = df["ragender"]
baseline["race"]   = df["raracem"]
baseline["hispan"] = df["rahispan"]
baseline["educ"]   = df["raeduc"]
baseline["birth_yr"] = df["rabyear"]

# Financial (Wave 0)
baseline["fin_income"] = get_relative_wave_col("h{w}itot", 0)
baseline["fin_wealth"] = get_relative_wave_col("h{w}atotw", 0)
baseline["fin_wealth_liquid"] = get_relative_wave_col("h{w}atotf", 0)
baseline["fin_home_eq"] = get_relative_wave_col("h{w}ahous", 0)
baseline["fin_pension"] = get_relative_wave_col("r{w}ipena", 0)
baseline["fin_ssdi"]    = get_relative_wave_col("r{w}issdi", 0)

# Health (Wave 0)
baseline["hlth_srh"]    = get_relative_wave_col("r{w}shlt", 0)
baseline["hlth_bmi"]    = get_relative_wave_col("r{w}bmi", 0)
baseline["hlth_smoken"] = get_relative_wave_col("r{w}smoken", 0)
baseline["hlth_smokev"] = get_relative_wave_col("r{w}smokev", 0)
baseline["hlth_adl5a"]  = get_relative_wave_col("r{w}adl5a", 0)
baseline["hlth_iadl5a"] = get_relative_wave_col("r{w}iadl5a", 0)

# Conditions (Wave 0, 'e' suffix harmonized)
baseline["cond_hearte"] = get_relative_wave_col("r{w}hearte", 0)
baseline["cond_diabe"]  = get_relative_wave_col("r{w}diabe", 0)
baseline["cond_cancre"] = get_relative_wave_col("r{w}cancre", 0)
baseline["cond_stroke"] = get_relative_wave_col("r{w}stroke", 0)
baseline["cond_hibpe"]  = get_relative_wave_col("r{w}hibpe", 0)
baseline["cond_lunge"]  = get_relative_wave_col("r{w}lunge", 0)

# Wave-specific Demographics (Wave 0)
baseline["demo_age"]    = get_relative_wave_col("r{w}agey_b", 0)
baseline["demo_mstat"]  = get_relative_wave_col("r{w}mstat", 0)
baseline["demo_region"] = get_relative_wave_col("r{w}cenreg", 0)

log(f"  Extracted {len(baseline.columns) - 4} baseline features across {len(baseline):,} respondents.")

# ══════════════════════════════════════════════════════════════════════════════
# 5. DATA LEAKAGE PREVENTION: THE TREND FEATURE DILEMMA
# ══════════════════════════════════════════════════════════════════════════════
sep("5. DATA LEAKAGE AUDIT: TREND / TRAJECTORY FEATURES")

log("""
  CRITICAL STATISTICAL DECISION:
  The Phase 3 mandate included extracting "longitudinal change features" (e.g., 
  BMI trajectory, wealth decline) by mapping [wave_0 to wave_1].
  
  The relative indexing engine built above completely solves the cohort-alignment 
  bug. However, it exposes a massive mortality-label leakage (immortal time bias).
  
  THE PROBLEM:
  Our mortality labels (built in Phase 1) calculate time-to-event starting from 
  entry_year (wave_0). If we compute a trend feature using `wave_1` (which occurs 
  ~2 years after underwriting), the respondent MUST HAVE SURVIVED to wave_1 to have 
  a value. 
  
  If we feed a model `wave_0_to_wave_1_bmi_change`:
  - Anyone who died in Year 1 will have NaN for this feature.
  - The model will learn: "If trend is NaN, predict death at 1yr = 100%."
  - This is fatal data leakage.

  THE RESOLUTION:
  1. The dataset produced here contains ONLY pure baseline (wave_0) features. 
     This strictly aligns with a true "time of underwriting" risk assessment.
  2. The dynamic engine `get_relative_wave_col` is fully operational. If you 
     wish to use trend features in Phase 5, we must mathematically shift the 
     "underwriting date" to `wave_2`, recalculate all mortality labels from that 
     new baseline, and discard respondents who died before wave_2.
     
  For now, the underwriting baseline remains `wave_0`, and the feature set is 
  sealed against leakage.
""")

# ══════════════════════════════════════════════════════════════════════════════
# 6. MISSINGNESS SUMMARY ON WAVE_0
# ══════════════════════════════════════════════════════════════════════════════
sep("6. BASELINE FEATURE MISSINGNESS REPORT (BEFORE MICE)")

miss_report = (baseline.isna().sum() / len(baseline) * 100).round(1)
log(f"  {'Feature':<20} | {'% Missing':>9}")
log(f"  {'-'*20}-+-{'-'*9}")

# Show structural missingness on IADL and ADL
for col, pct in miss_report.items():
    if col in ["hhidpn", "entry_wave", "entry_year", "cohort_ahead_1995"]: continue
    flag = ""
    if pct > 25:
        if col in ["hlth_iadl5a", "hlth_adl5a"]:
            flag = "<-- Structural (Wave 1 exclusion/unasked)"
        else:
            flag = "<-- High missingness"
    log(f"  {col:<20} | {pct:>8.1f}% {flag}")

# ══════════════════════════════════════════════════════════════════════════════
# 7. SAVE PHASE 3 DATASET
# ══════════════════════════════════════════════════════════════════════════════
out_path = os.path.join(PROC, "phase3_baseline_features.parquet")
baseline.to_parquet(out_path, index=False)
log(f"\n  Saved Phase 3 dataset → {out_path} ({os.path.getsize(out_path)/1e6:.1f} MB)")

_fh.close()
print(f"\nFull log → {LOG_PATH}")
