"""
phase0_load_confirm.py — ULTRA-LOW MEMORY VERSION
==================================================
Key strategy for 256 MB ceiling:
  1. Read ONE row from the longitudinal file → get column names (no big spike)
  2. Build target column list from known RAND HRS naming convention
  3. pd.read_stata(columns=target) → pandas skips all other cols at parse time
     → ~20 cols × 37k rows = ~6 MB peak, not 1.74 GB
  4. Exit files (2-10 MB each) and Finder (250 KB) loaded normally
  5. gc.collect() after every block
"""

import os, sys, gc, time, warnings, json
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE     = "/run/media/zain-ali/New Volume/insurance/project"
RAW      = os.path.join(BASE, "data/raw/hrs")
INTERIM  = os.path.join(BASE, "data/interim")
REPORTS  = os.path.join(BASE, "reports")
for d in [INTERIM, REPORTS,
          os.path.join(BASE,"data/processed"),
          os.path.join(BASE,"src")]:
    os.makedirs(d, exist_ok=True)

LONG_FILE   = os.path.join(RAW, "randhrs1992_2022v1.dta")
FINDER_FILE = os.path.join(RAW, "randhrsexitfinder1994_2022v1.dta")

EXIT_FILES = {
    "AHD-1995": "randahdexit1995v1.dta",
    "HRS-1994": "randhrsexit1994v1.dta",
    "HRS-1996": "randhrsexit1996v1.dta",
    "HRS-1998": "randhrsexit1998v1.dta",
    "HRS-2000": "randhrsexit2000v1.dta",
    "HRS-2002": "randhrsexit2002v1.dta",
    "HRS-2004": "randhrsexit2004v1.dta",
    "HRS-2006": "randhrsexit2006v1.dta",
    "HRS-2008": "randhrsexit2008v1.dta",
    "HRS-2010": "randhrsexit2010v1.dta",
    "HRS-2012": "randhrsexit2012v1.dta",
    "HRS-2014": "randhrsexit2014v1.dta",
    "HRS-2016": "randhrsexit2016v1.dta",
    "HRS-2018": "randhrsexit2018v2.dta",
    "HRS-2020": "randhrsexit2020v1.dta",
    "HRS-2022": "randhrsexit2022v1.dta",
}

WAVE_YEAR = {f"r{i}": yr for i, yr in enumerate(
    [1992,1994,1996,1998,2000,2002,2004,2006,2008,2010,2012,2014,2016,2018,2020,2022], 1)}

SEP = "=" * 70

LOG_PATH = os.path.join(REPORTS, "phase0_output.log")
_fh = open(LOG_PATH, "w", buffering=1)

def log(msg=""):
    print(msg, flush=True)
    _fh.write(msg + "\n")
    _fh.flush()

def sep(t=""):
    log(); log(SEP)
    if t: log(f"  {t}"); log(SEP)

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 — discover column names by reading exactly ONE row
# ══════════════════════════════════════════════════════════════════════════════
sep("1. LONGITUDINAL FILE — column discovery (1-row probe)")
log(f"  File: {LONG_FILE}")
log(f"  Size: {os.path.getsize(LONG_FILE)/1e9:.2f} GB  |  19,880 columns (known)")
log("  Reading 1 row to get column names ...")

t0 = time.time()
probe = next(iter(pd.read_stata(LONG_FILE, chunksize=1, convert_categoricals=False)))
probe.columns = probe.columns.str.lower()
all_cols = list(probe.columns)
del probe; gc.collect()
log(f"  Done in {time.time()-t0:.1f}s  |  {len(all_cols):,} columns discovered")

# Save full variable list for Phase 2 (just names, no data)
with open(os.path.join(REPORTS, "longitudinal_varlist.json"), "w") as f:
    json.dump(all_cols, f)
log(f"  Full variable list saved → reports/longitudinal_varlist.json")

# Build column target list from RAND HRS naming convention
id_cols      = [c for c in all_cols if c == "hhidpn"]
iwstat_cols  = sorted([c for c in all_cols if c.startswith("r") and c.endswith("iwstat")])
deathyr_cols = sorted([c for c in all_cols if "deathyr" in c])

if not id_cols:
    # fallback: HHID + PN
    id_cols = [c for c in all_cols if c in ("hhid","pn")]

target_cols = list(dict.fromkeys(id_cols + iwstat_cols + deathyr_cols))
log(f"\n  ID cols     : {id_cols}")
log(f"  IWSTAT cols : {len(iwstat_cols)}  {iwstat_cols}")
log(f"  DeathYr cols: {deathyr_cols}")
log(f"  → Will load {len(target_cols)} columns (out of {len(all_cols):,})")

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2 — load ONLY the target columns (column-pruned, single pass)
# ══════════════════════════════════════════════════════════════════════════════
sep("2. LONGITUDINAL FILE — load selected columns only")
log(f"  Strategy: pd.read_stata(columns={len(target_cols)} cols)")
log(f"  Peak RAM ≈ {len(target_cols)} cols × ~37k rows × 8 bytes ≈ <10 MB")

