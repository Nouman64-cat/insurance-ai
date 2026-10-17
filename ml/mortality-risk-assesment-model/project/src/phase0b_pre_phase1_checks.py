"""
phase0b_pre_phase1_checks.py
=============================
Two mandatory pre-Phase-1 investigations:
  A) Identify and explain the 76 Finder IDs absent from Longitudinal File
  B) Confirm Finder File column semantics from README (documented, not inferred)
"""

import os, gc, warnings
import pandas as pd
import numpy as np

warnings.filterwarnings("ignore")

BASE    = "/run/media/zain-ali/New Volume/insurance/project"
INTERIM = os.path.join(BASE, "data/interim")
REPORTS = os.path.join(BASE, "reports")
RAW     = os.path.join(BASE, "data/raw/hrs")

LOG_PATH = os.path.join(REPORTS, "phase0b_pre_phase1_checks.log")
_fh = open(LOG_PATH, "w", buffering=1)

def log(msg=""):
    print(msg, flush=True)
    _fh.write(msg + "\n"); _fh.flush()

SEP = "=" * 70
def sep(t=""):
    log(); log(SEP)
    if t: log(f"  {t}"); log(SEP)

# ══════════════════════════════════════════════════════════════════════════════
# PART A — Finder README semantics (confirmed from document, not inferred)
# ══════════════════════════════════════════════════════════════════════════════
sep("PART A — FINDER FILE COLUMN SEMANTICS (from README_exitfinder.pdf)")

log("""
  Source: README_exitfinder.pdf (May 2025), RAND HRS Exit and Post-Exit Finder File

  Variable definitions AS DOCUMENTED:
  ─────────────────────────────────────────────────────────────────────────────
  HHIDPN     Unique person ID (numeric). Universal join key across all RAND files.

  EXIT1      Year the respondent's EXIT INTERVIEW was conducted.
             (Normal case: respondent died, proxy interview happened.)
             Missing → respondent has no exit interview.

  EXIT2      Year a SECOND exit interview was administered — IN ERROR — to
             exactly TWO respondents (HHIDPN = 11863010 and 203802010).
             This is a data artifact, NOT a meaningful second death event.
             ► Decision for Phase 1: EXIT2 is ignored for mortality label
               construction. Those two respondents' EXIT1 year is their death year.

  POSTEXIT1  Year of the FIRST Post-Exit Interview.
  POSTEXIT2  Year of the SECOND Post-Exit Interview.
  POSTEXIT3  Year of the THIRD Post-Exit Interview.

  What is a Post-Exit Interview?
    A follow-up contact AFTER the initial exit interview, conducted because
    the estate was not yet settled at exit time (home unsold, will not probated,
    assets not distributed). Drawn from exit interviews from the PRIOR TWO WAVES.
    The same respondent can have up to 3 post-exit contacts across multiple years.
    ► A Post-Exit contact does NOT indicate a second death — the respondent was
      already confirmed deceased at EXIT1. It is purely an estate/asset follow-up.

  Can EXIT and POSTEXIT co-exist for the same respondent? YES, by design.
    EXIT1  = death confirmed → exit interview year
    POSTEXIT1/2/3 = subsequent estate follow-ups (same deceased person)
    The README explicitly states: "The same person never has both an Exit
    Interview AND Post-Exit Interview IN THE SAME YEAR" — but they can
    (and commonly do) occur in DIFFERENT years.

  POST_EXIT flag in the exit wave files:
    POST_EXIT = 0  →  Exit Interview record
    POST_EXIT = 1  →  Post-Exit Interview record
    Both record types are stored together in each wave file, separated by this flag.

  MERGE LOGIC (confirmed from README, not inferred):
    1. Use HHIDPN to left-join Finder onto Longitudinal.
    2. Read EXIT1 to get the wave/year of the exit interview (= confirmed death year).
    3. Then join to the corresponding exit-wave file (e.g., EXIT1=2008 → use
       randhrsexit2008v2.dta) filtered to POST_EXIT=0 to get exit interview details.
    4. Optionally join POSTEXIT1/2/3 waves for estate-related fields if needed,
       filtered to POST_EXIT=1.
    5. EXIT2 → ignore for mortality label (documented data entry error, only 2 cases).

  MORTALITY LABEL VARIABLE WITHIN EXIT FILES:
    Death is NOT inferred from mere presence of an exit record. The IWSTAT
    variable in the Longitudinal File (values 4 or 5) is the authoritative
    death indicator. EXIT1 year gives us the exact wave. Cause-adjacent fields
    (health at last interview, proxy-reported conditions) live in the exit file.
  ─────────────────────────────────────────────────────────────────────────────
  ✓ Semantics fully documented. No inference used above.
""")

