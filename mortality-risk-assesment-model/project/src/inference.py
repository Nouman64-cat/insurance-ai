"""
inference.py
============
Ready-to-use inference helper for the Life Insurance Mortality Risk Models.

Usage:
    from inference import MortalityRiskPredictor
    predictor = MortalityRiskPredictor(horizon='5yr', model='xgboost')
    result = predictor.predict(applicant)
    print(result)

Or run directly:
    python inference.py
"""

import os
import joblib
import pandas as pd
import numpy as np
from dataclasses import dataclass, field
from typing import Literal, Optional

# ── Path config ────────────────────────────────────────────────────────────
MODEL_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')

# ── Feature order — MUST match training order exactly ──────────────────────
FEATURES = [
    'gender', 'birth_yr', 'hispan', 'educ', 'demo_age', 'demo_mstat', 'demo_region',
    'fin_income', 'fin_wealth', 'fin_wealth_liquid', 'fin_home_eq', 'fin_pension',
    'hlth_srh', 'hlth_bmi', 'hlth_smoken', 'hlth_smokev',
    'hlth_adl5a', 'hlth_iadl5a',
    'cond_hearte', 'cond_diabe', 'cond_cancre',
    'cond_stroke', 'cond_hibpe', 'cond_lunge',
]

# ── Risk tier thresholds ────────────────────────────────────────────────────
RISK_TIERS = [
    (0.00, 0.05,  'LOW',      '🟢', 'Standard rates apply.'),
    (0.05, 0.15,  'MODERATE', '🟡', 'Rate-up or further medical review recommended.'),
    (0.15, 0.35,  'ELEVATED', '🟠', 'Rated policy or exclusion clauses.'),
    (0.35, 1.01,  'HIGH',     '🔴', 'Consider decline or heavily rated policy.'),
]


@dataclass
class ApplicantProfile:
    """
    Complete applicant profile for mortality risk scoring.
    All fields are required for a valid prediction.

    Demographic
    -----------
    gender      : 1=Male  2=Female
    birth_yr    : Year of birth (e.g. 1955)
    demo_age    : Age at time of application (years, float)
    hispan      : 0=Non-Hispanic  1=Hispanic
    demo_mstat  : 1=Married 2=Partnered 3=Separated 4=Divorced 5=Widowed 7=Never married
    demo_region : 1=Northeast 2=Midwest 3=South 4=West

    Education
    ---------
    educ        : Years of formal education (0–17)

    Financial (2022 USD)
    --------------------
    fin_income       : Total household income (all sources)
    fin_wealth       : Total net wealth (assets minus all debts)
    fin_wealth_liquid: Liquid assets (stocks, bonds, checking, CDs)
    fin_home_eq      : Home equity (home value minus mortgage balance)
    fin_pension      : Present value of pension entitlements

    Health
    ------
    hlth_srh    : Self-rated health  1=Excellent 2=VeryGood 3=Good 4=Fair 5=Poor
    hlth_bmi    : Body Mass Index (kg/m²)
    hlth_smoken : Current smoker at application  0=No 1=Yes
    hlth_smokev : Ever smoked  0=No 1=Yes
    hlth_adl5a  : ADL difficulty count (0–5)  dressing, walking, bathing, eating, bed
    hlth_iadl5a : IADL difficulty count (0–5) phone, meds, money, shopping, meals

    Conditions (0=No  1=Yes, ever diagnosed)
    -----------------------------------------
    cond_hearte : Heart disease
    cond_diabe  : Diabetes
    cond_cancre : Cancer
    cond_stroke : Stroke / TIA
    cond_hibpe  : Hypertension
    cond_lunge  : Chronic lung disease (COPD, emphysema, asthma)
    """
    # Demographic
    gender:      int
    birth_yr:    int
    demo_age:    float
    hispan:      int
    demo_mstat:  int
    demo_region: int
    # Education
    educ:        int
    # Financial
    fin_income:       float
    fin_wealth:       float
    fin_wealth_liquid: float
    fin_home_eq:      float
    fin_pension:      float
    # Health
    hlth_srh:    int
    hlth_bmi:    float
    hlth_smoken: int
    hlth_smokev: int
    hlth_adl5a:  int
    hlth_iadl5a: int
    # Conditions
    cond_hearte: int
    cond_diabe:  int
    cond_cancre: int
    cond_stroke: int
    cond_hibpe:  int
    cond_lunge:  int

    def to_dataframe(self) -> pd.DataFrame:
        """Convert to single-row DataFrame in model feature order."""
        data = {f: getattr(self, f) for f in FEATURES}
        return pd.DataFrame([data], columns=FEATURES)

    def validate(self):
        """Basic range checks — raises ValueError if invalid."""
        errors = []
        if self.gender not in (1, 2):
            errors.append("gender must be 1 (Male) or 2 (Female)")
        if not (1900 < self.birth_yr < 2010):
            errors.append(f"birth_yr={self.birth_yr} looks invalid")
        if not (0 < self.demo_age < 120):
            errors.append(f"demo_age={self.demo_age} out of range")
        if self.hlth_srh not in range(1, 6):
            errors.append("hlth_srh must be 1–5")
        if not (10 < self.hlth_bmi < 80):
            errors.append(f"hlth_bmi={self.hlth_bmi} looks invalid")
        for cnt_field in ('hlth_adl5a', 'hlth_iadl5a'):
            val = getattr(self, cnt_field)
            if val not in range(0, 6):
                errors.append(f"{cnt_field}={val} must be 0–5")
        for bin_field in ('hispan','hlth_smoken','hlth_smokev',
                          'cond_hearte','cond_diabe','cond_cancre',
                          'cond_stroke','cond_hibpe','cond_lunge'):
            val = getattr(self, bin_field)
            if val not in (0, 1):
                errors.append(f"{bin_field}={val} must be 0 or 1")
        if errors:
            raise ValueError("Applicant validation failed:\n  " + "\n  ".join(errors))


