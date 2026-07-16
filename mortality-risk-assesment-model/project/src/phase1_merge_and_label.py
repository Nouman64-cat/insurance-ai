"""
phase1_merge_and_label.py
=========================
PHASE 1 — Merge Exit/Finder → Longitudinal, Construct Mortality Label

Death date rule (baked in, enforced explicitly):
  death_year = EXIT1 only
  POSTEXIT* records never trigger or shift the death date
  EXIT2 = documented error for 2 respondents → ignored
  IWSTAT=5 (deceased, no exit interview) → confirmed dead, death_wave from IWSTAT

Memory: all work from interim parquet files; no re-read of 1.74 GB .dta
"""

import os, gc, json, warnings
import pandas as pd
import numpy as np

warnings.filterwarnings("ignore")

BASE    = "/run/media/zain-ali/New Volume/insurance/project"
INTERIM = os.path.join(BASE, "data/interim")
PROC    = os.path.join(BASE, "data/processed")
REPORTS = os.path.join(BASE, "reports")
os.makedirs(PROC, exist_ok=True)

LOG_PATH = os.path.join(REPORTS, "phase1_output.log")
_fh = open(LOG_PATH, "w", buffering=1)

def log(msg=""):
    print(msg, flush=True)
    _fh.write(msg + "\n"); _fh.flush()

SEP = "=" * 70
def sep(t=""):
    log(); log(SEP)
    if t: log(f"  {t}"); log(SEP)

WAVE_YEAR = {f"r{i}": yr for i, yr in enumerate(
    [1992,1994,1996,1998,2000,2002,2004,2006,2008,2010,2012,2014,2016,2018,2020,2022], 1)}
YEAR_WAVE = {v: k for k, v in WAVE_YEAR.items()}

# EXIT2 erroneous respondents (per README — ignore for label)
EXIT2_ERROR_IDS = {11863010, 203802010}

# IWSTAT values
ALIVE_STATS   = {1, 2}      # interviewed (respondent or proxy)
PARTIAL_STAT  = {3}         # partial — still alive
DEAD_EXIT     = {4}         # deceased, exit interview obtained
DEAD_NO_EXIT  = {5}         # deceased, no exit interview
NONRESP       = {6, 7}      # non-response, alive assumed

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 — Load longitudinal IWSTAT parquet + Finder
# ══════════════════════════════════════════════════════════════════════════════
sep("1. LOAD BASE FILES")

long_df   = pd.read_parquet(os.path.join(INTERIM, "long_ids_iwstat.parquet"))
finder_df = pd.read_parquet(os.path.join(INTERIM, "finder.parquet"))

log(f"  Longitudinal (IWSTAT subset): {long_df.shape[0]:,} rows × {long_df.shape[1]} cols")
log(f"  Finder file                 : {finder_df.shape[0]:,} rows × {finder_df.shape[1]} cols")

iwstat_cols = sorted([c for c in long_df.columns if c.startswith("r") and c.endswith("iwstat")])
log(f"  IWSTAT columns: {iwstat_cols}")

# ── IWSTAT value counts (to confirm coding) ───────────────────────────────────
log(f"\n  IWSTAT value counts across all waves:")
all_vals = {}
for c in iwstat_cols:
    vc = long_df[c].value_counts().to_dict()
    for v, n in vc.items():
        all_vals[v] = all_vals.get(v, 0) + n
for v in sorted(all_vals):
    log(f"    IWSTAT={v}: {all_vals[v]:,}")

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2 — Per-respondent: entry wave, last-alive wave, IWSTAT-based death
# ══════════════════════════════════════════════════════════════════════════════
sep("2. DERIVE ENTRY / LAST-ALIVE / IWSTAT-DEATH PER RESPONDENT")

# Build matrix: rows=respondents, cols=wave IWSTAT values (numeric)
iw = long_df[["hhidpn"] + iwstat_cols].copy()
iw["hhidpn"] = iw["hhidpn"].astype(int)

# Ordered wave prefixes aligned to columns
wave_prefixes = [c.replace("iwstat","") for c in iwstat_cols]
# Sort by wave number for correct ordering
wave_order = sorted(wave_prefixes, key=lambda x: int(x[1:]))
ordered_cols = [f"{p}iwstat" for p in wave_order]

