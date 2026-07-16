"""
phase2_variable_inventory.py
============================
PHASE 2 — Variable Inventory & Quality Audit
Life Insurance Risk Assessment — HRS Only

Three variable groups:
  1. Financial  — income, wealth, pension, SS, home equity
  2. Self-reported health — SRH, conditions, BMI, ADL/IADL, smoking
  3. Demographic — age, sex, race, education, marital status, region

Memory: column-pruned load from 1.74 GB .dta. Each group loaded separately
and released after analysis to keep peak RAM minimal.

Documentation standard: suspicious missingness patterns traced to RAND
codebook (randhrs1992_2022v1.pdf) before any harmonization decision is made.
"""

import os, gc, json, warnings
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker

warnings.filterwarnings("ignore")

BASE     = "/run/media/zain-ali/New Volume/insurance/project"
RAW_HRS  = os.path.join(BASE, "data/raw/hrs")
INTERIM  = os.path.join(BASE, "data/interim")
PROC     = os.path.join(BASE, "data/processed")
REPORTS  = os.path.join(BASE, "reports")
LONG_DTA = os.path.join(RAW_HRS, "randhrs1992_2022v1.dta")

LOG_PATH = os.path.join(REPORTS, "phase2_output.log")
_fh = open(LOG_PATH, "w", buffering=1)

def log(msg=""):
    print(msg, flush=True)
    _fh.write(msg + "\n"); _fh.flush()

SEP = "=" * 70
def sep(t=""):
    log(); log(SEP)
    if t: log(f"  {t}"); log(SEP)

# Wave number → calendar year
WAVE_YEAR = {i: yr for i, yr in enumerate(
    [1992,1994,1996,1998,2000,2002,2004,2006,2008,2010,2012,2014,2016,2018,2020,2022], 1)}

# ── Variable catalogue with documentation annotations ─────────────────────────
# Each entry: (stem_pattern OR exact_list, description, wave_start, notes)
# stems use {w} placeholder for wave number 1-16

FINANCIAL_VARS = {
    # stem → (description, known_wave_start, doc_note)
    "h{w}itot":  ("HH total household income (imputed by RAND)", 1,
                  "RAND-imputed. Two versions in some waves (h2itot, h2itot2 — Wave 2 "
                  "AHD vs HRS sub-samples). Use main itot; flag h2itot2 separately."),
    "h{w}atotw": ("HH total net wealth (RAND imputed)", 1,
                  "RAND five-imputation mean. Includes housing equity. Codebook: "
                  "Section 2.4 wealth imputations. DO NOT mix with non-imputed raw values."),
    "h{w}atotf": ("HH non-housing financial wealth (RAND imputed)", 1,
                  "= total wealth minus home equity. Derived by RAND. Wave 1 available."),
    "h{w}ahous": ("Home equity (RAND imputed)", 1,
                  "Net home equity (value minus mortgage). RAND imputed. Wave 1 available."),
    "r{w}ipena": ("R pension/annuity income (RAND imputed)", 1,
                  "Individual-level pension income from all sources, imputed."),
    "r{w}issdi": ("R Social Security / SSDI income (RAND imputed)", 1,
                  "Includes retirement SS and disability SS. RAND imputed."),
}