class MortalityRiskPredictor:
    """
    Loads a trained model and returns mortality risk scores + risk tier.

    Parameters
    ----------
    horizon : '5yr' or '10yr'
    model   : 'xgboost' or 'logreg'
    """

    def __init__(
        self,
        horizon: Literal['5yr', '10yr'] = '5yr',
        model:   Literal['xgboost', 'logreg'] = 'xgboost',
    ):
        self.horizon = horizon
        self.model_name = model
        fname = f"{'xgboost' if model == 'xgboost' else 'logreg'}_{horizon}.joblib"
        fpath = os.path.join(MODEL_DIR, fname)
        if not os.path.exists(fpath):
            raise FileNotFoundError(
                f"Model file not found: {fpath}\n"
                f"Run phase8_model_training.py first."
            )
        self._model = joblib.load(fpath)

    def _get_risk_tier(self, prob: float) -> dict:
        for lo, hi, tier, icon, advice in RISK_TIERS:
            if lo <= prob < hi:
                return {'tier': tier, 'icon': icon, 'advice': advice}
        return {'tier': 'HIGH', 'icon': '🔴', 'advice': RISK_TIERS[-1][4]}

    def predict(self, applicant: ApplicantProfile) -> dict:
        """
        Score a single applicant.

        Returns
        -------
        dict with keys:
            probability  : float  (0.0 – 1.0)
            percent      : str    e.g. "8.3%"
            risk_tier    : str    LOW / MODERATE / ELEVATED / HIGH
            icon         : str    emoji indicator
            advice       : str    plain-language recommendation
            horizon      : str    prediction horizon
            model        : str    model used
        """
        applicant.validate()
        X = applicant.to_dataframe()
        prob = float(self._model.predict_proba(X)[0, 1])
        tier_info = self._get_risk_tier(prob)
        return {
            'probability': round(prob, 4),
            'percent':     f"{prob * 100:.1f}%",
            'risk_tier':   tier_info['tier'],
            'icon':        tier_info['icon'],
            'advice':      tier_info['advice'],
            'horizon':     self.horizon,
            'model':       self.model_name,
        }

    def predict_batch(self, applicants: list[ApplicantProfile]) -> pd.DataFrame:
        """
        Score multiple applicants at once.

        Returns a DataFrame with one row per applicant.
        """
        for a in applicants:
            a.validate()
        X = pd.concat([a.to_dataframe() for a in applicants], ignore_index=True)
        probs = self._model.predict_proba(X)[:, 1]
        rows = []
        for prob in probs:
            t = self._get_risk_tier(prob)
            rows.append({
                'probability': round(prob, 4),
                'percent':     f"{prob*100:.1f}%",
                'risk_tier':   t['tier'],
                'icon':        t['icon'],
            })
        return pd.DataFrame(rows)


