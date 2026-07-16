# Pakistani Mortality Risk Calibration (Post-hoc)

## Overview
This module implements a post-hoc Bayesian credibility recalibration layer for the existing HRS-trained mortality risk model. Since the original model was trained on US data (Health and Retirement Study), its raw absolute risk predictions need to be anchored to the actual mortality experience of the Pakistani population, while maintaining the model's relative risk ranking for individual health factors.

## Calibration Method
**Bayesian Credibility Weighting (Bühlmann-style)**

This method blends two sources of information about mortality risk:
1. **Prior belief (Population Anchor):** The actual Pakistani population mortality rate ($q_x$) for a given age and sex band.
2. **Likelihood (Model Prediction):** The individual's relative risk prediction produced by the HRS model.

Instead of retraining the model (which would require a massive individual-level longitudinal dataset for Pakistan that doesn't exist), we rescale the output by combining these two sources using a credibility factor $Z$.

**Formula:**
`blended_baseline = Z * pakistan_qx + (1 - Z) * model_avg_pred`
`calibrated_risk = blended_baseline * (raw_pred / model_avg_pred)`

## Data Sources
- **Model Reference Set:** A synthetic cross-sectional population distributed over plausible demographic bounds used to establish `model_avg_pred` for each bucket.
- **Population Anchor (PDS-2020):** Ground-truth mortality counts and population denominators from the Pakistan Demographic Survey (PDS) 2020 (SPSS data files), representing standard age/sex brackets.

## Credibility Factor (Z)
- The default credibility factor is set to **Z = 0.85**.
- This heavily weights the local population anchor because we trust the PDS mortality tables far more than the absolute calibration of the US-trained model applied to Pakistan.
- **To update Z:** You can change it directly via the Streamlit App slider in `app_pakistan.py` or modify the initialization in `inference.py` (`PakistaniMortalityRiskPredictor(Z=0.85)`).

## Limitations and Caveats (Explicit Warnings)
- **NO LOCAL VALIDATION:** The relative risk-factor weightings (e.g., the penalty for high BMI, smoking, diabetes, or SES) remain US-derived. This model has **NOT** been validated against actual individual Pakistani mortality outcomes.
- We have assumed that the interaction effects and relative risks from the US cohort (HRS) are directionally plausible in Pakistan, but the magnitudes of these risks are fundamentally untested on the local population.
- This is a prototype and must be recalibrated against the insurer's actual book of business once sufficient claims/mortality data is gathered.
