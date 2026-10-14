"""(Copy of tenant-service/services/walkin_profile, strict: unknown fields are refused.)

The walk-in application carries the same information as the staff "Add New Customer" form (identity and contact, CNIC,
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
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

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
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

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
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

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
