"""
phase8_model_training.py
========================
Production prototype training for the 2 selected models:
  1. XGBoost       — best discriminative performance (5yr AUROC 0.8668)
  2. LogisticRegression — best explainable model (5yr AUROC 0.8640, Δ=0.003)

Horizon: 5yr (primary) + 10yr (secondary)
Outputs: saved model objects, ROC curves, PR curves, calibration plots,
         SHAP summary (XGBoost), coefficient plot (LogReg)
"""

import os, warnings, joblib
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from matplotlib.lines import Line2D
import shap
import xgboost as xgb
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import (
    roc_auc_score, average_precision_score, brier_score_loss,
    roc_curve, precision_recall_curve
)
from sklearn.calibration import calibration_curve

warnings.filterwarnings('ignore')

# ── Paths ──────────────────────────────────────────────────────────────────
BASE   = '/run/media/zain-ali/New Volume/insurance/project'
PROC   = os.path.join(BASE, 'data/processed')
MDIR   = os.path.join(BASE, 'models');        os.makedirs(MDIR, exist_ok=True)
VDIR   = os.path.join(BASE, 'reports/viz');   os.makedirs(VDIR, exist_ok=True)

# ── Feature set (24 confirmed final features) ──────────────────────────────
FEATURES = [
    'gender', 'birth_yr', 'hispan', 'educ', 'demo_age', 'demo_mstat', 'demo_region',
    'fin_income', 'fin_wealth', 'fin_wealth_liquid', 'fin_home_eq', 'fin_pension',
    'hlth_srh', 'hlth_bmi', 'hlth_smoken', 'hlth_smokev',
    'hlth_adl5a', 'hlth_iadl5a',
    'cond_hearte', 'cond_diabe', 'cond_cancre',
    'cond_stroke', 'cond_hibpe', 'cond_lunge',
]

FEATURE_LABELS = {
    'gender': 'Gender', 'birth_yr': 'Birth Year', 'hispan': 'Hispanic',
    'educ': 'Education', 'demo_age': 'Age at Entry', 'demo_mstat': 'Marital Status',
    'demo_region': 'Census Region', 'fin_income': 'Household Income',
    'fin_wealth': 'Total Wealth', 'fin_wealth_liquid': 'Liquid Wealth',
    'fin_home_eq': 'Home Equity', 'fin_pension': 'Pension Value',
    'hlth_srh': 'Self-Rated Health', 'hlth_bmi': 'BMI',
    'hlth_smoken': 'Current Smoker', 'hlth_smokev': 'Ever Smoked',
    'hlth_adl5a': 'ADL Difficulties', 'hlth_iadl5a': 'IADL Difficulties',
    'cond_hearte': 'Heart Disease', 'cond_diabe': 'Diabetes',
    'cond_cancre': 'Cancer', 'cond_stroke': 'Stroke',
    'cond_hibpe': 'Hypertension', 'cond_lunge': 'Lung Disease',
}

# ── Plotting style ─────────────────────────────────────────────────────────
plt.rcParams.update({
    'figure.facecolor': '#0f1117',
    'axes.facecolor':   '#1a1d27',
    'axes.edgecolor':   '#3a3d4d',
    'axes.labelcolor':  '#e0e0e0',
    'xtick.color':      '#a0a0b0',
    'ytick.color':      '#a0a0b0',
    'text.color':       '#e0e0e0',
    'grid.color':       '#2a2d3d',
    'grid.linestyle':   '--',
    'grid.alpha':       0.5,
    'font.family':      'DejaVu Sans',
    'font.size':        11,
    'axes.titlesize':   13,
    'axes.titleweight': 'bold',
    'legend.facecolor': '#1a1d27',
    'legend.edgecolor': '#3a3d4d',
    'figure.dpi':       150,
})

PALETTE = {
    'xgb':    '#00d4aa',   # teal
    'logreg': '#f5a623',   # amber
    'ref':    '#555566',   # grey diagonal
    'fill':   '#2a2d3d',
}


def load_horizon(horizon):
    label_col = f'label_{horizon}'
    tr = pd.read_parquet(os.path.join(PROC, f'phase5_{horizon}_train.parquet'))
    te = pd.read_parquet(os.path.join(PROC, f'phase5_{horizon}_test.parquet'))
    X_tr, y_tr = tr[FEATURES], tr[label_col].astype(int)
    X_te, y_te = te[FEATURES], te[label_col].astype(int)
    print(f'  [{horizon}] train={len(X_tr):,} (event={y_tr.mean()*100:.2f}%)  '
          f'test={len(X_te):,} (event={y_te.mean()*100:.2f}%)')
    return X_tr, y_tr, X_te, y_te