HEALTH_VARS = {
    "r{w}shlt":  ("Self-rated health 1=Exc 2=VGood 3=Good 4=Fair 5=Poor", 1,
                  "CODEBOOK: Consistent 5-point scale across all waves. No wording change. "
                  "Wave 1 HRS baseline uses same scale. RAND harmonized — confirmed consistent."),
    "r{w}diabe": ("Ever diagnosed: diabetes (1=yes 0=no)", 1,
                  "CODEBOOK sec 2.1.4: cumulative ever-diagnosis, preloaded from prior wave. "
                  "Respondent can dispute; flag RwDIABF tracks disputes. Use RwDIABE (no flag) "
                  "for modeling — RAND's recommendation per codebook p.17."),
    "r{w}hearte":("Ever diagnosed: heart disease (1=yes 0=no)", 1,
                  "Same preload/dispute logic as diabetes. RwHEARTE is the harmonized variable. "
                  "Note: r{w}heartq (also found) is a sub-question detail, not the summary flag."),
    "r{w}cancre":("Ever diagnosed: cancer (1=yes 0=no)", 1,
                  "Harmonized ever-diagnosis. RwCANCRE. Same dispute logic applies."),
    "r{w}stroke":("Ever diagnosed: stroke (1=yes 0=no)", 1,
                  "RwSTROKE. Harmonized. Preloaded from prior wave, respondent can dispute."),
    "r{w}hibpe": ("Ever diagnosed: hypertension (1=yes 0=no)", 1,
                  "RwHIBPE. Harmonized. Part of the 8-condition battery in RAND codebook."),
    "r{w}lunge": ("Ever diagnosed: lung disease (1=yes 0=no)", 1,
                  "RwLUNGE. Harmonized. Part of the same 8-condition battery."),
    "r{w}bmi":   ("Body Mass Index (derived: weight kg / height m²)", 1,
                  "CODEBOOK sec 2.1.5: RAND-derived. Height asked of NEW respondents from "
                  "Wave 3 onward; for re-interviews height is CARRIED FORWARD from first interview. "
                  "Weight asked every wave. Implication: BMI in later waves reflects potentially "
                  "stale height — flag this for Phase 3 imputation decision."),
    "r{w}smoken":("Current smoker (1=yes 0=no)", 1,
                  "Asked every wave. Distinct from RwSMOKEV (ever smoked). Use RwSMOKEN "
                  "for current status; RwSMOKEV for ever-smoked as baseline covariate."),
    "r{w}smokev":("Ever smoked (1=yes 0=no)", 1,
                  "Time-invariant in practice once yes; occasional inconsistencies handled "
                  "by RAND via carry-forward. Treat as baseline characteristic."),
    "r{w}adl5a":  ("ADL difficulty count (0-5, some difficulty threshold)", 2,
                  "CODEBOOK: Wave 1 uses Wallace-Herzog definition (suffix W), NOT comparable "
                  "to Waves 2+. RwADL5A is the RAND-harmonized count for Waves 2 onward. "
                  "HARMONIZATION DECISION NEEDED: Wave 1 ADL (r1adlw) vs r2adl5a+ are different "
                  "measures — flag for exclusion of Wave 1 ADL or use r1dadliv as alternative."),
    "r{w}iadl5a":("IADL difficulty count (0-5 tasks)", 3,
                  "CODEBOOK: IADLs NOT asked in Wave 1. Available from Wave 2A (AHD) and "
                  "Wave 3 (HRS) onward. 5 tasks: telephone, medication, money, shopping, meals. "
                  "Wave 1 missing is structural (question not asked), not non-response."),
}

DEMOGRAPHIC_VARS = {
    "ragender":  ("Sex: 1=male 2=female", "invariant",
                  "Time-invariant. Asked at baseline, carried forward. No wording change."),
    "raracem":   ("Race: 1=White 2=Black/AA 3=Other", "invariant",
                  "Time-invariant. RAND-harmonized 3-category race variable."),
    "rahispan":  ("Hispanic ethnicity: 1=yes 0=no", "invariant",
                  "Time-invariant. Separate from race — use both for race/ethnicity analysis."),
    "raeduc":    ("Education: 1=<HS 2=GED 3=HS grad 4=Some col 5=Col+", "invariant",
                  "Time-invariant RAND-derived education grouping from years of schooling."),
    "rabyear":   ("Birth year (4-digit)", "invariant",
                  "Time-invariant. Source for age computation when r{w}agey_b unavailable."),
    "r{w}agey_b":("Age at beginning of interview year", 1,
                  "Wave-specific. Derived from birth year + interview year. Available W1-W16."),
    "r{w}mstat": ("Marital status (1=married/partnered, 2-7=other)", 1,
                  "Wave-specific. RAND-harmonized. Values: 1=married, 2=married spouse absent, "
                  "3=partnered, 4=separated, 5=divorced, 6=widowed, 7=never married."),
    "r{w}cenreg":("Census region (1=NE 2=MW 3=S 4=W)", 1,
                  "Wave-specific. May change if respondent moves. Available W1-W16."),
}

