"""
phase6_benchmarking.py
======================
Phase 6 — Model Benchmarking

Models:   LogisticRegression, RandomForest, XGBoost, LightGBM, MLP  (binary)
          Cox Proportional Hazards  (TTE)
Horizons: 1yr, 5yr, 10yr  (binary) + full TTE (Cox)

Key comparison: Health-only feature set vs. Health+SES (income/wealth/education)
— this is the primary research question the HRS pipeline was built to answer.

Metrics: AUROC, AUPRC, Brier Score, ECE (calibration) for binary models
         Harrell C-index for Cox/TTE models
"""

import os, gc, warnings, json
import pandas as pd
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (roc_auc_score, average_precision_score,
                              brier_score_loss)
from sklearn.calibration import calibration_curve
from sklearn.pipeline import Pipeline
import xgboost as xgb
import lightgbm as lgb
from lifelines import CoxPHFitter
from lifelines.utils import concordance_index
warnings.filterwarnings('ignore')

BASE  = '/run/media/zain-ali/New Volume/insurance/project'
PROC  = os.path.join(BASE, 'data/processed')
REP   = os.path.join(BASE, 'reports')
LOG   = os.path.join(REP, 'phase6_output.log')
_fh   = open(LOG, 'w', buffering=1)

def log(msg=''):
    print(msg, flush=True)
    _fh.write(msg + '\n'); _fh.flush()

SEP = '=' * 70
def sep(t=''):
    log(); log(SEP)
    if t: log(f'  {t}'); log(SEP)

# ══════════════════════════════════════════════════════════════════════════════
# FEATURE GROUP DEFINITIONS
# ══════════════════════════════════════════════════════════════════════════════
# Health-only: biological baseline — conditions, functional status, BMI,
#              smoking, self-rated health, age, sex. No income/wealth/education.
HEALTH_ONLY = [
    'gender', 'birth_yr', 'demo_age',
    'hlth_srh', 'hlth_bmi', 'hlth_smoken', 'hlth_smokev',
    'hlth_adl5a', 'hlth_iadl5a',
    'cond_hearte', 'cond_diabe', 'cond_cancre',
    'cond_stroke', 'cond_hibpe', 'cond_lunge',
]

# SES variables — the added-value group being tested
SES_VARS = [
    'fin_income', 'fin_wealth', 'fin_wealth_liquid', 'fin_home_eq', 'fin_pension',
    'educ',
]

# Full model: health + SES + remaining demographics
FULL_FEATURES = [
    'gender', 'birth_yr', 'hispan', 'educ', 'demo_age', 'demo_mstat', 'demo_region',
    'fin_income', 'fin_wealth', 'fin_wealth_liquid', 'fin_home_eq', 'fin_pension',
    'hlth_srh', 'hlth_bmi', 'hlth_smoken', 'hlth_smokev',
    'hlth_adl5a', 'hlth_iadl5a',
    'cond_hearte', 'cond_diabe', 'cond_cancre',
    'cond_stroke', 'cond_hibpe', 'cond_lunge',
]

log(f'Health-only features ({len(HEALTH_ONLY)}): {HEALTH_ONLY}')
log(f'SES features ({len(SES_VARS)}):         {SES_VARS}')
log(f'Full feature set ({len(FULL_FEATURES)}):     {FULL_FEATURES}')

# ══════════════════════════════════════════════════════════════════════════════
# MODEL DEFINITIONS
# ══════════════════════════════════════════════════════════════════════════════
def make_models():
    return {
        'LogReg': Pipeline([
            ('scaler', StandardScaler()),
            ('clf', LogisticRegression(max_iter=1000, random_state=42, C=0.1))
        ]),
        'RandomForest': RandomForestClassifier(
            n_estimators=200, max_depth=8, min_samples_leaf=20,
            n_jobs=-1, random_state=42
        ),
        'XGBoost': xgb.XGBClassifier(
            n_estimators=300, max_depth=5, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            eval_metric='logloss', verbosity=0, random_state=42
        ),
        'LightGBM': lgb.LGBMClassifier(
            n_estimators=300, max_depth=6, learning_rate=0.05,
            num_leaves=31, subsample=0.8, colsample_bytree=0.8,
            verbose=-1, random_state=42
        ),
        'MLP': Pipeline([
            ('scaler', StandardScaler()),
            ('clf', MLPClassifier(
                hidden_layer_sizes=(128, 64), activation='relu',
                max_iter=200, early_stopping=True, validation_fraction=0.1,
                random_state=42
            ))
        ]),
    }

def expected_calibration_error(y_true, y_prob, n_bins=10):
    """ECE: weighted average calibration error across probability bins."""
    fraction_pos, mean_pred = calibration_curve(y_true, y_prob, n_bins=n_bins, strategy='quantile')
    counts = np.histogram(y_prob, bins=n_bins)[0]
    counts = counts / counts.sum()
    return float(np.sum(np.abs(fraction_pos - mean_pred) * counts[:len(fraction_pos)]))