def metrics(y_true, proba):
    return dict(
        auroc=roc_auc_score(y_true, proba),
        auprc=average_precision_score(y_true, proba),
        brier=brier_score_loss(y_true, proba),
    )


# ══════════════════════════════════════════════════════════════════════════════
# TRAINING
# ══════════════════════════════════════════════════════════════════════════════
print('\n' + '='*65)
print('  TRAINING: XGBoost & Logistic Regression  (5yr + 10yr)')
print('='*65)

results = {}   # results[horizon][model_name] = {proba, metrics, model}

for horizon in ['5yr', '10yr']:
    print(f'\n── Horizon: {horizon} ──')
    X_tr, y_tr, X_te, y_te = load_horizon(horizon)
    results[horizon] = {}

    # ── XGBoost ──────────────────────────────────────────────────────────
    print('  Training XGBoost...')
    xgb_model = xgb.XGBClassifier(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=20,
        eval_metric='logloss', verbosity=0,
        scale_pos_weight=(y_tr == 0).sum() / (y_tr == 1).sum(),
        random_state=42
    )
    xgb_model.fit(X_tr, y_tr,
                  eval_set=[(X_te, y_te)],
                  verbose=False)
    xgb_proba = xgb_model.predict_proba(X_te)[:, 1]
    xgb_m = metrics(y_te, xgb_proba)
    results[horizon]['XGBoost'] = {'model': xgb_model, 'proba': xgb_proba,
                                   'metrics': xgb_m, 'X_te': X_te, 'y_te': y_te,
                                   'X_tr': X_tr, 'y_tr': y_tr}
    print(f'    AUROC={xgb_m["auroc"]:.4f}  AUPRC={xgb_m["auprc"]:.4f}  '
          f'Brier={xgb_m["brier"]:.4f}')

    # Save model
    joblib.dump(xgb_model, os.path.join(MDIR, f'xgboost_{horizon}.joblib'))

    # ── Logistic Regression ───────────────────────────────────────────────
    print('  Training Logistic Regression...')
    lr_model = Pipeline([
        ('scaler', StandardScaler()),
        ('clf', LogisticRegression(C=0.1, max_iter=1000, random_state=42,
                                   class_weight='balanced'))
    ])
    lr_model.fit(X_tr, y_tr)
    lr_proba = lr_model.predict_proba(X_te)[:, 1]
    lr_m = metrics(y_te, lr_proba)
    results[horizon]['LogReg'] = {'model': lr_model, 'proba': lr_proba,
                                  'metrics': lr_m, 'X_te': X_te, 'y_te': y_te,
                                  'X_tr': X_tr, 'y_tr': y_tr}
    print(f'    AUROC={lr_m["auroc"]:.4f}  AUPRC={lr_m["auprc"]:.4f}  '
          f'Brier={lr_m["brier"]:.4f}')

    joblib.dump(lr_model, os.path.join(MDIR, f'logreg_{horizon}.joblib'))


# ══════════════════════════════════════════════════════════════════════════════
# VISUALIZATIONS
# ══════════════════════════════════════════════════════════════════════════════
print('\n' + '='*65)
print('  GENERATING VISUALIZATIONS')
print('='*65)


# ── 1. Combined ROC + PR curves (2×2 grid) ───────────────────────────────
print('  [1/5] ROC & PR curves...')
fig, axes = plt.subplots(2, 2, figsize=(14, 11))
fig.patch.set_facecolor('#0f1117')
fig.suptitle('Model Performance: ROC & Precision-Recall Curves',
             fontsize=16, fontweight='bold', color='#e0e0e0', y=1.01)

for col_idx, horizon in enumerate(['5yr', '10yr']):
    ax_roc = axes[0, col_idx]
    ax_pr  = axes[1, col_idx]

    for model_name, color in [('XGBoost', PALETTE['xgb']),
                               ('LogReg',  PALETTE['logreg'])]:
        r = results[horizon][model_name]
        fpr, tpr, _ = roc_curve(r['y_te'], r['proba'])
        prec, rec, _ = precision_recall_curve(r['y_te'], r['proba'])
        m = r['metrics']
        label = f"{model_name}  AUC={m['auroc']:.4f}"
        ax_roc.plot(fpr, tpr, color=color, lw=2, label=label)
        ax_pr.plot(rec, prec, color=color, lw=2,
                   label=f"{model_name}  AP={m['auprc']:.4f}")

    # ROC
    ax_roc.plot([0,1],[0,1], color=PALETTE['ref'], lw=1.2, linestyle='--')
    ax_roc.set_title(f'{horizon} Mortality — ROC Curve')
    ax_roc.set_xlabel('False Positive Rate')
    ax_roc.set_ylabel('True Positive Rate')
    ax_roc.legend(loc='lower right', fontsize=9)
    ax_roc.grid(True); ax_roc.set_xlim([0,1]); ax_roc.set_ylim([0,1.02])

    # PR
    baseline = results[horizon]['XGBoost']['y_te'].mean()
    ax_pr.axhline(baseline, color=PALETTE['ref'], lw=1.2, linestyle='--',
                  label=f'Baseline (prevalence={baseline*100:.1f}%)')
    ax_pr.set_title(f'{horizon} Mortality — Precision-Recall Curve')
    ax_pr.set_xlabel('Recall')
    ax_pr.set_ylabel('Precision')
    ax_pr.legend(loc='upper right', fontsize=9)
    ax_pr.grid(True); ax_pr.set_xlim([0,1]); ax_pr.set_ylim([0,1.02])