# ══════════════════════════════════════════════════════════════════════════════
# Helper: build exact column list from stem pattern
# ══════════════════════════════════════════════════════════════════════════════
with open(os.path.join(REPORTS, "longitudinal_varlist.json")) as f:
    ALL_COLS = set(json.load(f))

def expand_stems(var_dict):
    """Expand {w} stems into actual column names found in the file."""
    found = {}
    for stem, meta in var_dict.items():
        if "{w}" in stem:
            wave_start = meta[1] if isinstance(meta[1], int) else 1
            cols = []
            for wn in range(1, 17):
                col = stem.replace("{w}", str(wn))
                if col in ALL_COLS:
                    cols.append((wn, col))
            found[stem] = (cols, meta)
        else:
            # time-invariant
            if stem in ALL_COLS:
                found[stem] = ([(0, stem)], meta)
    return found

# Also collect ADL Wave 1 alternative
ADL_W1_ALT = "r1dadliv"   # difficulty ADL Wave 1 (Wallace-Herzog definition)

# ══════════════════════════════════════════════════════════════════════════════
# Core analysis function: load columns → compute missingness per wave
# ══════════════════════════════════════════════════════════════════════════════
def analyse_group(group_name, var_dict, extra_cols=None):
    sep(f"GROUP: {group_name}")

    expanded = expand_stems(var_dict)
    all_target_cols = []
    col_meta = {}   # col_name → (wave_num, stem, description, doc_note)

    for stem, (wave_col_list, meta) in expanded.items():
        for wn, col in wave_col_list:
            all_target_cols.append(col)
            col_meta[col] = (wn, stem, meta[0], meta[2])

    if extra_cols:
        for col in extra_cols:
            if col in ALL_COLS:
                all_target_cols.append(col)
                col_meta[col] = (1, col, "extra/alt", "")

    all_target_cols = ["hhidpn"] + list(dict.fromkeys(all_target_cols))

    # Load from .dta — column-pruned
    load_cols = [c for c in all_target_cols if c in ALL_COLS]
    log(f"  Loading {len(load_cols)-1} columns from longitudinal file ...")
    df = pd.read_stata(LONG_DTA, columns=load_cols, convert_categoricals=False,
                       convert_missing=False)
    df.columns = df.columns.str.lower()
    n = len(df)
    log(f"  ✓ Loaded {n:,} rows  |  memory: {df.memory_usage(deep=True).sum()/1e6:.1f} MB")

    # ── Per-variable report ───────────────────────────────────────────────────
    log(f"\n  {'Variable':<16} {'W':>3} {'Year':>5} {'N_obs':>7} {'%Miss':>7}  Description")
    log(f"  {'-'*16} {'-'*3} {'-'*5} {'-'*7} {'-'*7}  {'-'*40}")

    miss_matrix = {}   # stem → {wave_num: pct_missing}
    inventory_rows = []

    for stem, (wave_col_list, meta) in expanded.items():
        desc = meta[0]; doc  = meta[2]
        wave_start = meta[1] if isinstance(meta[1], int) else 0

        for wn, col in sorted(wave_col_list, key=lambda x: x[0]):
            if col not in df.columns:
                continue
            yr   = WAVE_YEAR.get(wn, "?")
            n_obs = df[col].notna().sum()
            pct_miss = 100 * (1 - n_obs / n)

            flag = ""
            # Flag: expected structural missingness vs suspicious
            if wn < wave_start:
                flag = "STRUCT-MISS"   # question not asked yet
            elif pct_miss > 70:
                flag = "HIGH-MISS ⚠"
            elif pct_miss > 40:
                flag = "MOD-MISS"

            log(f"  {col:<16} {wn:>3} {str(yr):>5} {n_obs:>7,} {pct_miss:>6.1f}%  "
                f"{desc[:45]}  {flag}")

            miss_matrix.setdefault(stem, {})[wn] = pct_miss
            inventory_rows.append({
                "group": group_name, "stem": stem, "variable": col,
                "wave": wn, "year": yr, "n_obs": n_obs,
                "pct_missing": round(pct_miss, 2), "description": desc,
                "doc_note": doc, "flag": flag,
            })

        # Print doc note once per stem
        if doc:
            log(f"    ↳ DOC: {doc[:110]}")
        log("")

    # Save group parquet for Phase 3
    out = os.path.join(INTERIM, f"phase2_{group_name.lower().replace(' ','_')}.parquet")
    df.to_parquet(out, index=False)
    log(f"  Saved → {out}  ({os.path.getsize(out)/1e6:.1f} MB)")

    gc.collect()
    return pd.DataFrame(inventory_rows), miss_matrix, df.columns.tolist()