records = []
for _, row in iw.iterrows():
    pid = int(row["hhidpn"])

    entry_wave = entry_year = None
    last_alive_wave = last_alive_year = None
    iwstat_death_wave = iwstat_death_year = None
    iwstat_death_type = None   # "exit_interview" | "no_exit" | None

    for w in wave_order:
        col = f"{w}iwstat"
        if col not in row.index:
            continue
        val = row[col]
        if pd.isna(val):
            continue
        val = int(val)
        yr  = WAVE_YEAR[w]

        # Entry: first alive wave
        if val in ALIVE_STATS and entry_wave is None:
            entry_wave = w; entry_year = yr

        # Last alive (ALIVE or PARTIAL)
        if val in ALIVE_STATS | PARTIAL_STAT:
            last_alive_wave = w; last_alive_year = yr

        # IWSTAT-based death (first occurrence of 4 or 5)
        if val in DEAD_EXIT | DEAD_NO_EXIT and iwstat_death_wave is None:
            iwstat_death_wave = w; iwstat_death_year = yr
            iwstat_death_type = "exit_interview" if val in DEAD_EXIT else "no_exit"

    records.append({
        "hhidpn": pid,
        "entry_wave": entry_wave, "entry_year": entry_year,
        "last_alive_wave": last_alive_wave, "last_alive_year": last_alive_year,
        "iwstat_death_wave": iwstat_death_wave, "iwstat_death_year": iwstat_death_year,
        "iwstat_death_type": iwstat_death_type,
    })

base_df = pd.DataFrame(records)
del iw, records; gc.collect()

log(f"  Respondents with entry wave   : {base_df['entry_wave'].notna().sum():,}")
log(f"  Respondents with last alive   : {base_df['last_alive_wave'].notna().sum():,}")
log(f"  IWSTAT=4 deaths (exit done)   : {(base_df['iwstat_death_type']=='exit_interview').sum():,}")
log(f"  IWSTAT=5 deaths (no exit)     : {(base_df['iwstat_death_type']=='no_exit').sum():,}")
log(f"  No entry wave (never seen)    : {base_df['entry_wave'].isna().sum():,}")

# Respondents with no entry wave — flag and exclude from analytic sample
no_entry = base_df[base_df["entry_wave"].isna()]["hhidpn"].tolist()
if no_entry:
    log(f"  ⚠ {len(no_entry)} respondents have no observed entry wave — excluded from analytic sample")
    no_entry_path = os.path.join(REPORTS, "no_entry_excluded_ids.csv")
    pd.DataFrame({"hhidpn": no_entry}).to_csv(no_entry_path, index=False)
base_df = base_df[base_df["entry_wave"].notna()].copy()

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3 — Merge Finder → get EXIT1 (death year, authoritative)
#           ENFORCE: POSTEXIT* never triggers or shifts death date
# ══════════════════════════════════════════════════════════════════════════════
sep("3. MERGE FINDER — EXIT1-ONLY DEATH DATE (ENFORCED)")

finder_df["hhidpn"] = finder_df["hhidpn"].astype(int)

# Keep ONLY EXIT1 and POSTEXIT cols from finder (for audit); drop EXIT2 from label logic
finder_sub = finder_df[["hhidpn","exit1","exit2","postexit1","postexit2","postexit3"]].copy()

merged = base_df.merge(finder_sub, on="hhidpn", how="left")
del base_df; gc.collect()

# ── Explicit EXIT1-only rule ──────────────────────────────────────────────────
# death_year = EXIT1 value (if present and not an EXIT2-error respondent)
# POSTEXIT* columns are retained for audit but NEVER used to set death_year

# Flag the 2 EXIT2-error respondents
merged["is_exit2_error"] = merged["hhidpn"].isin(EXIT2_ERROR_IDS)
log(f"  EXIT2 error respondents flagged: {merged['is_exit2_error'].sum()}")

# Authoritative death year from EXIT1 only
merged["exit1_year"] = pd.to_numeric(merged["exit1"], errors="coerce")
# For EXIT2-error respondents, EXIT1 is still valid (error was the second interview, not the first)
merged["finder_death_year"] = merged["exit1_year"]

# Final combined death indicator:
#   CONFIRMED DEAD = has finder_death_year (EXIT1) OR iwstat_death_type='no_exit' (IWSTAT=5)
merged["event"] = (
    merged["finder_death_year"].notna() |
    (merged["iwstat_death_type"] == "no_exit")
).astype(int)

# Final death year (EXIT1 preferred; fall back to IWSTAT=5 wave year)
merged["death_year"] = np.where(
    merged["finder_death_year"].notna(),
    merged["finder_death_year"],
    np.where(merged["iwstat_death_type"] == "no_exit",
             merged["iwstat_death_year"], np.nan)
)