plt.tight_layout()
path = os.path.join(VDIR, 'roc_pr_curves.png')
fig.savefig(path, bbox_inches='tight', facecolor='#0f1117')
plt.close(fig)
print(f'    Saved → {path}')


# ── 2. Calibration plots (2×2) ────────────────────────────────────────────
print('  [2/5] Calibration plots...')
fig, axes = plt.subplots(2, 2, figsize=(14, 11))
fig.patch.set_facecolor('#0f1117')
fig.suptitle('Calibration: Predicted vs. Observed Event Rate (by Decile)',
             fontsize=16, fontweight='bold', color='#e0e0e0', y=1.01)

for col_idx, horizon in enumerate(['5yr', '10yr']):
    for row_idx, (model_name, color) in enumerate(
            [('XGBoost', PALETTE['xgb']), ('LogReg', PALETTE['logreg'])]):
        ax = axes[row_idx, col_idx]
        r = results[horizon][model_name]
        frac_pos, mean_pred = calibration_curve(
            r['y_te'], r['proba'], n_bins=10, strategy='quantile')
        ax.plot([0,1],[0,1], color=PALETTE['ref'], lw=1.5,
                linestyle='--', label='Perfect calibration')
        ax.plot(mean_pred, frac_pos, 'o-', color=color, lw=2,
                markersize=7, label=model_name)
        ax.fill_between(mean_pred, frac_pos, mean_pred,
                        alpha=0.15, color=color)
        ax.set_title(f'{horizon} — {model_name}')
        ax.set_xlabel('Mean Predicted Probability')
        ax.set_ylabel('Fraction of Positives (Observed)')
        ax.legend(fontsize=9); ax.grid(True)
        ax.set_xlim([0, max(mean_pred)*1.1])
        ax.set_ylim([0, max(max(frac_pos), max(mean_pred))*1.15])

plt.tight_layout()
path = os.path.join(VDIR, 'calibration_plots.png')
fig.savefig(path, bbox_inches='tight', facecolor='#0f1117')
plt.close(fig)
print(f'    Saved → {path}')


# ── 3. SHAP Summary (XGBoost — 5yr) ──────────────────────────────────────
print('  [3/5] SHAP summary (XGBoost 5yr)...')
r5 = results['5yr']['XGBoost']
explainer = shap.TreeExplainer(r5['model'])
# Use a subsample for speed (2000 rows)
np.random.seed(42)
idx = np.random.choice(len(r5['X_te']), size=min(2000, len(r5['X_te'])),
                       replace=False)
X_shap = r5['X_te'].iloc[idx].copy()
shap_values = explainer.shap_values(X_shap)

fig, ax = plt.subplots(figsize=(10, 9))
fig.patch.set_facecolor('#0f1117')
ax.set_facecolor('#1a1d27')
# Rename columns for display
X_display = X_shap.rename(columns=FEATURE_LABELS)
shap.summary_plot(shap_values, X_display, plot_type='bar',
                  max_display=20, show=False,
                  color=PALETTE['xgb'])
plt.title('XGBoost Feature Importance (SHAP) — 5yr Horizon',
          fontsize=14, fontweight='bold', pad=14, color='#e0e0e0')
plt.xlabel('Mean |SHAP Value|', color='#e0e0e0')
plt.tick_params(colors='#a0a0b0')
for spine in ax.spines.values():
    spine.set_edgecolor('#3a3d4d')
plt.tight_layout()
path = os.path.join(VDIR, 'shap_xgboost_5yr.png')
fig.savefig(path, bbox_inches='tight', facecolor='#0f1117')
plt.close(fig)
print(f'    Saved → {path}')


# ── 4. LogReg Coefficient Plot (5yr) ─────────────────────────────────────
print('  [4/5] LogReg coefficient plot (5yr)...')
lr5 = results['5yr']['LogReg']['model']
coefs = lr5.named_steps['clf'].coef_[0]
feat_names = [FEATURE_LABELS.get(f, f) for f in FEATURES]
coef_df = pd.DataFrame({'feature': feat_names, 'coef': coefs})
coef_df = coef_df.reindex(coef_df['coef'].abs().sort_values(ascending=True).index)