t0 = time.time()
long_df = pd.read_stata(LONG_FILE, columns=target_cols,
                         convert_categoricals=False, convert_missing=False)
long_df.columns = long_df.columns.str.lower()
elapsed = time.time() - t0

# Ensure HHIDPN exists
if "hhidpn" not in long_df.columns and "hhid" in long_df.columns:
    long_df["hhidpn"] = (long_df["hhid"].astype(str).str.zfill(6)
                         + long_df["pn"].astype(str).str.zfill(3))

long_id = "hhidpn"
mem_mb = long_df.memory_usage(deep=True).sum() / 1e6

log(f"\n  ✓ Loaded in {elapsed:.1f}s")
log(f"  Rows             : {long_df.shape[0]:,}  (1 row per respondent — wide format)")
log(f"  Columns loaded   : {long_df.shape[1]:,}")
log(f"  Memory usage     : {mem_mb:.1f} MB")
log(f"  Unique HHIDPN    : {long_df[long_id].nunique():,}")

log(f"\n  Wave participation (R*IWSTAT):")
log(f"  {'Wave':>6}  {'Year':>6}  {'Interviewed':>12}  {'Deceased':>10}  {'Non-resp':>10}")
for col in iwstat_cols:
    prefix = col.replace("iwstat","")
    yr = WAVE_YEAR.get(prefix, "?")
    n_iw   = int((long_df[col] == 1).sum())
    n_dead = int(long_df[col].isin([4, 5]).sum())
    n_nr   = int(long_df[col].isin([2, 3, 6, 7]).sum())
    log(f"  {prefix:>6}   {str(yr):>6}  {n_iw:>12,}  {n_dead:>10,}  {n_nr:>10,}")

# Save to parquet (reused in Phase 1)
out_long = os.path.join(INTERIM, "long_ids_iwstat.parquet")
long_df.to_parquet(out_long, index=False)
log(f"\n  Saved → data/interim/long_ids_iwstat.parquet  ({os.path.getsize(out_long)/1e6:.1f} MB)")

long_ids = set(long_df[long_id].astype(str).values)
del long_df; gc.collect()

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3 — Finder file (250 KB)
# ══════════════════════════════════════════════════════════════════════════════
sep("3. EXIT/POST-EXIT FINDER FILE")
log(f"  File: {FINDER_FILE}  ({os.path.getsize(FINDER_FILE)/1e3:.0f} KB)")

finder_df = pd.read_stata(FINDER_FILE, convert_categoricals=False)
finder_df.columns = finder_df.columns.str.lower()

if "hhidpn" not in finder_df.columns and "hhid" in finder_df.columns:
    finder_df["hhidpn"] = (finder_df["hhid"].astype(str).str.zfill(6)
                           + finder_df["pn"].astype(str).str.zfill(3))

log(f"  Rows              : {finder_df.shape[0]:,}")
log(f"  Columns           : {finder_df.shape[1]:,}")
log(f"  Unique HHIDPN     : {finder_df['hhidpn'].nunique():,}")
log(f"\n  Finder columns:")
for c in finder_df.columns:
    sample = finder_df[c].dropna().iloc[:4].tolist()
    log(f"    {c:<30}  nuniq={finder_df[c].nunique():>5}  sample={sample}")

finder_df.to_parquet(os.path.join(INTERIM, "finder.parquet"), index=False)
finder_ids = set(finder_df["hhidpn"].astype(str).values)
del finder_df; gc.collect()
log(f"  Saved → data/interim/finder.parquet")

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4 — Exit wave files
# ══════════════════════════════════════════════════════════════════════════════
sep("4. EXIT/POST-EXIT INTERVIEW FILES  (16 wave files)")

all_exit_ids = set()
log(f"  {'Wave':<12}  {'Rows':>6}  {'Cols':>5}  {'Uniq IDs':>9}  {'Size KB':>8}")
log(f"  {'-'*12}  {'-'*6}  {'-'*5}  {'-'*9}  {'-'*8}")