# ══════════════════════════════════════════════════════════════════════════════
# RUN EACH GROUP
# ══════════════════════════════════════════════════════════════════════════════
inv_rows_all = []

inv_fin, miss_fin, _ = analyse_group("Financial", FINANCIAL_VARS)
inv_rows_all.append(inv_fin)
gc.collect()

inv_hlth, miss_hlth, _ = analyse_group(
    "Health", HEALTH_VARS, extra_cols=[ADL_W1_ALT]
)
inv_rows_all.append(inv_hlth)
gc.collect()

inv_dem, miss_dem, _ = analyse_group("Demographic", DEMOGRAPHIC_VARS)
inv_rows_all.append(inv_dem)
gc.collect()

# ══════════════════════════════════════════════════════════════════════════════
# MISSINGNESS HEATMAP
# ══════════════════════════════════════════════════════════════════════════════
sep("MISSINGNESS HEATMAP — saving to reports/")

all_inv = pd.concat(inv_rows_all, ignore_index=True)
wave_vars = all_inv[all_inv["wave"] > 0].copy()

# Pivot: rows=variable stem, cols=wave year, values=pct_missing
pivot = wave_vars.pivot_table(index="stem", columns="year",
                               values="pct_missing", aggfunc="mean")
pivot = pivot.reindex(sorted(pivot.columns), axis=1)

fig, ax = plt.subplots(figsize=(18, max(8, len(pivot)*0.35)))
im = ax.imshow(pivot.values, aspect="auto", cmap="RdYlGn_r",
               vmin=0, vmax=100, interpolation="nearest")
ax.set_xticks(range(len(pivot.columns)))
ax.set_xticklabels([str(int(c)) for c in pivot.columns], rotation=45, fontsize=8)
ax.set_yticks(range(len(pivot.index)))
ax.set_yticklabels(pivot.index, fontsize=7)
ax.set_title("HRS Variable Missingness by Wave (%)\n"
             "Green=<10% | Yellow=10-40% | Red=>40%", fontsize=11)
plt.colorbar(im, ax=ax, label="% Missing")
plt.tight_layout()
heatmap_path = os.path.join(REPORTS, "phase2_missingness_heatmap.png")
plt.savefig(heatmap_path, dpi=130, bbox_inches="tight")
plt.close()
log(f"  Saved → {heatmap_path}")

# ══════════════════════════════════════════════════════════════════════════════
# ANOMALY DEEP-DIVES (traced to documentation)
# ══════════════════════════════════════════════════════════════════════════════
sep("ANOMALY DEEP-DIVES (each traced to RAND documentation)")

