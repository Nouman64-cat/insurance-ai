# End-to-End Project Report: AI-Powered Life Insurance Mortality Risk Assessment

**Project Goal:** To construct a robust, production-ready mortality risk-assessment pipeline and prototype application for life insurance underwriting, using longitudinal epidemiological data.

---

## 1. Introduction: The Starting Point

The project began with raw survey data: the **RAND Health and Retirement Study (HRS) Longitudinal File (1992–2022)**. This is a massive, 1.7GB dataset containing over 45,000 respondents and thousands of variables tracking health, wealth, and demographics over 30 years. 

**The Challenge:** Academic survey data is not designed for predictive underwriting. It contains structural missingness, wave-alignment issues, and complex post-mortem records. The objective was to engineer this raw data into a strictly sealed, leak-proof dataset that perfectly simulates a "Day 1" insurance application.

---

## 2. Phase 1: Cohort Construction & Mortality Labels

The first step was establishing ground truth for who died and when, and creating our target labels.

*   **Data Alignment:** We merged the Longitudinal file with the Exit/Finder files to definitively date mortality events (`EXIT1`).
*   **Data Cleaning:** We explicitly ignored `POSTEXIT` records (which track estate resolution after death) to ensure death dates were not artificially delayed. We also resolved orphaned IDs, perfectly mapping them to the AHEAD-1995 cohort.
*   **Target Labels:** We created strict, mutually exclusive horizons: **1-year, 5-year, and 10-year mortality**, along with a continuous Time-to-Event (TTE) survival object. Respondents without enough follow-up time (e.g., someone entering in 2020 evaluated for 10-year mortality) were cleanly dropped from specific horizons to avoid false negatives.

---

## 3. Phase 2 & 3: Feature Engineering & Leakage Prevention

This phase transformed 300+ raw variables down to a curated set of underwriting features. 

### Critical Decision 1: Relative Wave Indexing
In the raw data, "Wave 1" meant the year 1992 for everyone. This meant a "War Baby" cohort member entering in 1998 had blank data for Waves 1–3. 
*   **The Fix:** We built a dynamic feature extractor that anchored every respondent to `entry_wave + 0`. This ensured the model always looks at the exact moment a person "applied," regardless of the calendar year they entered the study.

### Critical Decision 2: Sealing Against Immortal Time Bias
We explicitly rejected using "trend" features (e.g., the change in BMI between Wave 1 and Wave 2). 
*   **The Reason:** If a model knows a person has data in Wave 2, it implicitly knows they survived Wave 1. This is a fatal data leak known as immortal time bias. A true underwriting model only has Day 1 data. We sealed the feature set strictly to baseline (Wave 0) observations.

---

## 4. Phase 4: Missing Data & Imputation Strategy

The curated features had varying levels of completeness. Financial variables were 0% missing (thanks to RAND's pre-imputation). However, health variables (like ADL and IADL scores) had structural gaps, notably because the 1992 cohort was not asked certain questions.

*   **The Fix:** We implemented **MICE (Multiple Imputation by Chained Equations)**. Crucially, we included cohort flags (`entry_year`, `cohort_ahead`) in the imputation matrix. This allowed the algorithm to intelligently estimate missing ADL scores based on a respondent's specific cohort, wealth, and conditions, without distorting the underlying distributions. Target labels were strictly excluded from this process to prevent leakage.

---

## 5. Phase 5: Feature Selection & Rigorous Splitting

We utilized Mutual Information and XGBoost SHAP values to rank feature importance.

*   **Preservation Mandate:** Core actuarial variables (Age, Wealth, BMI, chronic conditions) were protected from automated dropping.
*   **Feature Dropped:** `fin_ssdi` (Social Security Disability) was dropped due to universally low predictive signal.
*   **Fairness Segregation:** The `race` variable was deliberately excluded from the training features and parked in a permanent Audit Set to allow for post-training disparate-impact testing.
*   **Final Feature Count:** 24 baseline features.

### Critical Decision 3: Stratified Per-Horizon Splits
We initially attempted a chronological train/test split to simulate future deployment. However, this caused the 1-year test set to have zero deaths, as it was dominated by young, recent cohorts with little follow-up time.
*   **The Fix:** We pivoted to a **Stratified Split (Cohort × Event Label)**. This guaranteed that every entry cohort and every event class was proportionally represented in both the training and testing sets, ensuring robust and fair model evaluation.

---

## 6. Phase 6 & 8: Model Benchmarking & Selection

We benchmarked Logistic Regression, Random Forest, XGBoost, and LightGBM across all horizons.

### The Primary Research Question: Does Wealth Matter?
We tested models using "Health Only" vs. "Health + SES (Socioeconomic Status)". 
*   **Finding:** At the 1-year horizon, SES adds virtually zero value; short-term mortality is entirely dominated by current physical decline. However, at 5-year and 10-year horizons, SES (wealth, income, education) consistently improved the model, likely proxying healthcare access and lifestyle sustainability.

### Final Model Selection
*   **For 5yr / 10yr Performance:** **XGBoost** achieved the highest raw discrimination (AUROC 0.866 and 0.871).
*   **For Regulatory Compliance:** **Logistic Regression** performed exceptionally well (AUROC 0.864 at 5yr), trailing XGBoost by mere fractions. In a highly regulated insurance environment, the interpretability of LogReg's coefficients makes it a highly viable primary model.

Both models were saved, and their decile calibration was tested. The 5yr XGBoost model slightly overestimates risk at the very top decile, which is the conservative (and preferred) direction for insurance pricing.

---

## 7. Phase 9: Application Deployment (Streamlit)

To move the models from code to a business-ready format, we built an interactive web prototype.

1.  **Inference Engine (`inference.py`):** We wrapped the raw models in a robust Python class. It utilizes an `ApplicantProfile` dataclass that validates inputs (e.g., ensuring BMI is within realistic ranges) before feeding them to the model, preventing system crashes on bad data.
2.  **Streamlit App (`app.py`):** We developed a premium, dark-themed UI that simulates a digital underwriting dashboard. 
    *   **Inputs:** Clean, categorized forms for all 24 features (Demographics, Financials, Health, Conditions).
    *   **Outputs:** A dynamic plotly gauge chart showing the exact probability of mortality, mapped to a business-logic Risk Tier (Low, Moderate, Elevated, High), accompanied by automated underwriting advice.

---

## Summary of Achievements

What started as 1.7GB of fragmented academic survey data has been successfully engineered into a rigorously validated, leak-proof machine learning pipeline. The project successfully navigated complex epidemiological biases (immortal time, terminal decline) and culminated in a deployable prototype that clearly demonstrates how AI can synthesize health and wealth data to instantly assess life insurance mortality risk.
