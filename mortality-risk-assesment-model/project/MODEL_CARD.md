# Life Insurance Mortality Risk Model — Model Card

## Overview

This model predicts the probability that a life insurance applicant will die within a given time horizon, based on information collected at the time of application (baseline underwriting data only — no future observations used).

Two models are provided, each trained on two time horizons:

| Model | Best At | Why Use It |
|---|---|---|
| **XGBoost** | 10yr (AUROC 0.871) | Highest raw discrimination; captures non-linear wealth/health interactions |
| **Logistic Regression** | 1yr / interpretable | Coefficients explainable to a regulator; near-identical AUROC to XGBoost at 1yr |

---

## Data Source

**Dataset:** RAND Health and Retirement Study (HRS) Longitudinal File  
**Coverage:** 1992–2022 | **Respondents:** 45,234 adults aged 50+  
**Population:** US adults enrolled in a nationally representative longitudinal survey of health, wealth, and retirement. Spans 8 entry cohorts from the original 1992 HRS sample through the 2022 Early GenX cohort.

> ⚠️ **Generalizability note:** HRS includes participants across the full health spectrum, including severely ill individuals. A standard insurance applicant pool (pre-selected for insurability) will be healthier on average. Expect real-world AUROC to be 5–10 points lower than the figures below.

---

## Target Labels (What the Model Predicts)

The model outputs a **probability between 0.0 and 1.0** — the estimated chance of death within the chosen horizon. This can be mapped to a risk tier for underwriting decisions.

### Available Horizons

| Horizon | Label | Meaning | Event Rate in Training Data |
|---|---|---|---|
| **5-year** | `label_5yr` | Did the respondent die within 5 years of their baseline interview? | 8.2% |
| **10-year** | `label_10yr` | Did the respondent die within 10 years of their baseline interview? | 24.3% |

### Risk Tier Mapping (Suggested)

| Predicted Probability | Risk Tier | Underwriting Implication |
|---|---|---|
| 0.00 – 0.05 | 🟢 **Low** | Standard rates |
| 0.05 – 0.15 | 🟡 **Moderate** | Rate-up or further review |
| 0.15 – 0.35 | 🟠 **Elevated** | Rated policy or exclusion clauses |
| 0.35+ | 🔴 **High** | Decline or heavily rated |

> These thresholds are illustrative. Actuarial calibration to your own book of business is required before production use.

---

## Input Features (24 Variables)

All features are collected **at the time of application (Day 1)**. No longitudinal follow-up data is used.

### Demographic

| Feature Name | Type | Values | Description |
|---|---|---|---|
| `gender` | Integer | 1 = Male, 2 = Female | Biological sex |
| `birth_yr` | Integer | e.g. 1942 | Year of birth |
| `demo_age` | Float | Years | Age at time of application |
| `hispan` | Integer | 0 = Non-Hispanic, 1 = Hispanic | Hispanic ethnicity |
| `demo_mstat` | Integer | 1=Married, 2=Partnered, 3=Separated, 4=Divorced, 5=Widowed, 7=Never married | Marital status at baseline |
| `demo_region` | Integer | 1=Northeast, 2=Midwest, 3=South, 4=West | US Census region of residence |

### Education

| Feature Name | Type | Values | Description |
|---|---|---|---|
| `educ` | Integer | 0–17 (years) | Years of formal education completed |

### Financial / SES

All financial variables are in **2022 US Dollars** (RAND-inflation-adjusted across waves).

| Feature Name | Type | Description |
|---|---|---|
| `fin_income` | Float | Total household income (all sources) |
| `fin_wealth` | Float | Total net wealth (assets minus debts, including home) |
| `fin_wealth_liquid` | Float | Liquid assets only (stocks, bonds, checking, CDs) |
| `fin_home_eq` | Float | Home equity (value of primary residence minus mortgage) |
| `fin_pension` | Float | Present value of pension entitlements |

> **Note:** `fin_wealth = fin_home_eq + non-housing wealth - total debt`. These are mathematically related but retained separately because each sub-component carries independent predictive signal confirmed by VIF < 3.5.

### Health & Behavior

