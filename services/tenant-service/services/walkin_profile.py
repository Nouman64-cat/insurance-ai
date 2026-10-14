"""The walk-in application carries the same information as the staff "Add New Customer" form (identity and contact, CNIC,
occupation and income, medical and lifestyle, habits, financial profile, nominee, plan). This module turns that flat
submission into a Customer's columns and the same nested `details` document the staff form writes, so the lead looks
exactly like one an agent entered.

Only the verified email is trusted for contact: whatever the form carries is replaced by it.
"""

import re
from datetime import date
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field as PField, field_validator, model_validator

CNIC_RE = re.compile(r"^\d{5}-?\d{7}-?\d$")
GENDERS = ("Male", "Female", "Other")
MARITAL = ("Single", "Married", "Divorced", "Widowed")


def format_cnic(raw: str) -> str:
    d = re.sub(r"\D", "", raw)
    return f"{d[:5]}-{d[5:12]}-{d[12:]}"


class WalkInProfile(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    # Identity & contact (required: the same as the staff form, plus mobile and city so an advisor can reach them)
    first_name: str = PField(min_length=1, max_length=120)
    last_name: str = PField(min_length=1, max_length=120)
    date_of_birth: date
    gender: str
    marital_status: Optional[str] = None
    cnic: Optional[str] = None
    mobile_number: str = PField(min_length=7, max_length=30)
    emergency_contact_name: Optional[str] = PField(default=None, max_length=255)
    street_address: Optional[str] = PField(default=None, max_length=500)
    city: str = PField(min_length=2, max_length=100)
    province: Optional[str] = PField(default=None, max_length=100)
    postal_code: Optional[str] = PField(default=None, max_length=20)
    # CNIC & docs
    cnic_issue_date: Optional[date] = None
    cnic_expiry_date: Optional[date] = None
    # Occupation & income
    employment_type: Optional[str] = PField(default=None, max_length=50)
    occupation: Optional[str] = PField(default=None, max_length=255)
    employer_name: Optional[str] = PField(default=None, max_length=255)
    industry: Optional[str] = PField(default=None, max_length=255)
    years_of_experience: Optional[int] = PField(default=None, ge=0, le=70)
    occupation_hazard_level: Optional[str] = PField(default=None, max_length=30)
    declared_annual_income: Optional[float] = PField(default=None, ge=0, le=10**10)
    monthly_income: Optional[float] = PField(default=None, ge=0, le=10**9)
    # Medical & lifestyle
    has_pre_existing_conditions: Optional[bool] = None
    is_smoker: Optional[bool] = None
    is_diabetic: Optional[bool] = None
    height_cm: Optional[float] = PField(default=None, ge=50, le=250)
    weight_kg: Optional[float] = PField(default=None, ge=10, le=400)
    exercise_frequency: Optional[str] = PField(default=None, max_length=30)
    # Habit check
    smoking_status: Optional[str] = PField(default=None, max_length=30)
    alcohol_consumption_frequency: Optional[str] = PField(default=None, max_length=30)
    recreational_drug_use_history: Optional[bool] = None
    participates_in_extreme_sports: Optional[bool] = None
    private_aviation: Optional[bool] = None
    frequent_high_risk_travel: Optional[bool] = None
    moving_violations_past_3_years: Optional[int] = PField(default=None, ge=0, le=50)
    dui_dwi_history: Optional[bool] = None
    criminal_record: Optional[bool] = None
    # Financial profile
    credit_score: Optional[int] = PField(default=None, ge=300, le=900)
    delinquency_count: Optional[int] = PField(default=None, ge=0, le=100)
    risk_grade: Optional[str] = PField(default=None, max_length=5)
    number_of_dependents: Optional[int] = PField(default=None, ge=0, le=30)
    dependent_type: Optional[str] = PField(default=None, max_length=30)
    # Nominee
    beneficiary_first_name: Optional[str] = PField(default=None, max_length=120)
    beneficiary_last_name: Optional[str] = PField(default=None, max_length=120)
    beneficiary_cnic: Optional[str] = None
    beneficiary_relationship: Optional[str] = PField(default=None, max_length=50)
    beneficiary_share: Optional[float] = PField(default=None, ge=0, le=100)
    # Insurance plan (the plan itself is chosen separately; these are the customer's own cover wishes, no price involved)
    policy_coverage: Optional[float] = PField(default=None, gt=0, le=10**11)
    policy_term: Optional[int] = PField(default=None, ge=1, le=100)

    @field_validator("gender")
    @classmethod
    def _gender(cls, v: str) -> str:
        if v not in GENDERS:
            raise ValueError("unknown gender")
        return v

    @field_validator("marital_status")
    @classmethod
    def _marital(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        if v not in MARITAL:
            raise ValueError("unknown marital status")
        return v

    @field_validator("cnic", "beneficiary_cnic")
    @classmethod
    def _cnic(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        if not CNIC_RE.match(v):
            raise ValueError("CNIC must look like 35201-1234567-1")
        return format_cnic(v)

    @field_validator("date_of_birth")
    @classmethod
    def _dob(cls, v: date) -> date:
        if v >= date.today() or v.year < 1900:
            raise ValueError("enter a valid date of birth")
        return v


class FamilyMemberIn(BaseModel):
    """One row of the staff "Add New Family" members table (the same fields, the same rules): the head is always insured, a
    spouse may be insured too, and every other relative is a nominee with a share of the head's death benefit."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    relationship: Literal["Self", "Spouse", "Child", "Parent", "Sibling", "Other"]
    name: str = PField(min_length=1, max_length=255)
    is_insured: bool = False
    share_pct: float = PField(default=0, ge=0, le=100)
    cnic: Optional[str] = None
    dob: Optional[date] = None
    gender: Optional[str] = None
    occupation: Optional[str] = PField(default=None, max_length=255)
    declared_income: Optional[float] = PField(default=None, ge=0, le=10**10)
    is_smoker: Optional[bool] = None
    height_cm: Optional[float] = PField(default=None, ge=50, le=250)
    weight_kg: Optional[float] = PField(default=None, ge=10, le=400)
    coverage_amount: Optional[float] = PField(default=None, gt=0, le=10**11)

    @field_validator("gender")
    @classmethod
    def _gender(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        if v not in GENDERS:
            raise ValueError("unknown gender")
        return v

    @field_validator("cnic")
    @classmethod
    def _cnic(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        if not CNIC_RE.match(v):
            raise ValueError("CNIC must look like 35201-1234567-1")
        return format_cnic(v)

    @field_validator("dob")
    @classmethod
    def _dob(cls, v: Optional[date]) -> Optional[date]:
        if v is not None and (v >= date.today() or v.year < 1900):
            raise ValueError("enter a valid date of birth")
        return v

    @model_validator(mode="after")
    def _rules(self):
        self.is_insured = self.relationship == "Self" or (self.relationship == "Spouse" and self.is_insured)
        if self.relationship != "Self" and not self.share_pct > 0:
            raise ValueError("every nominee and spouse needs a share")
        if self.relationship == "Self":
            self.share_pct = 0
        if self.is_insured:
            for field in ("cnic", "dob", "gender", "occupation", "declared_income"):
                if getattr(self, field) in (None, ""):
                    raise ValueError(f"an insured member needs {field}")
        return self


class FamilyApplication(BaseModel):
    """The staff "Add New Family" form: family details, the policy wanted, and the members."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    family_name: str = PField(min_length=1, max_length=255)
    contact_person: Optional[str] = PField(default=None, max_length=255)
    contact_phone: str = PField(min_length=7, max_length=30)
    household_declared_income: Optional[float] = PField(default=None, ge=0, le=10**10)
    city: str = PField(min_length=2, max_length=100)
    province: Optional[str] = PField(default=None, max_length=100)
    policy_type: Literal["Floater", "LifeBundle"] = "Floater"
    total_sum_insured: Optional[float] = PField(default=None, gt=0, le=10**11)
    discount_percentage: Optional[float] = PField(default=None, ge=0, le=100)
    term_years: int = PField(default=1, ge=1, le=100)
    effective_date: Optional[date] = None
    members: list[FamilyMemberIn] = PField(min_length=2, max_length=8)

    @model_validator(mode="after")
    def _rules(self):
        if sum(1 for m in self.members if m.relationship == "Self") != 1:
            raise ValueError("exactly one member must be the head")
        if sum(1 for m in self.members if m.relationship == "Spouse") > 1:
            raise ValueError("a family can have only one spouse")
        if self.policy_type == "Floater" and not self.total_sum_insured:
            raise ValueError("a health floater needs a total sum assured")
        if self.policy_type == "LifeBundle" and any(m.is_insured and not m.coverage_amount for m in self.members):
            raise ValueError("every insured member needs a sum assured for a life bundle")
        if abs(sum(m.share_pct for m in self.members if m.relationship != "Self") - 100) > 0.01:
            raise ValueError("nominee shares must total 100%")
        cnics = [m.cnic for m in self.members if m.cnic]
        if len(set(cnics)) != len(cnics):
            raise ValueError("two members have the same CNIC")
        return self


def _put(target: dict, **values: Any) -> None:
    for k, v in values.items():
        if v is not None and v != "":
            target[k] = v


def build_details(p: WalkInProfile, email: str) -> dict:
    """The staff form's `details` document (customerShared.defaultDetails), filled from the walk-in profile."""
    d: dict = {
        "cnic_metadata": {"issue_date": "", "expiry_date": "", "is_valid": True, "validation_status": "Valid", "validated_at": "", "front_image_url": "", "back_image_url": "", "ocr_extracted": False},
        "address": {"address_type": "Residential", "street_address": "", "area": "", "city": "", "district": "", "province": "", "country": "Pakistan", "postal_code": "", "is_primary": True, "is_verified": False},
        "contact": {"mobile_number": "", "phone_number": "", "email": "", "is_primary": True, "is_verified": False, "emergency_contact_name": "", "emergency_contact_phone": "", "emergency_contact_relation": ""},
        "occupation_details": {"job_title": "", "employer_name": "", "industry": "", "employment_type": "Salaried", "years_of_experience": 0, "occupation_hazard_level": "Low", "work_address": "", "is_current": True, "start_date": "", "end_date": ""},
        "income_record": {"monthly_income": 0, "annual_income": 0, "declared_income": 0, "verified_income": 0, "income_source": "Salary", "currency": "PKR", "income_stability_score": 100, "discrepancy_flag": False, "is_verified": False},
        "beneficiary": {"first_name": "", "last_name": "", "cnic_number": "", "date_of_birth": "", "relationship": "Spouse", "share_percentage": 100, "phone": "", "email": "", "address": "", "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True},
        "medical_history": {"has_pre_existing_conditions": False, "is_smoker": False, "is_diabetic": False, "has_hypertension": False, "has_heart_disease": False, "surgical_history": "", "notes": ""},
        "conditions": [], "family_history": [],
        "lifestyle": {"smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0, "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0, "height_cm": 0, "weight_kg": 0, "bmi": 0, "exercise_frequency": "Sedentary", "diet_type": "Regular", "has_hazardous_hobby": False, "hazardous_hobby_details": "", "occupation_hazard_level": "Low"},
        "financial_records": {"tax_records": [], "bank_statement": {"bank_name": "", "average_monthly_balance": 0, "transaction_volume": 0, "income_credits": 0, "expense_debits": 0, "cash_flow_score": 100, "anomaly_flag": False},
                              "debts": [], "credit_bureau": {"credit_score": 750, "credit_history_length": 0, "delinquency_count": 0, "default_history": False, "inquiry_count": 0, "risk_grade": "A", "bureau_name": ""},
                              "external_policies": [], "dependents": {"dependent_type": "Child", "number_of_dependents": 0, "financial_burden_score": 0, "dependency_ratio": 0}},
        "habit_check": {"smoking_status": "Non-smoker", "alcohol_consumption_frequency": "None", "recreational_drug_use_history": False, "participates_in_extreme_sports": False, "extreme_sports_details": [],
                        "private_aviation": False, "frequent_high_risk_travel": False, "travel_destinations": [], "moving_violations_past_3_years": 0, "dui_dwi_history": False, "criminal_record": False},
    }
    _put(d["cnic_metadata"], issue_date=p.cnic_issue_date.isoformat() if p.cnic_issue_date else None, expiry_date=p.cnic_expiry_date.isoformat() if p.cnic_expiry_date else None)
    _put(d["address"], street_address=p.street_address, city=p.city, province=p.province, postal_code=p.postal_code)
    _put(d["contact"], mobile_number=p.mobile_number, email=email, emergency_contact_name=p.emergency_contact_name)
    _put(d["occupation_details"], job_title=p.occupation, employer_name=p.employer_name, industry=p.industry, employment_type=p.employment_type,
         years_of_experience=p.years_of_experience, occupation_hazard_level=p.occupation_hazard_level)
    _put(d["income_record"], monthly_income=p.monthly_income, annual_income=p.declared_annual_income, declared_income=p.declared_annual_income)
    _put(d["medical_history"], has_pre_existing_conditions=p.has_pre_existing_conditions, is_smoker=p.is_smoker, is_diabetic=p.is_diabetic)
    _put(d["lifestyle"], height_cm=p.height_cm, weight_kg=p.weight_kg, exercise_frequency=p.exercise_frequency, occupation_hazard_level=p.occupation_hazard_level)
    if p.height_cm and p.weight_kg:
        d["lifestyle"]["bmi"] = round(p.weight_kg / ((p.height_cm / 100) ** 2), 1)
    _put(d["habit_check"], smoking_status=p.smoking_status, alcohol_consumption_frequency=p.alcohol_consumption_frequency,
         recreational_drug_use_history=p.recreational_drug_use_history, participates_in_extreme_sports=p.participates_in_extreme_sports,
         private_aviation=p.private_aviation, frequent_high_risk_travel=p.frequent_high_risk_travel,
         moving_violations_past_3_years=p.moving_violations_past_3_years, dui_dwi_history=p.dui_dwi_history, criminal_record=p.criminal_record)
    _put(d["financial_records"]["credit_bureau"], credit_score=p.credit_score, delinquency_count=p.delinquency_count, risk_grade=p.risk_grade)
    _put(d["financial_records"]["dependents"], number_of_dependents=p.number_of_dependents, dependent_type=p.dependent_type)
    _put(d["beneficiary"], first_name=p.beneficiary_first_name, last_name=p.beneficiary_last_name, cnic_number=p.beneficiary_cnic,
         relationship=p.beneficiary_relationship, share_percentage=p.beneficiary_share)
    # The keys the portal and the leads page read directly
    d["contact_email"], d["contact_phone"] = email, p.mobile_number
    return d