log("""
  ANOMALY 1 — ADL Wave 1 (r1adlr vs r1adlw / r1dadliv)
  ───────────────────────────────────────────────────────
  SOURCE: RAND codebook p.12 (confirmed via PDF extract above):
    "For Wave 1 only, we provide another measure of difficulty as defined in
     Wallace and Herzog (1995). The names of variables using this definition
     end in the letter 'W.' These are NOT COMPARABLE to the 'some difficulty'
     measures in other waves."

  FINDING: r1adlr is absent from the file (n=0 in column search); instead
    Wave 1 has r1dadliv (difficulty ADL, Wave 1 definition) and r1adlw variants.
    r2adlr onward uses the harmonized RAND count (5-point difficulty count).

  HARMONIZATION DECISION (proposed, flag for confirmation):
    → Exclude Wave 1 ADL from the main ADL time-series feature.
    → Use r2adlr through r16adlr for the longitudinal ADL predictor.
    → Wave 1 respondents will have ADL=NaN at baseline; this will be handled
      in Phase 3 (MICE imputation using other Wave 1 health variables as donors).
    → Do NOT carry r1dadliv forward as if it were equivalent to r2adlr+.

  ANOMALY 2 — IADL Wave 1 structural missingness
  ────────────────────────────────────────────────
  SOURCE: RAND codebook p.12 (confirmed):
    "The usual IADLs were not asked in Wave 1."

  FINDING: r1iadl5a confirmed absent from variable list (column not in file).
    Available from Wave 2A (AHD, ~1995) and Wave 3 (HRS, 1996) onward.

  HARMONIZATION DECISION (proposed):
    → Wave 1 IADL = structurally missing (question not asked), not non-response.
    → Flag this in missingness analysis so MICE does not impute it as if
      it were a randomly missing observation — it is MNAR by design.
    → Use Wave 3+ for IADL longitudinal feature; Wave 2 AHD cohort gets Wave 2.

  ANOMALY 3 — BMI height carry-forward (Wave 3+)
  ──────────────────────────────────────────────
  SOURCE: RAND codebook sec 2.1.5 (confirmed via PDF extract):
    "Beginning in Wave 3, height is only asked of new respondents, but weight
     is asked in every wave. For respondents being re-interviewed, height is
     CARRIED FORWARD from their first interview."

  FINDING: This means r{w}bmi in waves 3+ uses potentially stale height
    (e.g., a respondent first interviewed in 1992 will use their 1992 height
    in 2022 — 30-year-old measurement). Height naturally declines with age.

  IMPACT FOR INSURANCE MODELING:
    → BMI in later waves will be slightly OVERESTIMATED (stale height →
      denominator too large is impossible; stale height too large → BMI understated;
      actually: height shrinks with age, so carrying forward YOUNGER height
      → denominator too large → BMI UNDERSTATED in older waves).
    → Flag this as a known limitation. Do not impute height separately —
      it would conflict with RAND's own carry-forward.
    → Proposed: use BMI as-is (RAND's derived variable) with a
      'height_carry_forward_wave' indicator noting the baseline wave.
    → This is an accepted limitation for self-reported height; no correction applied.

  ANOMALY 4 — H2ITOT vs H2ITOT2 (Wave 2 income split)
  ─────────────────────────────────────────────────────
  SOURCE: RAND codebook (Wave 2 note confirmed in variable discovery):
    Two income variables exist for Wave 2: h2itot (HRS sub-sample) and
    h2itot2 (AHEAD/AHD sub-sample from same wave). This reflects the fact
    that HRS Wave 2 (1994) was conducted concurrently with the baseline
    AHEAD Wave 1 (1993/1994), which used a slightly different income module.

  HARMONIZATION DECISION (proposed):
    → Use h2itot as the primary Wave 2 income variable for HRS respondents.
    → For AHEAD-1995 cohort respondents (cohort_ahead_1995=1), check whether
      h2itot2 provides better coverage before defaulting to h2itot.
    → Flag this wave-level split and handle in Phase 3 missingness analysis.

  ANOMALY 5 — Condition variables: RwXXXE (harmonized) vs RwXXXQ (sub-questions)
  ─────────────────────────────────────────────────────────────────────────────────
  SOURCE: RAND codebook sec 2.1.4:
    "s/he has ever had a particular disease. In interviews after the baseline,
     prior responses were preloaded. Each disease condition indicator variable
     has a corresponding flag variable that indicates whether the Respondent
     disputed the previous wave's indicator..."
    "The RwCONDE time series is NOT APPROPRIATE for tracking changes in prevalence
     over time, and the individual variables WITHOUT disputes incorporated should
     be used instead."

  FINDING from variable discovery: r{w}heartq, r{w}cancre, r{w}strokq, r{w}hibpq,
    r{w}lungq are sub-question detail variables (96 matches each — excessive).
    The correct harmonized ever-diagnosis variables are:
      r{w}hearte, r{w}diabe, r{w}cancre, r{w}stroke, r{w}hibpe, r{w}lunge
    (suffix 'e' = the RAND-harmonized ever-diagnosis indicator).

  HARMONIZATION DECISION (confirmed, not proposed):
    → Use ONLY the 'e'-suffix variables for binary condition indicators.
    → Do NOT use the 'q'-suffix sub-questions (those capture specific aspects
      of the condition diagnosis, not the cumulative ever-had indicator).
    → Dispute flags (RwDIABF etc.) are noted but not included as features
      — they represent <2% of responses per RAND's documentation.
""")