# Sanity check: confirm POSTEXIT is NEVER overriding death_year
# (this is structural in the code above — documenting it explicitly)
log(f"\n  ✓ ENFORCEMENT CHECK:")
log(f"    death_year derived from EXIT1 only: {merged['finder_death_year'].notna().sum():,} respondents")
log(f"    death_year from IWSTAT=5 (no exit): {((merged['finder_death_year'].isna()) & (merged['iwstat_death_type']=='no_exit')).sum():,} respondents")
log(f"    POSTEXIT columns retained for audit but NOT used in death_year computation.")
# Verify: no respondent's death_year comes from a POSTEXIT column
# (by construction impossible, but we assert it)
for pc in ["postexit1","postexit2","postexit3"]:
    if pc in merged.columns:
        # Check: for respondents whose death_year == their postexit year AND finder_death_year is null
        pe_yr = pd.to_numeric(merged[pc], errors="coerce")
        conflict = ((merged["finder_death_year"].isna()) &
                    (merged["death_year"] == pe_yr) &
                    merged["event"].astype(bool))
        assert conflict.sum() == 0, f"BUG: {pc} is driving death_year for {conflict.sum()} respondents"
log(f"    ✓ Assert passed: no POSTEXIT column influences death_year.")

# ── Discordance check: IWSTAT vs EXIT1 ────────────────────────────────────────
log(f"\n  Cross-check IWSTAT death status vs Finder EXIT1:")
has_exit1 = merged["finder_death_year"].notna()
has_iwstat_dead = merged["iwstat_death_type"].notna()

both   = (has_exit1 & has_iwstat_dead).sum()
exit_only = (has_exit1 & ~has_iwstat_dead).sum()
iwstat_only = (~has_exit1 & has_iwstat_dead).sum()
neither = (~has_exit1 & ~has_iwstat_dead).sum()

log(f"    EXIT1 + IWSTAT death    : {both:,}  (consistent)")
log(f"    EXIT1 only (no IWSTAT)  : {exit_only:,}  (EXIT1 leads — lag in IWSTAT coding)")
log(f"    IWSTAT only (no EXIT1)  : {iwstat_only:,}  (IWSTAT=5: no exit interview → confirmed dead)")
log(f"    Neither (censored alive): {neither:,}")

# ── Last known-alive year (for censored respondents' TTE) ────────────────────
merged["last_contact_year"] = np.where(
    merged["event"] == 1,
    merged["death_year"],
    merged["last_alive_year"]
)

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4 — Time-at-risk + Binary horizon labels
# ══════════════════════════════════════════════════════════════════════════════
sep("4. TIME-AT-RISK & BINARY HORIZON LABELS")

# TTE in years (using calendar years; HRS biennial so month precision N/A from waves alone)
merged["tte_years"] = (merged["last_contact_year"] - merged["entry_year"]).astype(float)
merged["tte_years"] = merged["tte_years"].clip(lower=0)

# Cohort flag for AHEAD-1995 sub-study
ahead_ids = set(
    pd.read_parquet(os.path.join(INTERIM, "exit_ahd_1995.parquet"))["hhidpn"].astype(int).values
)
merged["cohort_ahead_1995"] = merged["hhidpn"].isin(ahead_ids).astype(int)
log(f"  AHEAD-1995 cohort flagged: {merged['cohort_ahead_1995'].sum():,} respondents")

# Exclude orphaned Finder IDs (no longitudinal data — established in Phase 0b)
# They are already excluded because base_df was built from long_df (inner left join)
# but let's verify none slipped through
orphan_ids = set(finder_df[~finder_df["hhidpn"].isin(
    pd.read_parquet(os.path.join(INTERIM,"long_ids_iwstat.parquet"))["hhidpn"].astype(int)
)]["hhidpn"].values)
orphan_in_merged = merged[merged["hhidpn"].isin(orphan_ids)]
log(f"  Orphaned Finder IDs in merged dataset: {len(orphan_in_merged)}  (should be 0)")
assert len(orphan_in_merged) == 0, "Orphaned IDs leaked into merged dataset"
log(f"  ✓ Assert passed: 0 orphaned IDs in analytic dataset")

# Save orphan audit trail
pd.DataFrame({"hhidpn": list(orphan_ids)}).to_csv(
    os.path.join(REPORTS, "orphaned_exit_ids.csv"), index=False)