def eval_binary(model, X_te, y_te, model_name, feat_set, horizon):
    """Evaluate a binary classifier: AUROC, AUPRC, Brier, ECE."""
    try:
        proba = model.predict_proba(X_te)[:, 1]
        auroc  = roc_auc_score(y_te, proba)
        auprc  = average_precision_score(y_te, proba)
        brier  = brier_score_loss(y_te, proba)
        ece    = expected_calibration_error(y_te.values, proba)
        return dict(model=model_name, feat_set=feat_set, horizon=horizon,
                    auroc=auroc, auprc=auprc, brier=brier, ece=ece, status='OK')
    except Exception as e:
        return dict(model=model_name, feat_set=feat_set, horizon=horizon,
                    auroc=np.nan, auprc=np.nan, brier=np.nan, ece=np.nan, status=str(e))

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 6A — BINARY HORIZON BENCHMARKING
# ══════════════════════════════════════════════════════════════════════════════
sep('PHASE 6A — Binary Horizon Benchmarking')

results_binary = []

for horizon in ['1yr', '5yr', '10yr']:
    sep(f'Horizon: {horizon}')
    tr = pd.read_parquet(os.path.join(PROC, f'phase5_{horizon}_train.parquet'))
    te = pd.read_parquet(os.path.join(PROC, f'phase5_{horizon}_test.parquet'))
    label_col = f'label_{horizon}'

    y_tr = tr[label_col].astype(int)
    y_te = te[label_col].astype(int)
    log(f'  Train: {len(tr):,} rows  |  event rate: {y_tr.mean()*100:.2f}%')
    log(f'  Test:  {len(te):,} rows  |  event rate: {y_te.mean()*100:.2f}%')

    for feat_label, feat_cols in [('health_only', HEALTH_ONLY), ('health+SES', FULL_FEATURES)]:
        log(f'\n  ── Feature set: {feat_label} ({len(feat_cols)} features) ──')
        X_tr = tr[feat_cols]
        X_te = te[feat_cols]

        models = make_models()
        for mname, model in models.items():
            model.fit(X_tr, y_tr)
            r = eval_binary(model, X_te, y_te, mname, feat_label, horizon)
            results_binary.append(r)
            log(f'    {mname:<14} AUROC={r["auroc"]:.4f}  AUPRC={r["auprc"]:.4f}  '
                f'Brier={r["brier"]:.4f}  ECE={r["ece"]:.4f}  [{r["status"]}]')
            del model; gc.collect()

    del tr, te; gc.collect()

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 6B — TTE / COX PH BENCHMARKING
# ══════════════════════════════════════════════════════════════════════════════
sep('PHASE 6B — TTE / Cox PH Benchmarking')

tr_tte = pd.read_parquet(os.path.join(PROC, 'phase5_tte_train.parquet'))
te_tte = pd.read_parquet(os.path.join(PROC, 'phase5_tte_test.parquet'))

log(f'  TTE Train: {len(tr_tte):,}  |  events: {tr_tte["surv_event"].sum():,}  ({tr_tte["surv_event"].mean()*100:.1f}%)')
log(f'  TTE Test:  {len(te_tte):,}  |  events: {te_tte["surv_event"].sum():,}  ({te_tte["surv_event"].mean()*100:.1f}%)')

results_tte = []

for feat_label, feat_cols in [('health_only', HEALTH_ONLY), ('health+SES', FULL_FEATURES)]:
    log(f'\n  ── Cox PH: {feat_label} ({len(feat_cols)} features) ──')

    cox_tr = tr_tte[feat_cols + ['surv_duration', 'surv_event']].copy()
    cox_te = te_tte[feat_cols + ['surv_duration', 'surv_event']].copy()

    # Cox PH via lifelines
    cph = CoxPHFitter(penalizer=0.1)
    cph.fit(cox_tr, duration_col='surv_duration', event_col='surv_event',
            show_progress=False)

    # Harrell C-index on test set
    c_idx = concordance_index(
        cox_te['surv_duration'],
        -cph.predict_partial_hazard(cox_te[feat_cols]),
        cox_te['surv_event']
    )
    log(f'    CoxPH C-index = {c_idx:.4f}')
    results_tte.append(dict(model='CoxPH', feat_set=feat_label,
                            c_index=c_idx, n_test=len(cox_te)))

    # XGBoost AFT as a second survival model (C-index via concordance_index)
    log(f'  ── XGBoost (C-index via AFT-log-normal): {feat_label} ──')
    xgb_aft = xgb.XGBRegressor(
        objective='survival:aft', eval_metric='aft-nloglik',
        aft_loss_distribution='normal', aft_loss_distribution_scale=1.0,
        n_estimators=200, max_depth=5, learning_rate=0.05,
        subsample=0.8, verbosity=0, random_state=42
    )
    # Need to pass label_lower_bound / upper_bound for AFT
    # For uncensored (event=1): lower=upper=duration; censored (event=0): lower=duration, upper=inf
    y_lower_tr = tr_tte['surv_duration'].values.copy().astype(float)
    y_upper_tr = tr_tte['surv_duration'].values.copy().astype(float)
    y_upper_tr[tr_tte['surv_event'].values == 0] = +np.inf

    dtrain = xgb.DMatrix(tr_tte[feat_cols])
    dtrain.set_float_info('label_lower_bound', y_lower_tr)
    dtrain.set_float_info('label_upper_bound', y_upper_tr)

    bst = xgb.train(
        {'objective':'survival:aft','eval_metric':'aft-nloglik',
         'aft_loss_distribution':'normal','aft_loss_distribution_scale':1.0,
         'max_depth':5,'learning_rate':0.05,'subsample':0.8,'verbosity':0},
        dtrain, num_boost_round=200
    )
    dtest = xgb.DMatrix(te_tte[feat_cols])
    pred_time = bst.predict(dtest)
    c_xgb = concordance_index(te_tte['surv_duration'], pred_time, te_tte['surv_event'])
    log(f'    XGBoost-AFT C-index = {c_xgb:.4f}')
    results_tte.append(dict(model='XGBoost-AFT', feat_set=feat_label,
                            c_index=c_xgb, n_test=len(te_tte)))

    del cox_tr, cox_te, cph; gc.collect()