# Verify: show the 2 EXIT2 respondents from the file
finder_df = pd.read_parquet(os.path.join(INTERIM, "finder.parquet"))
exit2_mask = finder_df["exit2"].notna()
log(f"  Verification — respondents with EXIT2 (should be exactly 2 per README):")
log(f"  {finder_df[exit2_mask][['hhidpn','exit1','exit2','postexit1','postexit2','postexit3']].to_string(index=False)}")

# Show distribution of post-exit counts
log(f"\n  Post-exit interview distribution:")
for col in ["postexit1","postexit2","postexit3"]:
    n = finder_df[col].notna().sum()
    log(f"    {col}: {n:,} respondents have this interview")

# ══════════════════════════════════════════════════════════════════════════════
# PART B — Investigate the 76 orphaned Finder IDs
# ══════════════════════════════════════════════════════════════════════════════
sep("PART B — INVESTIGATION: 76 FINDER IDs NOT IN LONGITUDINAL FILE")

long_df    = pd.read_parquet(os.path.join(INTERIM, "long_ids_iwstat.parquet"))
long_ids   = set(long_df["hhidpn"].astype(str).values)

finder_ids = set(finder_df["hhidpn"].astype(str).values)
orphans    = finder_ids - long_ids
log(f"  Orphaned Finder IDs (in Finder but NOT in Longitudinal): {len(orphans)}")

# Pull orphan rows from finder
orphan_df = finder_df[finder_df["hhidpn"].astype(str).isin(orphans)].copy()
log(f"\n  Orphan records in Finder File:")
log(orphan_df.to_string(index=False))

# Now search for these IDs in every exit wave file
log(f"\n  Searching for orphaned IDs across all exit-wave parquet files ...")

exit_hits = []
for fname in os.listdir(INTERIM):
    if not (fname.startswith("exit_") and fname.endswith(".parquet")):
        continue
    wave_label = fname.replace("exit_","").replace(".parquet","").upper().replace("_","-")
    df = pd.read_parquet(os.path.join(INTERIM, fname))
    df["hhidpn"] = df["hhidpn"].astype(str)
    hits = df[df["hhidpn"].isin(orphans)].copy()
    if len(hits) > 0:
        hits["source_wave"] = wave_label
        # Identify POST_EXIT flag if present
        if "post_exit" in hits.columns:
            hits["is_postexit"] = hits["post_exit"].astype(int)
        else:
            hits["is_postexit"] = -1
        exit_hits.append(hits[["hhidpn","source_wave","is_postexit"]
                               + [c for c in hits.columns
                                  if c not in ("hhidpn","source_wave","is_postexit")][:3]])
    del df; gc.collect()

if exit_hits:
    combined = pd.concat(exit_hits, ignore_index=True)
    log(f"\n  Found {len(combined)} exit-file records matching orphaned IDs:")
    log(combined[["hhidpn","source_wave","is_postexit"]].to_string(index=False))
    # Summarise: are they exit or post-exit?
    log(f"\n  POST_EXIT flag breakdown for orphan hits (0=Exit, 1=PostExit, -1=flag absent):")
    log(f"  {combined['is_postexit'].value_counts().to_string()}")
else:
    log("  → No orphaned IDs found in any exit-wave file.")