def build_horizon_label(df, horizon_years, label_col):
    """
    Build binary horizon label:
      1  = died within horizon_years of entry
      0  = alive at horizon_years (follow-up ≥ horizon_years, no death within window)
      NaN = censored before horizon (cannot be labeled either way)
    """
    died_within  = (df["event"] == 1) & (df["tte_years"] <= horizon_years)
    survived_to  = (df["event"] == 0) & (df["tte_years"] >= horizon_years)
    survived_to |= (df["event"] == 1) & (df["tte_years"] > horizon_years)  # died AFTER horizon
    labels = pd.Series(np.nan, index=df.index, name=label_col)
    labels[died_within] = 1
    labels[survived_to] = 0
    # The rest (censored before horizon) stay NaN — explicitly NOT labeled "survived"
    return labels

for horizon, col in [(1, "label_1yr"), (5, "label_5yr"), (10, "label_10yr")]:
    merged[col] = build_horizon_label(merged, horizon, col)

# TTE survival columns (for lifelines / Cox)
merged["surv_duration"] = merged["tte_years"]
merged["surv_event"]    = merged["event"]

log(f"\n  {'Horizon':<12}  {'Events(died)':>13}  {'Censored':>10}  {'Excluded':>10}  {'Total':>8}")
log(f"  {'-'*12}  {'-'*13}  {'-'*10}  {'-'*10}  {'-'*8}")

total = len(merged)
for horizon, col in [(1,"label_1yr"),(5,"label_5yr"),(10,"label_10yr")]:
    n_died     = int((merged[col] == 1).sum())
    n_survived = int((merged[col] == 0).sum())
    n_censored = int(merged[col].isna().sum())
    log(f"  {col:<12}  {n_died:>13,}  {n_survived:>10,}  {n_censored:>10,}  {total:>8,}")

# Full TTE
n_events   = int(merged["surv_event"].sum())
n_censored = total - n_events
log(f"  {'TTE (full)':<12}  {n_events:>13,}  {n_censored:>10,}  {'N/A':>10}  {total:>8,}")

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5 — SPOT-CHECK: trace 10 confirmed EXIT1 deaths through all files
# ══════════════════════════════════════════════════════════════════════════════
sep("5. SPOT-CHECK — 10 RANDOM EXIT1 DEATHS TRACED END-TO-END")

np.random.seed(42)
confirmed_exit1 = merged[merged["finder_death_year"].notna()].copy()
sample = confirmed_exit1.sample(min(10, len(confirmed_exit1)), random_state=42)

log(f"\n  Tracing {len(sample)} randomly selected respondents:")
log(f"  (Longitudinal entry → Finder EXIT1 → exit-wave file → final label)\n")

# Load full long IWSTAT for the spot-check IDs
long_full = pd.read_parquet(os.path.join(INTERIM, "long_ids_iwstat.parquet"))
long_full["hhidpn"] = long_full["hhidpn"].astype(int)

for _, row in sample.iterrows():
    pid       = int(row["hhidpn"])
    exit1_yr  = int(row["finder_death_year"])
    entry_yr  = int(row["entry_year"]) if pd.notna(row["entry_year"]) else "?"
    last_alive = int(row["last_alive_year"]) if pd.notna(row["last_alive_year"]) else "?"
    tte       = round(row["tte_years"], 1) if pd.notna(row["tte_years"]) else "?"

    log(f"  ── HHIDPN={pid} ────────────────────────────────────")
    log(f"    Longitudinal: entry_year={entry_yr}, last_alive_year={last_alive}")

    # IWSTAT timeline
    lrow = long_full[long_full["hhidpn"] == pid]
    if len(lrow):
        timeline = []
        for w in sorted(WAVE_YEAR.keys(), key=lambda x: int(x[1:])):
            col = f"{w}iwstat"
            if col in lrow.columns:
                v = lrow.iloc[0][col]
                if pd.notna(v):
                    timeline.append(f"{WAVE_YEAR[w]}:IWSTAT={int(v)}")
        log(f"    IWSTAT timeline: {' | '.join(timeline)}")

    # Finder record
    frow = finder_df[finder_df["hhidpn"] == pid]
    if len(frow):
        fr = frow.iloc[0]
        log(f"    Finder: EXIT1={fr['exit1']}  EXIT2={fr['exit2']}  "
            f"POSTEXIT1={fr['postexit1']}  POSTEXIT2={fr['postexit2']}  POSTEXIT3={fr['postexit3']}")

    # Exit wave file for EXIT1 year
    exit_wave_fname = os.path.join(INTERIM, f"exit_hrs_{exit1_yr}.parquet")
    if not os.path.exists(exit_wave_fname):
        exit_wave_fname = os.path.join(INTERIM, f"exit_ahd_{exit1_yr}.parquet")
    if os.path.exists(exit_wave_fname):
        ex_df = pd.read_parquet(exit_wave_fname)
        ex_df["hhidpn"] = ex_df["hhidpn"].astype(int)
        ex_row = ex_df[ex_df["hhidpn"] == pid]
        if len(ex_row):
            post_flag = ex_row.iloc[0].get("post_exit", "N/A")
            log(f"    Exit file ({exit1_yr}): found  |  POST_EXIT={post_flag}  "
                f"(should be 0 for exit interview)")
            if str(post_flag) != "0" and str(post_flag) != "0.0":
                log(f"    ⚠ POST_EXIT≠0 — this row is a post-exit, not the primary exit interview")
        else:
            log(f"    Exit file ({exit1_yr}): HHIDPN not found in wave file (may be in post-exit year)")
        del ex_df; gc.collect()
    else:
        log(f"    Exit file ({exit1_yr}): wave file not found at expected path")

    # Final label
    log(f"    LABEL: event={int(row['event'])}  death_year={exit1_yr}  tte_years={tte}")
    log(f"           label_1yr={row['label_1yr']}  label_5yr={row['label_5yr']}  label_10yr={row['label_10yr']}")
    log(f"           AHEAD-1995={int(row['cohort_ahead_1995'])}")
    log("")