del tr_tte, te_tte; gc.collect()

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 6C — SES ADDED-VALUE COMPARISON (The Primary Research Question)
# ══════════════════════════════════════════════════════════════════════════════
sep('PHASE 6C — SES Added-Value: Health-Only vs Health+SES (per horizon, per model)')

df_bin = pd.DataFrame(results_binary)

log(f'\n  {"Model":<14} | {"Horizon":>7} | {"Health-Only AUROC":>18} | {"Health+SES AUROC":>16} | {"Δ AUROC":>8} | {"Lift%":>6}')
log('  ' + '-'*80)

ses_comparison = []
for horizon in ['1yr', '5yr', '10yr']:
    for mname in ['LogReg','RandomForest','XGBoost','LightGBM','MLP']:
        ho = df_bin[(df_bin.model==mname) & (df_bin.horizon==horizon) & (df_bin.feat_set=='health_only')]
        hs = df_bin[(df_bin.model==mname) & (df_bin.horizon==horizon) & (df_bin.feat_set=='health+SES')]
        if ho.empty or hs.empty: continue
        auroc_ho = ho['auroc'].values[0]
        auroc_hs = hs['auroc'].values[0]
        delta    = auroc_hs - auroc_ho
        lift_pct = delta / (1 - auroc_ho) * 100 if (1-auroc_ho) > 0 else np.nan
        ses_comparison.append(dict(model=mname, horizon=horizon,
                                   auroc_health_only=auroc_ho, auroc_full=auroc_hs,
                                   delta_auroc=delta, lift_pct=lift_pct))
        log(f'  {mname:<14} | {horizon:>7} | {auroc_ho:>18.4f} | {auroc_hs:>16.4f} | {delta:>+8.4f} | {lift_pct:>5.1f}%')

# TTE SES comparison
log(f'\n  {"Model":<14} | {"Feat Set":>12} | {"C-index":>8}')
log('  ' + '-'*40)
for r in results_tte:
    log(f'  {r["model"]:<14} | {r["feat_set"]:>12} | {r["c_index"]:>8.4f}')

# ══════════════════════════════════════════════════════════════════════════════
# SAVE RESULTS
# ══════════════════════════════════════════════════════════════════════════════
sep('SAVING RESULTS')

df_bin.to_csv(os.path.join(REP, 'phase6_binary_results.csv'), index=False)
pd.DataFrame(results_tte).to_csv(os.path.join(REP, 'phase6_tte_results.csv'), index=False)
pd.DataFrame(ses_comparison).to_csv(os.path.join(REP, 'phase6_ses_comparison.csv'), index=False)

log(f'  Saved: phase6_binary_results.csv')
log(f'  Saved: phase6_tte_results.csv')
log(f'  Saved: phase6_ses_comparison.csv')

# ── Best model per horizon summary ──
sep('BEST MODEL PER HORIZON (Health+SES, AUROC)')
for horizon in ['1yr','5yr','10yr']:
    subset = df_bin[(df_bin.horizon==horizon) & (df_bin.feat_set=='health+SES')]
    if subset.empty: continue
    best = subset.loc[subset['auroc'].idxmax()]
    log(f'  {horizon}: {best["model"]:<14} AUROC={best["auroc"]:.4f}  '
        f'AUPRC={best["auprc"]:.4f}  Brier={best["brier"]:.4f}')

_fh.close()
print(f'\nFull log → {LOG}')