| Feature Name | Type | Values | Description |
|---|---|---|---|
| `hlth_srh` | Integer | 1=Excellent, 2=Very Good, 3=Good, 4=Fair, 5=Poor | Self-rated general health (most predictive single feature) |
| `hlth_bmi` | Float | kg/m² | Body Mass Index at baseline |
| `hlth_smoken` | Integer | 0=No, 1=Yes | Current smoker at time of application |
| `hlth_smokev` | Integer | 0=No, 1=Yes | Ever smoked (cumulative lifetime exposure) |
| `hlth_adl5a` | Integer | 0–5 | Count of Activities of Daily Living with difficulty (dressing, walking, bathing, eating, getting in/out of bed) |
| `hlth_iadl5a` | Integer | 0–5 | Count of Instrumental ADL difficulties (telephone, medication, money management, shopping, meal preparation) |

> `hlth_adl5a` and `hlth_iadl5a` are the strongest short-term mortality predictors after self-rated health and age. High scores indicate significant functional impairment.

### Chronic Conditions (ever-diagnosed, binary)

| Feature Name | Values | Condition |
|---|---|---|
| `cond_hearte` | 0 / 1 | Heart disease (any cardiac event or diagnosis) |
| `cond_diabe` | 0 / 1 | Diabetes (Type 1 or Type 2) |
| `cond_cancre` | 0 / 1 | Cancer (any malignancy, excluding minor skin cancer) |
| `cond_stroke` | 0 / 1 | Stroke or TIA |
| `cond_hibpe` | 0 / 1 | Hypertension (high blood pressure) |
| `cond_lunge` | 0 / 1 | Chronic lung disease (COPD, emphysema, asthma) |

> All condition flags are **ever-diagnosed and cumulative** — a respondent who had a heart attack 10 years ago and recovered still scores `cond_hearte=1`. This is appropriate for lifetime mortality risk assessment.

---

## Model Performance

### Test Set Results (Held-Out, Stratified Split)

| Model | Horizon | AUROC | AUPRC | Brier Score |
|---|---|---|---|---|
| XGBoost | 5yr | 0.862 | 0.452 | 0.131 |
| XGBoost | 10yr | **0.871** | **0.728** | 0.142 |
| LogReg | 5yr | 0.866 | 0.440 | 0.152 |
| LogReg | 10yr | 0.863 | 0.711 | 0.151 |

**AUROC** = Area Under ROC Curve (1.0 = perfect, 0.5 = random)  
**AUPRC** = Area Under Precision-Recall Curve (higher = better at finding true positives)  
**Brier Score** = Mean squared error of probability estimates (lower = better calibration)

### Calibration Summary

| Horizon | Model | Mean Abs Error (decile) | Top-Decile Overestimate |
|---|---|---|---|
| 5yr | XGBoost | 0.72pp | +4.1pp (conservative) |
| 10yr | XGBoost | 0.80pp | +0.8pp (excellent) |

The 5yr model slightly overestimates risk at the very top decile — the model is **conservative** (errs toward higher risk), which is the safe direction for underwriting.

---

## What's NOT Included in the Model

| Excluded | Why | Where It Lives |
|---|---|---|
| `race` | Regulatory/fair-lending compliance | `phase5_audit_set.parquet` — for disparate-impact audit only |
| `fin_ssdi` | Eliminated by feature selection (near-zero predictive signal) | — |
| Any Wave 2+ observations | Immortal time bias — model uses only Day-1 data | By design |
| Trend features (BMI change, wealth change) | Future data leakage | Requires landmark analysis to use safely |

---

## Known Limitations

1. **HRS population ≠ Insurance applicant pool** — Expect 5–10pp lower AUROC on a pre-underwritten applicant pool.
2. **Self-reported data** — All health and financial variables are self-reported. No medical exam, labs, or pharmacy records.
3. **Age 50+ only** — Model is not validated below age 50. Do not apply to younger applicants.
4. **US population only** — Trained on US adults. Behavior on non-US populations is unknown.
5. **Calibration recalibration required** — Run isotonic regression or Platt scaling against your own claims data before pricing.

---

## Files

```
models/
  xgboost_5yr.joblib      # XGBoost trained on 5yr horizon
  xgboost_10yr.joblib     # XGBoost trained on 10yr horizon
  logreg_5yr.joblib       # Logistic Regression, 5yr
  logreg_10yr.joblib      # Logistic Regression, 10yr

src/
  inference.py            # Inference helper — load model, predict, get risk tier

reports/viz/
  roc_pr_curves.png       # ROC and PR curves
  calibration_plots.png   # Decile calibration
  shap_xgboost_5yr.png    # SHAP feature importance
  logreg_coefficients_5yr.png  # LogReg coefficients (directional)
  model_comparison_dashboard.png  # Side-by-side metric comparison
```