class PakistaniMortalityRiskPredictor(MortalityRiskPredictor):
    """
    Mortality risk predictor with Bayesian credibility calibration for Pakistan.
    """
    def __init__(self, horizon: Literal['5yr', '10yr'] = '5yr', model: Literal['xgboost', 'logreg'] = 'xgboost', Z: float = 0.85):
        super().__init__(horizon, model)
        self.Z = Z
        self.cal_table_path = os.path.join(MODEL_DIR, 'calibration_table.csv')
        if not os.path.exists(self.cal_table_path):
            raise FileNotFoundError(f"Calibration table not found: {self.cal_table_path}")
        self.cal_table = pd.read_csv(self.cal_table_path)
        
    def _get_age_band(self, age: float) -> str:
        if age < 50: return '<50'
        elif age < 55: return '50-54'
        elif age < 65: return '55-64'
        elif age < 75: return '65-74'
        else: return '75+'
        
    def predict(self, applicant: ApplicantProfile) -> dict:
        result = super().predict(applicant)
        raw_prob = result['probability']
        
        age_band = self._get_age_band(applicant.demo_age)
        sex = applicant.gender
        
        bucket = self.cal_table[(self.cal_table['age_band'] == age_band) & (self.cal_table['sex'] == sex)]
        
        if bucket.empty or pd.isna(bucket.iloc[0]['model_avg_pred']) or pd.isna(bucket.iloc[0]['pakistan_qx']):
            result['is_calibrated'] = False
            return result
            
        qx_1yr = bucket.iloc[0]['pakistan_qx']
        model_avg = bucket.iloc[0]['model_avg_pred']
        
        # PDS qx is a 1-year mortality rate. Scale it to the correct horizon.
        if self.horizon == '5yr':
            qx = 1.0 - (1.0 - qx_1yr) ** 5
        elif self.horizon == '10yr':
            qx = 1.0 - (1.0 - qx_1yr) ** 10
        else:
            qx = qx_1yr
        
        import sys
        if os.path.dirname(__file__) not in sys.path:
            sys.path.append(os.path.dirname(__file__))
        from calibration import calibrate_mortality_risk
        
        cal_prob = calibrate_mortality_risk(raw_prob, model_avg, qx, self.Z)
        cal_tier_info = self._get_risk_tier(cal_prob)
        
        result.update({
            'raw_probability': raw_prob,
            'raw_percent': result['percent'],
            'raw_risk_tier': result['risk_tier'],
            
            'probability': round(cal_prob, 4),
            'percent': f"{cal_prob * 100:.1f}%",
            'risk_tier': cal_tier_info['tier'],
            'icon': cal_tier_info['icon'],
            'advice': cal_tier_info['advice'],
            'is_calibrated': True,
            'Z': self.Z,
            'bucket_model_avg': round(model_avg, 4),
            'bucket_pakistan_qx': round(qx, 4)
        })
        return result