# Decode HHIDPN to HHID + PN to look for household membership pattern
log(f"\n  Decoding HHIDPN → HHID + PN to check household membership pattern:")
log(f"  (HHIDPN = HHID * 1000 + PN; PN=010=primary respondent, PN=020=spouse)")
orphan_df["hhidpn_num"] = pd.to_numeric(orphan_df["hhidpn"], errors="coerce")
orphan_df["hhid_dec"]   = (orphan_df["hhidpn_num"] // 1000).astype("Int64")
orphan_df["pn_dec"]     = (orphan_df["hhidpn_num"] % 1000).astype("Int64")

pn_counts = orphan_df["pn_dec"].value_counts().sort_index()
log(f"\n  PN values among the 76 orphans (tells us primary vs spouse):")
log(f"  {pn_counts.to_string()}")

# Check: for each orphan HHID, does that household appear in the Longitudinal file?
long_df["hhid_dec"] = (long_df["hhidpn"] // 1000).astype("Int64")
orphan_hhids = set(orphan_df["hhid_dec"].dropna().astype(int).values)
long_hhids   = set(long_df["hhid_dec"].dropna().astype(int).values)

hhid_overlap = orphan_hhids & long_hhids
hhid_only_orphan = orphan_hhids - long_hhids

log(f"\n  Orphan HHIDs that DO appear in Longitudinal (different PN/person): {len(hhid_overlap):,}")
log(f"  Orphan HHIDs with NO presence in Longitudinal at all             : {len(hhid_only_orphan):,}")

if hhid_overlap:
    log(f"\n  For households present in both files — showing the PN that IS in Longitudinal:")
    for hhid in sorted(list(hhid_overlap))[:20]:
        long_rows = long_df[long_df["hhid_dec"] == hhid]["hhidpn"].tolist()
        orph_rows = orphan_df[orphan_df["hhid_dec"] == hhid]["hhidpn"].tolist()
        log(f"    HHID={hhid}  Longitudinal PNs={[x % 1000 for x in long_rows]}  "
            f"Orphan PNs={[int(x) % 1000 for x in orph_rows]}")

# ── Conclusion ─────────────────────────────────────────────────────────────────
sep("CONCLUSION & PHASE 1 DECISION")

log("""
  EXIT2 / POSTEXIT semantics — CONFIRMED (not inferred):
  ──────────────────────────────────────────────────────
  • EXIT1   = year of the (one) real exit interview → this is death year
  • EXIT2   = administrative error affecting exactly 2 respondents → IGNORE
  • POSTEXIT1/2/3 = estate follow-up contacts for an already-confirmed deceased
                    respondent → useful for asset/estate variables, NOT for
                    establishing death date (death already confirmed at EXIT1)
  • POST_EXIT flag inside wave files: 0=exit, 1=post-exit (same file, separate rows)
  • Merge rule: HHIDPN left-join Finder; EXIT1 → wave file → filter POST_EXIT=0
                for core exit interview; POSTEXIT* → filter POST_EXIT=1 if needed

  76 Orphaned Finder IDs — FINDING:
  ───────────────────────────────────
  See PN breakdown above. If PN values cluster around 020/030 (spouse/partner)
  and their HHID exists in Longitudinal under PN=010, these are SPOUSE-ONLY
  exit records — the respondent is a household member who had an exit interview
  but was never themselves a primary respondent (never appeared in core waves).
  This is a known HRS feature: spouses of primary respondents can receive exit
  interviews even if they were never directly interviewed.

  PROPOSED DECISION for Phase 1:
  • If orphans are spouse-only (PN=020): EXCLUDE from primary mortality label
    construction — they have no baseline interview data (no features to model).
    Log their IDs in a separate file for audit trail.
  • If any orphan HHID has NO presence in Longitudinal at all: investigate
    those specifically — could be genuine data anomaly.
  • If any orphan is PN=010 (primary respondent): ALERT — this is unexpected
    and must be manually reviewed before proceeding.

  ─── REPORTING BACK — AWAITING FINAL CONFIRMATION FOR PHASE 1 ───
""")

_fh.close()
print(f"\nFull log → {LOG_PATH}")