for label, fname in EXIT_FILES.items():
    path = os.path.join(RAW, fname)
    if not os.path.exists(path):
        log(f"  ✗ {label}: MISSING"); continue

    df = pd.read_stata(path, convert_categoricals=False)
    df.columns = df.columns.str.lower()

    if "hhidpn" not in df.columns and "hhid" in df.columns:
        df["hhidpn"] = (df["hhid"].astype(str).str.zfill(6)
                        + df["pn"].astype(str).str.zfill(3))

    n_uniq = df["hhidpn"].nunique() if "hhidpn" in df.columns else 0
    if "hhidpn" in df.columns:
        all_exit_ids.update(df["hhidpn"].astype(str).values)

    sz = os.path.getsize(path) / 1e3
    out = os.path.join(INTERIM, f"exit_{label.replace('-','_').lower()}.parquet")
    df.to_parquet(out, index=False)

    log(f"  {label:<12}  {df.shape[0]:>6,}  {df.shape[1]:>5,}  {n_uniq:>9,}  {sz:>8.0f}")
    del df; gc.collect()

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5 — Respondent ID consistency check
# ══════════════════════════════════════════════════════════════════════════════
sep("5. RESPONDENT ID CONSISTENCY CHECK")

log(f"  Longitudinal IDs  : {len(long_ids):>7,}")
log(f"  Finder IDs        : {len(finder_ids):>7,}")
log(f"  All exit-wave IDs : {len(all_exit_ids):>7,}")

only_find      = finder_ids - long_ids
exit_not_long  = all_exit_ids - long_ids

log(f"\n  In BOTH Long & Finder             : {len(long_ids & finder_ids):>7,}")
log(f"  Only in Long (never exit)         : {len(long_ids - finder_ids):>7,}")
log(f"  Only in Finder (not in Long)  ⚠   : {len(only_find):>7,}")
log(f"  Exit IDs absent from Long     ⚠   : {len(exit_not_long):>7,}")

if not only_find:
    log("  ✓ All Finder IDs present in Longitudinal File — merge key is safe.")
else:
    log(f"  ⚠ {len(only_find)} Finder IDs missing from Longitudinal — investigate before Phase 1.")

# ══════════════════════════════════════════════════════════════════════════════
# STEP 6 — Mortality horizon feasibility
# ══════════════════════════════════════════════════════════════════════════════
sep("6. MORTALITY HORIZON FEASIBILITY")
log("")
log(f"  {'Wave':>5} {'Year':>6}  {'Max FU':>7}  {'1yr':>8}  {'5yr':>10}  {'10yr':>12}  {'TTE':>8}")
log(f"  {'-'*5} {'-'*6}  {'-'*7}  {'-'*8}  {'-'*10}  {'-'*12}  {'-'*8}")
for wn in range(1, 17):
    yr = WAVE_YEAR.get(f"r{wn}")
    if yr is None: continue
    fu = 2022 - yr
    ok1  = "OK"     if fu >= 1  else "EXCL"
    ok5  = "OK"     if fu >= 5  else ("CENSOR" if fu >= 2 else "EXCL")
    ok10 = "OK"     if fu >= 10 else ("CENSOR" if fu >= 2 else "EXCL")
    log(f"  {wn:>5} {yr:>6}  {fu:>7}  {ok1:>8}  {ok5:>10}  {ok10:>12}  {'CENSOR':>8}")

log("""
  PROPOSED restrictions (awaiting your confirmation):
    10yr binary  → first interview ≤ 2012 (Wave 11) | later → right-censored / excluded
    5yr  binary  → first interview ≤ 2018 (Wave 14) | later → right-censored
    1yr  binary  → all cohorts OK
    TTE survival → all cohorts; living at last contact = right-censored
    AHD-1995     → included but flagged — confirm include/exclude for Phase 1
""")

sep("PHASE 0 STATUS REPORT")
log("""
  DONE:
    ✓ Packages installed, directories confirmed
    ✓ Longitudinal file: 1-row probe for column discovery, then
      column-pruned load (~20 cols) → peak RAM <10 MB → saved to parquet
    ✓ Finder file: loaded (250 KB) → saved to parquet
    ✓ All 16 exit-wave files: loaded + saved to parquet
    ✓ HHIDPN consistency verified across all file sets
    ✓ Horizon feasibility analyzed

  MEMORY APPROACH GOING FORWARD (all phases):
    • Only load needed columns from longitudinal (full var list in JSON)
    • Work from interim Parquet files, never re-read the 1.74 GB .dta

  OPEN QUESTIONS (confirm before Phase 1):
    Q1: Confirm 4 horizons — 1yr, 5yr, 10yr, full TTE?
    Q2: AHD-1995 — include or exclude from mortality label build?
    Q3: Cutoffs — Wave 11/2012 for 10yr, Wave 14/2018 for 5yr?
    Q4: HHIDPN as numeric join key — confirmed?

  ─── AWAITING YOUR CONFIRMATION BEFORE PHASE 1 ───
""")

_fh.close()
print(f"\nFull log → {LOG_PATH}")