# ══════════════════════════════════════════════════════════════════════════════
# DEMO — run directly to see example predictions
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("=" * 60)
    print("  MORTALITY RISK MODEL — Inference Demo")
    print("=" * 60)

    # Example applicants (fictitious)
    applicants = [
        ("Alice, 58, healthy professional", ApplicantProfile(
            gender=2, birth_yr=1966, demo_age=58, hispan=0,
            demo_mstat=1, demo_region=1, educ=16,
            fin_income=120_000, fin_wealth=850_000,
            fin_wealth_liquid=200_000, fin_home_eq=350_000, fin_pension=300_000,
            hlth_srh=2, hlth_bmi=23.5, hlth_smoken=0, hlth_smokev=0,
            hlth_adl5a=0, hlth_iadl5a=0,
            cond_hearte=0, cond_diabe=0, cond_cancre=0,
            cond_stroke=0, cond_hibpe=0, cond_lunge=0,
        )),
        ("Bob, 67, moderate health", ApplicantProfile(
            gender=1, birth_yr=1957, demo_age=67, hispan=0,
            demo_mstat=1, demo_region=3, educ=12,
            fin_income=55_000, fin_wealth=280_000,
            fin_wealth_liquid=40_000, fin_home_eq=180_000, fin_pension=60_000,
            hlth_srh=3, hlth_bmi=28.2, hlth_smoken=0, hlth_smokev=1,
            hlth_adl5a=1, hlth_iadl5a=0,
            cond_hearte=0, cond_diabe=1, cond_cancre=0,
            cond_stroke=0, cond_hibpe=1, cond_lunge=0,
        )),
        ("Carol, 74, poor health", ApplicantProfile(
            gender=2, birth_yr=1950, demo_age=74, hispan=0,
            demo_mstat=5, demo_region=2, educ=10,
            fin_income=22_000, fin_wealth=85_000,
            fin_wealth_liquid=12_000, fin_home_eq=60_000, fin_pension=0,
            hlth_srh=5, hlth_bmi=31.5, hlth_smoken=0, hlth_smokev=1,
            hlth_adl5a=3, hlth_iadl5a=2,
            cond_hearte=1, cond_diabe=1, cond_cancre=0,
            cond_stroke=1, cond_hibpe=1, cond_lunge=1,
        )),
    ]

    for horizon in ['5yr', '10yr']:
        print(f"\n  ── {horizon} Mortality Horizon ──")
        for model_type in ['xgboost', 'logreg']:
            predictor = MortalityRiskPredictor(horizon=horizon, model=model_type)
            print(f"\n    Model: {model_type.upper()}")
            for name, applicant in applicants:
                result = predictor.predict(applicant)
                print(f"      {name:<35} "
                      f"{result['icon']} {result['risk_tier']:<10} "
                      f"({result['percent']})")

    print("\n  ── Pakistani Calibrated 5yr Model (Z=0.85) ──")
    pak_predictor = PakistaniMortalityRiskPredictor(horizon='5yr', model='xgboost', Z=0.85)
    for name, applicant in applicants:
        res = pak_predictor.predict(applicant)
        if res.get('is_calibrated'):
            print(f"      {name:<35}")
            print(f"         Raw: {res['raw_percent']} ({res['raw_risk_tier']})")
            print(f"         Cal: {res['percent']} ({res['risk_tier']}) {res['icon']}")
            print(f"         (Bucket qx: {res['bucket_pakistan_qx']:.4f} | Model Avg: {res['bucket_model_avg']:.4f})")
        else:
            print(f"      {name:<35} [Not Calibrated (e.g. <50 age)]")

    # Batch example
    print("\n  ── Batch prediction example (XGBoost, 5yr) ──")
    batch_predictor = MortalityRiskPredictor(horizon='5yr', model='xgboost')
    batch_result = batch_predictor.predict_batch([a for _, a in applicants])
    print(batch_result.to_string(index=False))