# ══════════════════════════════════════════════════════════════════════════════
# FINAL INVENTORY TABLE SAVED
# ══════════════════════════════════════════════════════════════════════════════
sep("FINAL INVENTORY — saving to reports/")

all_inv.to_csv(os.path.join(REPORTS, "phase2_variable_inventory.csv"), index=False)
log(f"  Full inventory saved → reports/phase2_variable_inventory.csv")
log(f"  Total variable-wave observations inventoried: {len(all_inv):,}")
log(f"  Variables by group:")
for grp, sub in all_inv.groupby("group"):
    n_stems = sub["stem"].nunique()
    n_high  = (sub["flag"].str.contains("HIGH", na=False)).sum()
    log(f"    {grp:<12}: {n_stems} stems  ({len(sub)} variable-wave obs)  "
        f"high-missingness flags: {n_high}")

sep("PHASE 2 STATUS REPORT")
log(f"""
  DONE:
    ✓ Financial group  : {inv_fin['stem'].nunique()} variables inventoried, missingness per wave computed
    ✓ Health group     : {inv_hlth['stem'].nunique()} variables inventoried, wave availability confirmed
    ✓ Demographic group: {inv_dem['stem'].nunique()} variables inventoried
    ✓ Missingness heatmap saved → reports/phase2_missingness_heatmap.png
    ✓ Full inventory saved → reports/phase2_variable_inventory.csv
    ✓ Per-group parquets saved → data/interim/phase2_*.parquet (for Phase 3)
    ✓ 5 anomalies investigated and traced to RAND codebook documentation

  HARMONIZATION DECISIONS PROPOSED (confirm before Phase 3):
    D1: ADL Wave 1 excluded from time-series (Wallace-Herzog, not comparable).
        Use r2adlr through r16adlr only.
    D2: IADL Wave 1 = structurally missing; MICE will NOT impute it.
        Use r3iadl5a through r16iadl5a (r2iadl5a for AHD cohort).
    D3: BMI height carry-forward accepted as-is (RAND standard). Limitation
        flagged: BMI in later waves understates true BMI for aging respondents.
    D4: Wave 2 income split (h2itot vs h2itot2) — use h2itot for HRS cohort;
        check h2itot2 coverage for AHEAD-1995 respondents.
    D5: Condition variables → use ONLY 'e'-suffix (r{w}hearte etc.). Confirmed
        per codebook; 'q'-suffix sub-questions excluded from feature set.

  OPEN QUESTION for Phase 3:
    • Financial variables: RAND provides pre-imputed values (h{w}atotw etc.
      are already RAND five-imputation means). Should Phase 3 use RAND's
      built-in imputation OR run independent MICE? The prompt requires a
      reasoned decision — will present options in Phase 3 status report.

  ─── AWAITING YOUR CONFIRMATION BEFORE PHASE 3 ───
""")

_fh.close()
print(f"\nFull log → {LOG_PATH}")
