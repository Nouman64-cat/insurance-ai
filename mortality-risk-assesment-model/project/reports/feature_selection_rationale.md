# Phase 5: Feature Selection Rationale
**Target used for ranking:** `label_5yr`

## 1. Variance and Multicollinearity Checks
- **Low Variance Features:** None detected.
- **Financial VIF Scores:**
  - `fin_income`: 1.21
  - `fin_wealth`: 3.24
  - `fin_wealth_liquid`: 2.38
  - `fin_home_eq`: 1.55

## 2. Feature Ranking & Preservation Status
| Feature | SHAP Rank | MI Rank | Mandate Protected | Action | Reason |
|---------|-----------|---------|-------------------|--------|--------|
| `gender` | 4 | 16 | Yes | Keep | Strong Predictive Signal |
| `hispan` | 19 | 24 | No | Keep | Strong Predictive Signal |
| `educ` | 18 | 10 | No | Keep | Strong Predictive Signal |
| `birth_yr` | 2 | 2 | No | Keep | Strong Predictive Signal |
| `fin_income` | 9 | 5 | Yes | Keep | Strong Predictive Signal |
| `fin_wealth` | 7 | 12 | Yes | Keep | Strong Predictive Signal |
| `fin_wealth_liquid` | 15 | 15 | Yes | Keep | Strong Predictive Signal |
| `fin_home_eq` | 12 | 13 | No | Keep | Strong Predictive Signal |
| `fin_pension` | 20 | 20 | No | Keep | Strong Predictive Signal |
| `fin_ssdi` | 21 | 21 | No | Drop | Bottom tier in both MI/SHAP or High VIF |
| `hlth_srh` | 3 | 4 | No | Keep | Strong Predictive Signal |
| `hlth_bmi` | 5 | 9 | No | Keep | Strong Predictive Signal |
| `hlth_smoken` | 10 | 23 | No | Keep | Strong Predictive Signal |
| `hlth_smokev` | 13 | 22 | No | Keep | Strong Predictive Signal |
| `hlth_adl5a` | 24 | 6 | No | Keep | Strong Predictive Signal |
| `hlth_iadl5a` | 16 | 3 | No | Keep | Strong Predictive Signal |
| `cond_hearte` | 14 | 7 | Yes | Keep | Strong Predictive Signal |
| `cond_diabe` | 11 | 17 | Yes | Keep | Strong Predictive Signal |
| `cond_cancre` | 8 | 19 | Yes | Keep | Strong Predictive Signal |
| `cond_stroke` | 25 | 14 | Yes | Keep | Strong Predictive Signal |
| `cond_hibpe` | 6 | 18 | No | Keep | Strong Predictive Signal |
| `cond_lunge` | 17 | 11 | Yes | Keep | Strong Predictive Signal |
| `demo_age` | 1 | 1 | Yes | Keep | Strong Predictive Signal |
| `demo_mstat` | 22 | 8 | No | Keep | Strong Predictive Signal |
| `demo_region` | 23 | 25 | No | Drop | Bottom tier in both MI/SHAP or High VIF |
## 4. Chronological Split: Known Limitation & Follow-up Experiment

**Why chronological splitting was abandoned:**
HRS is a cohort-refresh design, not a temporal observation stream. Slicing
"most recent respondents" as the test set doesn't approximate future deployment
drift — it selects for younger, healthier, shorter-follow-up cohorts by
construction. This produced a zero-event 1yr test set and a 76%-single-cohort
10yr test set under the original chronological approach.

**What was implemented instead:**
Stratified 80/20 splits, stratifying jointly on entry-year cohort bucket ×
event label. This guarantees every cohort and every event class is proportionally
represented in both train and test.

**The open experiment (not implemented here):**
Chronological splitting as a "deployment drift" test remains a legitimate
robustness question. The recommended follow-up: train exclusively on pre-2010
entrants, evaluate on 2010+ entrants, report as a separate stress-test of
generalization to newer cohorts — distinct from the primary benchmark and
explicitly labelled as such for actuarial review.