colors = [PALETTE['xgb'] if c > 0 else '#e05c5c' for c in coef_df['coef']]
fig, ax = plt.subplots(figsize=(10, 9))
fig.patch.set_facecolor('#0f1117')
ax.set_facecolor('#1a1d27')
bars = ax.barh(coef_df['feature'], coef_df['coef'], color=colors,
               edgecolor='none', height=0.7)
ax.axvline(0, color='#a0a0b0', linewidth=1.2, linestyle='--')
ax.set_title('Logistic Regression Coefficients — 5yr Horizon',
             fontsize=14, fontweight='bold', pad=14, color='#e0e0e0')
ax.set_xlabel('Coefficient (standardised features)', color='#e0e0e0')
legend_elems = [Line2D([0],[0], color=PALETTE['xgb'], lw=8,
                        label='Increases risk (positive coef)'),
                Line2D([0],[0], color='#e05c5c', lw=8,
                        label='Decreases risk (negative coef)')]
ax.legend(handles=legend_elems, fontsize=9, loc='lower right')
ax.grid(axis='x', alpha=0.4)
for spine in ax.spines.values():
    spine.set_edgecolor('#3a3d4d')
plt.tight_layout()
path = os.path.join(VDIR, 'logreg_coefficients_5yr.png')
fig.savefig(path, bbox_inches='tight', facecolor='#0f1117')
plt.close(fig)
print(f'    Saved → {path}')


# ── 5. Model Comparison Dashboard (summary tile) ─────────────────────────
print('  [5/5] Model comparison dashboard...')
fig = plt.figure(figsize=(14, 7))
fig.patch.set_facecolor('#0f1117')
gs = gridspec.GridSpec(2, 3, figure=fig, hspace=0.45, wspace=0.38)

metric_labels = ['AUROC', 'AUPRC', 'Brier Score']
metric_keys   = ['auroc', 'auprc', 'brier']
better        = ['higher', 'higher', 'lower']

for row, horizon in enumerate(['5yr', '10yr']):
    for col, (mk, ml, b) in enumerate(zip(metric_keys, metric_labels, better)):
        ax = fig.add_subplot(gs[row, col])
        ax.set_facecolor('#1a1d27')
        vals  = [results[horizon]['XGBoost']['metrics'][mk],
                 results[horizon]['LogReg']['metrics'][mk]]
        names = ['XGBoost', 'LogReg']
        bars = ax.bar(names, vals,
                      color=[PALETTE['xgb'], PALETTE['logreg']],
                      width=0.5, edgecolor='none')
        for bar, val in zip(bars, vals):
            ax.text(bar.get_x() + bar.get_width()/2,
                    bar.get_height() + max(vals)*0.02,
                    f'{val:.4f}', ha='center', va='bottom',
                    fontsize=10, fontweight='bold', color='#e0e0e0')
        ax.set_title(f'{horizon} — {ml}\n({b} is better)',
                     fontsize=10, fontweight='bold')
        ax.set_ylim([0, max(vals) * 1.18])
        ax.grid(axis='y', alpha=0.4)
        for spine in ax.spines.values():
            spine.set_edgecolor('#3a3d4d')
        ax.tick_params(colors='#a0a0b0')

fig.suptitle('XGBoost vs Logistic Regression — Metric Comparison',
             fontsize=15, fontweight='bold', color='#e0e0e0', y=1.02)
path = os.path.join(VDIR, 'model_comparison_dashboard.png')
fig.savefig(path, bbox_inches='tight', facecolor='#0f1117')
plt.close(fig)
print(f'    Saved → {path}')


# ══════════════════════════════════════════════════════════════════════════════
# FINAL SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
print('\n' + '='*65)
print('  FINAL RESULTS SUMMARY')
print('='*65)
print(f'  {"Horizon":<6} {"Model":<10} {"AUROC":>8} {"AUPRC":>8} {"Brier":>8}')
print('  ' + '-'*44)
for horizon in ['5yr', '10yr']:
    for mname in ['XGBoost', 'LogReg']:
        m = results[horizon][mname]['metrics']
        print(f'  {horizon:<6} {mname:<10} {m["auroc"]:>8.4f} '
              f'{m["auprc"]:>8.4f} {m["brier"]:>8.4f}')

print(f'\n  Saved models → {MDIR}/')
print(f'  Saved visuals → {VDIR}/')
print('\n  Files:')
for f in sorted(os.listdir(MDIR)):
    print(f'    models/{f}')
for f in sorted(os.listdir(VDIR)):
    print(f'    reports/viz/{f}')