del long_full; gc.collect()

# ══════════════════════════════════════════════════════════════════════════════
# STEP 6 — Save final Phase 1 dataset
# ══════════════════════════════════════════════════════════════════════════════
sep("6. SAVE FINAL PHASE 1 LABELED DATASET")

# Drop raw finder columns not needed downstream (keep EXIT1 year, drop raw str cols)
keep_cols = [
    "hhidpn", "entry_wave", "entry_year",
    "last_alive_wave", "last_alive_year",
    "iwstat_death_wave", "iwstat_death_year", "iwstat_death_type",
    "finder_death_year",        # EXIT1 year — authoritative death year
    "exit2",                    # keep for audit (2 error respondents)
    "postexit1","postexit2","postexit3",  # keep for audit / asset analysis in later phases
    "is_exit2_error",
    "event",                    # 1=confirmed dead, 0=censored
    "death_year",               # final death year (EXIT1 or IWSTAT=5 wave year)
    "tte_years",                # time-at-risk in years from entry
    "surv_duration", "surv_event",
    "label_1yr", "label_5yr", "label_10yr",
    "cohort_ahead_1995",
]
keep_cols = [c for c in keep_cols if c in merged.columns]
final_df = merged[keep_cols].copy()

out_path = os.path.join(PROC, "phase1_mortality_labels.parquet")
final_df.to_parquet(out_path, index=False)
log(f"  Saved: {out_path}  ({os.path.getsize(out_path)/1e3:.0f} KB)")
log(f"  Shape: {final_df.shape[0]:,} rows × {final_df.shape[1]} columns")

sep("PHASE 1 STATUS REPORT")
log(f"""
  DONE:
    ✓ Longitudinal IWSTAT + Finder merged on HHIDPN
    ✓ EXIT1-only death date rule enforced and assertion-checked
    ✓ POSTEXIT* confirmed structurally excluded from death_year computation
    ✓ EXIT2 error respondents flagged ({merged['is_exit2_error'].sum()} records)
    ✓ Binary labels: 1yr / 5yr / 10yr (censored before horizon → NaN, not 0)
    ✓ TTE survival object (surv_duration, surv_event) built
    ✓ AHEAD-1995 cohort flag added
    ✓ Orphaned exit IDs confirmed absent from analytic dataset
    ✓ 10 random death spot-checks traced above
    ✓ Final dataset saved to data/processed/phase1_mortality_labels.parquet

  KEY FINDINGS:
    See event counts table above (Step 4).
    Discordance between EXIT1 and IWSTAT decoded and reported.

  OPEN QUESTIONS (confirm before Phase 2):
    • Accept the IWSTAT=5 (no exit interview) respondents as confirmed dead
      using the wave year as approximate death year? (Year may be off by up
      to 2 years since HRS is biennial.)
    • For the 10yr binary label, confirm the proposed sample restriction
      (entry ≤ 2012) is handled by NaN labels, not row exclusion from the file?

  ─── AWAITING YOUR CONFIRMATION BEFORE PHASE 2 ───
""")

_fh.close()
print(f"\nFull log → {LOG_PATH}")
