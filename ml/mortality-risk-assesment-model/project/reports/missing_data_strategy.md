# Missing Data Strategy & Imputation Report

## 1. Missingness Profile (Pre-Imputation)
| Feature | Missing % | Mechanism Classification |
|---------|-----------|--------------------------|
| `hlth_iadl5a` | 28.65% | MAR (Structural - 1992 Cohort Skip) |
| `hlth_adl5a` | 28.40% | MAR (Structural - 1992 Cohort Skip) |
| `demo_region` | 5.96% | MAR (Random Non-Response) |
| `hlth_bmi` | 1.63% | MAR (Random Non-Response) |
| `race` | 1.34% | MAR (Random Non-Response) |
| `hispan` | 1.25% | MAR (Random Non-Response) |
| `educ` | 1.11% | MAR (Random Non-Response) |
| `hlth_smokev` | 0.62% | MAR (Random Non-Response) |
| `demo_mstat` | 0.08% | MAR (Random Non-Response) |
| `hlth_srh` | 0.04% | MAR (Random Non-Response) |
| `hlth_smoken` | 0.04% | MAR (Random Non-Response) |
| `birth_yr` | 0.00% | MAR (Random Non-Response) |
| `demo_age` | 0.00% | MAR (Random Non-Response) |

## 2. Imputation Strategy
* **Financial Variables:** 0.0% missingness achieved using RAND's pre-imputed asset and income features. No secondary imputation applied to preserve RAND's actuarial methodology.
* **Health/Demographic Variables:** Applied Multiple Imputation by Chained Equations (MICE) via `sklearn.IterativeImputer`. Complete financial and demographic variables were used as robust anchors to predict missing structural health data (e.g., ADL/IADL gaps from the 1992 cohort).

## 3. Post-Imputation Audit
* Total missing values pre-imputation: 31266
* Total missing values post-imputation: 0
* Target variables and metadata (entry_wave) were strictly excluded from the MICE predictor matrix to prevent leakage and string-parsing errors.