"""Seed 10 realistic customer profiles (+ one policy each) for a tenant.

Every customer is a distinct, original fictional person covering a wide
spread of Pakistani cities, occupations, incomes, medical histories, and
insurance needs. The seed is idempotent: any CNIC already present for the
given tenant is silently skipped — safe to run multiple times.

Run inside the tenant-service container:

    # Seed one tenant
    docker compose exec tenant-service python -m seeds.customers_seed \
        --tenant-id 05788cf6-5bf0-4895-b73d-28bbe334518d

    # Seed every tenant in the database
    docker compose exec tenant-service python -m seeds.customers_seed --all-tenants
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import random
from datetime import date
from typing import Optional
from uuid import UUID

from aiokafka import AIOKafkaProducer
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.events.kafka_events import CUSTOMER_CREATED_TOPIC, CustomerCreatedEvent, CustomerCreatedPayload
from shared.models.core import Customer, Policy, Tenant
from seeds.acquisition_sources_seed import get_or_seed_sources

logger = logging.getLogger("tenant-service.seeds.customers")


# ─────────────────────────────────────────────────────────────────────────────
# Seed data — 10 original customers
# Each dict mirrors the CustomerCreate schema fields.
# The special "_policy" key (popped before DB insert) carries the linked policy.
# ─────────────────────────────────────────────────────────────────────────────

CUSTOMER_SEED_DATA: list[dict] = [

    # ── 1. Tariq Mehmood — Civil Engineer, Lahore, smoker/hypertensive ─────────
    {
        "cnic":            "35202-8841673-3",
        "first_name":      "Tariq",
        "last_name":       "Mehmood",
        "date_of_birth":   date(1982, 4, 17),
        "gender":          "Male",
        "marital_status":  "Married",
        "nationality":     "Pakistani",
        "occupation":      "Civil Engineer",
        "declared_income": 2_400_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2015-03-10", "expiry_date": "2025-03-10",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-01-05T09:00:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "House 14, Street 6, Johar Town",
                "area": "Johar Town", "city": "Lahore",
                "district": "Lahore", "province": "Punjab",
                "country": "Pakistan", "postal_code": "54782",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0300-4421873", "phone_number": "042-35761234",
                "email": "tariq.mehmood82@gmail.com",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Nadia Mehmood",
                "emergency_contact_phone": "0312-4421873",
                "emergency_contact_relation": "Spouse"
            },
            "occupation_details": {
                "job_title": "Senior Civil Engineer",
                "employer_name": "National Engineering Services Pakistan (NESPAK)",
                "industry": "Construction & Infrastructure",
                "employment_type": "Salaried",
                "years_of_experience": 18,
                "occupation_hazard_level": "Medium",
                "work_address": "NESPAK House, Lahore",
                "is_current": True, "start_date": "2006-07-01", "end_date": ""
            },
            "income_record": {
                "monthly_income": 200000, "annual_income": 2400000,
                "declared_income": 2400000, "verified_income": 2350000,
                "income_source": "Salary", "currency": "PKR",
                "income_stability_score": 88, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Nadia", "last_name": "Mehmood",
                "cnic_number": "35202-6612984-6", "date_of_birth": "1985-09-22",
                "relationship": "Spouse", "share_percentage": 100,
                "phone": "0312-4421873", "email": "nadia.mehmood@gmail.com",
                "address": "House 14, Street 6, Johar Town, Lahore",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": True, "is_smoker": True,
                "is_diabetic": False, "has_hypertension": True, "has_heart_disease": False,
                "surgical_history": "Appendectomy (2010)",
                "notes": "On antihypertensive medication since 2019. 15 cigarettes/day."
            },
            "conditions": [
                {"condition_name": "Hypertension", "severity": "Moderate",
                 "diagnosis_date": "2019-03-15", "is_chronic": True}
            ],
            "family_history": [
                {"relation": "Father", "age": "72", "is_alive": True,  "condition_name": "Hypertension"},
                {"relation": "Mother", "age": "68", "is_alive": True,  "condition_name": "Type 2 Diabetes"}
            ],
            "lifestyle": {
                "smoking_status": "CurrentSmoker", "packs_per_day": 0.75, "smoking_years": 15,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 174, "weight_kg": 86, "bmi": 28.4,
                "exercise_frequency": "Light", "diet_type": "Regular",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Medium"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "HBL", "average_monthly_balance": 350000,
                    "transaction_volume": 45, "income_credits": 200000,
                    "expense_debits": 155000, "cash_flow_score": 78, "anomaly_flag": False
                },
                "debts": [{"debt_type": "Car Loan", "outstanding_amount": 800000, "monthly_emi": 28000}],
                "credit_bureau": {
                    "credit_score": 710, "credit_history_length": 14,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 2, "risk_grade": "B", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Spouse", "number_of_dependents": 3,
                    "financial_burden_score": 45, "dependency_ratio": 0.58
                }
            }
        },
        "_policy": {
            "product_name": "Term Life", "insurance_type": "TERM_LIFE",
            "coverage_amount": 10_000_000, "term_years": 20,
            "dependent_name": None, "dependent_dob": None,
        }
    },

    # ── 2. Sadia Farooq — Software Engineer, Karachi, healthy & active ─────────
    {
        "cnic":            "42201-7734562-8",
        "first_name":      "Sadia",
        "last_name":       "Farooq",
        "date_of_birth":   date(1993, 11, 3),
        "gender":          "Female",
        "marital_status":  "Single",
        "nationality":     "Pakistani",
        "occupation":      "Software Engineer",
        "declared_income": 3_600_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2013-11-10", "expiry_date": "2023-11-10",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-02-11T10:30:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "Apt 7B, Clifton Block 4",
                "area": "Clifton", "city": "Karachi",
                "district": "Karachi South", "province": "Sindh",
                "country": "Pakistan", "postal_code": "75600",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0321-2237841", "phone_number": "",
                "email": "sadia.farooq@techcorp.pk",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Rehana Farooq",
                "emergency_contact_phone": "0321-2237800",
                "emergency_contact_relation": "Mother"
            },
            "occupation_details": {
                "job_title": "Senior Software Engineer", "employer_name": "Systems Limited",
                "industry": "Information Technology", "employment_type": "Salaried",
                "years_of_experience": 6, "occupation_hazard_level": "Low",
                "work_address": "Systems Limited, Korangi Creek, Karachi",
                "is_current": True, "start_date": "2018-08-01", "end_date": ""
            },
            "income_record": {
                "monthly_income": 300000, "annual_income": 3600000,
                "declared_income": 3600000, "verified_income": 3600000,
                "income_source": "Salary", "currency": "PKR",
                "income_stability_score": 96, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Rehana", "last_name": "Farooq",
                "cnic_number": "42201-5523418-2", "date_of_birth": "1962-05-14",
                "relationship": "Parent", "share_percentage": 100,
                "phone": "0321-2237800", "email": "",
                "address": "Clifton Block 4, Karachi",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": False, "is_smoker": False,
                "is_diabetic": False, "has_hypertension": False, "has_heart_disease": False,
                "surgical_history": "None",
                "notes": "Excellent health. Regular gym-goer. No medications."
            },
            "conditions": [],
            "family_history": [
                {"relation": "Father", "age": "65", "is_alive": True, "condition_name": "None"},
                {"relation": "Mother", "age": "62", "is_alive": True, "condition_name": "Mild Arthritis"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 163, "weight_kg": 58, "bmi": 21.8,
                "exercise_frequency": "Active", "diet_type": "Balanced",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "Meezan Bank", "average_monthly_balance": 600000,
                    "transaction_volume": 38, "income_credits": 300000,
                    "expense_debits": 120000, "cash_flow_score": 94, "anomaly_flag": False
                },
                "debts": [],
                "credit_bureau": {
                    "credit_score": 790, "credit_history_length": 5,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 1, "risk_grade": "A", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Parent", "number_of_dependents": 0,
                    "financial_burden_score": 10, "dependency_ratio": 0.1
                }
            }
        },
        "_policy": {
            "product_name": "Whole Life", "insurance_type": "WHOLE_LIFE",
            "coverage_amount": 15_000_000, "term_years": 30,
            "dependent_name": None, "dependent_dob": None,
        }
    },

    # ── 3. Kamran Niazi — Retired Army Officer, Peshawar, diabetic ─────────────
    {
        "cnic":            "17301-1122378-5",
        "first_name":      "Kamran",
        "last_name":       "Niazi",
        "date_of_birth":   date(1969, 7, 22),
        "gender":          "Male",
        "marital_status":  "Married",
        "nationality":     "Pakistani",
        "occupation":      "Retired Army Officer",
        "declared_income": 1_800_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2012-08-01", "expiry_date": "2022-08-01",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-01-20T08:00:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "House 3, Hayatabad Phase 2",
                "area": "Hayatabad", "city": "Peshawar",
                "district": "Peshawar", "province": "Khyber Pakhtunkhwa",
                "country": "Pakistan", "postal_code": "25000",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0334-9117654", "phone_number": "091-5842311",
                "email": "kamran.niazi69@yahoo.com",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Asma Niazi",
                "emergency_contact_phone": "0334-9117600",
                "emergency_contact_relation": "Spouse"
            },
            "occupation_details": {
                "job_title": "Retired Lieutenant Colonel",
                "employer_name": "Pakistan Army (Retired)",
                "industry": "Defence / Government", "employment_type": "Retired",
                "years_of_experience": 30, "occupation_hazard_level": "Low",
                "work_address": "",
                "is_current": False, "start_date": "1991-04-01", "end_date": "2021-04-01"
            },
            "income_record": {
                "monthly_income": 150000, "annual_income": 1800000,
                "declared_income": 1800000, "verified_income": 1800000,
                "income_source": "Pension", "currency": "PKR",
                "income_stability_score": 95, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Asma", "last_name": "Niazi",
                "cnic_number": "17301-8834512-4", "date_of_birth": "1972-03-10",
                "relationship": "Spouse", "share_percentage": 60,
                "phone": "0334-9117600", "email": "",
                "address": "House 3, Hayatabad Phase 2, Peshawar",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": True, "is_smoker": False,
                "is_diabetic": True, "has_hypertension": True, "has_heart_disease": False,
                "surgical_history": "Knee replacement (2018)",
                "notes": "Type 2 Diabetes diagnosed 2012. Controlled on oral medication. BP managed."
            },
            "conditions": [
                {"condition_name": "Type 2 Diabetes", "severity": "Moderate",
                 "diagnosis_date": "2012-06-01", "is_chronic": True},
                {"condition_name": "Hypertension", "severity": "Mild",
                 "diagnosis_date": "2015-02-20", "is_chronic": True}
            ],
            "family_history": [
                {"relation": "Father", "age": "deceased", "is_alive": False, "condition_name": "Heart Disease"},
                {"relation": "Mother", "age": "78", "is_alive": True, "condition_name": "Type 2 Diabetes"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 178, "weight_kg": 92, "bmi": 29.0,
                "exercise_frequency": "Light", "diet_type": "Diabetic",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "Bank Alfalah", "average_monthly_balance": 280000,
                    "transaction_volume": 22, "income_credits": 150000,
                    "expense_debits": 95000, "cash_flow_score": 82, "anomaly_flag": False
                },
                "debts": [],
                "credit_bureau": {
                    "credit_score": 740, "credit_history_length": 18,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 0, "risk_grade": "A", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Spouse", "number_of_dependents": 2,
                    "financial_burden_score": 35, "dependency_ratio": 0.4
                }
            }
        },
        "_policy": {
            "product_name": "Endowment / Savings Plan", "insurance_type": "ENDOWMENT",
            "coverage_amount": 5_000_000, "term_years": 10,
            "dependent_name": None, "dependent_dob": None,
        }
    },

    # ── 4. Ayesha Zuberi — Medical Doctor, Islamabad, low-risk ────────────────
    {
        "cnic":            "61101-4455223-0",
        "first_name":      "Ayesha",
        "last_name":       "Zuberi",
        "date_of_birth":   date(1996, 2, 14),
        "gender":          "Female",
        "marital_status":  "Single",
        "nationality":     "Pakistani",
        "occupation":      "Medical Doctor",
        "declared_income": 4_200_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2014-02-20", "expiry_date": "2024-02-20",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-03-01T11:00:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "Block C, PWD Housing Scheme, Sector I-14",
                "area": "I-14", "city": "Islamabad",
                "district": "Islamabad", "province": "Federal",
                "country": "Pakistan", "postal_code": "44000",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0333-5567892", "phone_number": "051-9261100",
                "email": "dr.ayesha.zuberi@shifa.com.pk",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Prof. Khalid Zuberi",
                "emergency_contact_phone": "0333-5567800",
                "emergency_contact_relation": "Father"
            },
            "occupation_details": {
                "job_title": "Resident Physician — Internal Medicine",
                "employer_name": "Shifa International Hospital",
                "industry": "Healthcare", "employment_type": "Salaried",
                "years_of_experience": 3, "occupation_hazard_level": "Low",
                "work_address": "Shifa International Hospital, H-8/4, Islamabad",
                "is_current": True, "start_date": "2022-01-15", "end_date": ""
            },
            "income_record": {
                "monthly_income": 350000, "annual_income": 4200000,
                "declared_income": 4200000, "verified_income": 4200000,
                "income_source": "Salary", "currency": "PKR",
                "income_stability_score": 98, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Khalid", "last_name": "Zuberi",
                "cnic_number": "61101-3341892-7", "date_of_birth": "1964-07-30",
                "relationship": "Parent", "share_percentage": 100,
                "phone": "0333-5567800", "email": "khalid.zuberi@qau.edu.pk",
                "address": "I-14, Islamabad",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": False, "is_smoker": False,
                "is_diabetic": False, "has_hypertension": False, "has_heart_disease": False,
                "surgical_history": "Tonsillectomy (2008, childhood)",
                "notes": "Peak health. No current medications. Annual medical checkups clear."
            },
            "conditions": [],
            "family_history": [
                {"relation": "Father", "age": "60", "is_alive": True, "condition_name": "None"},
                {"relation": "Mother", "age": "57", "is_alive": True, "condition_name": "Hypothyroidism"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 165, "weight_kg": 57, "bmi": 20.9,
                "exercise_frequency": "Moderate", "diet_type": "Balanced",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "UBL", "average_monthly_balance": 750000,
                    "transaction_volume": 28, "income_credits": 350000,
                    "expense_debits": 130000, "cash_flow_score": 96, "anomaly_flag": False
                },
                "debts": [],
                "credit_bureau": {
                    "credit_score": 800, "credit_history_length": 3,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 0, "risk_grade": "A", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Parent", "number_of_dependents": 0,
                    "financial_burden_score": 5, "dependency_ratio": 0.05
                }
            }
        },
        "_policy": {
            "product_name": "Term Life Premier", "insurance_type": "TERM_LIFE",
            "coverage_amount": 20_000_000, "term_years": 25,
            "dependent_name": None, "dependent_dob": None,
        }
    },

    # ── 5. Bilal Hussain — School Principal, Lahore, child plan ───────────────
    {
        "cnic":            "35301-5563491-1",
        "first_name":      "Bilal",
        "last_name":       "Hussain",
        "date_of_birth":   date(1986, 9, 5),
        "gender":          "Male",
        "marital_status":  "Married",
        "nationality":     "Pakistani",
        "occupation":      "School Principal",
        "declared_income": 1_500_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2016-09-12", "expiry_date": "2026-09-12",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-04-10T08:30:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "202 Garden Block, Garden Town",
                "area": "Garden Town", "city": "Lahore",
                "district": "Lahore", "province": "Punjab",
                "country": "Pakistan", "postal_code": "54600",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0300-9934567", "phone_number": "042-35771234",
                "email": "bilal.hussain.edu@gmail.com",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Maryam Hussain",
                "emergency_contact_phone": "0300-9934500",
                "emergency_contact_relation": "Spouse"
            },
            "occupation_details": {
                "job_title": "Principal", "employer_name": "Beaconhouse School System",
                "industry": "Education", "employment_type": "Salaried",
                "years_of_experience": 12, "occupation_hazard_level": "Low",
                "work_address": "Beaconhouse, Garden Town Campus, Lahore",
                "is_current": True, "start_date": "2012-04-01", "end_date": ""
            },
            "income_record": {
                "monthly_income": 125000, "annual_income": 1500000,
                "declared_income": 1500000, "verified_income": 1500000,
                "income_source": "Salary", "currency": "PKR",
                "income_stability_score": 91, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Maryam", "last_name": "Hussain",
                "cnic_number": "35301-6621345-8", "date_of_birth": "1988-12-01",
                "relationship": "Spouse", "share_percentage": 50,
                "phone": "0300-9934500", "email": "maryam.h@gmail.com",
                "address": "202 Garden Block, Garden Town, Lahore",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": False, "is_smoker": False,
                "is_diabetic": False, "has_hypertension": False, "has_heart_disease": False,
                "surgical_history": "None", "notes": "Good health. Occasional seasonal allergies."
            },
            "conditions": [],
            "family_history": [
                {"relation": "Father", "age": "68", "is_alive": True, "condition_name": "Type 2 Diabetes"},
                {"relation": "Mother", "age": "65", "is_alive": True, "condition_name": "None"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 172, "weight_kg": 74, "bmi": 25.0,
                "exercise_frequency": "Light", "diet_type": "Regular",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "MCB", "average_monthly_balance": 180000,
                    "transaction_volume": 32, "income_credits": 125000,
                    "expense_debits": 92000, "cash_flow_score": 80, "anomaly_flag": False
                },
                "debts": [{"debt_type": "Home Loan", "outstanding_amount": 3500000, "monthly_emi": 42000}],
                "credit_bureau": {
                    "credit_score": 720, "credit_history_length": 10,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 1, "risk_grade": "B", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Child", "number_of_dependents": 1,
                    "financial_burden_score": 30, "dependency_ratio": 0.45
                }
            }
        },
        "_policy": {
            "product_name": "Child Education & Marriage Plan",
            "insurance_type": "CHILD_EDUCATION_MARRIAGE",
            "coverage_amount": 3_000_000, "term_years": 15,
            "dependent_name": "Fatima Hussain", "dependent_dob": date(2015, 6, 18),
        }
    },

    # ── 6. Nadia Qureshi — Textile Trader, Multan, mild asthma ────────────────
    {
        "cnic":            "36302-7712309-7",
        "first_name":      "Nadia",
        "last_name":       "Qureshi",
        "date_of_birth":   date(1979, 3, 28),
        "gender":          "Female",
        "marital_status":  "Married",
        "nationality":     "Pakistani",
        "occupation":      "Textile Trader",
        "declared_income": 2_700_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2011-04-05", "expiry_date": "2021-04-05",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-01-15T09:30:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "B-7, Gulgasht Colony",
                "area": "Gulgasht Colony", "city": "Multan",
                "district": "Multan", "province": "Punjab",
                "country": "Pakistan", "postal_code": "60000",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0301-6618900", "phone_number": "061-4512345",
                "email": "nadia.qureshi.trade@gmail.com",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Imran Qureshi",
                "emergency_contact_phone": "0301-6618901",
                "emergency_contact_relation": "Spouse"
            },
            "occupation_details": {
                "job_title": "Proprietor", "employer_name": "Qureshi Textile Trading Co.",
                "industry": "Textile & Garments", "employment_type": "Self-Employed",
                "years_of_experience": 20, "occupation_hazard_level": "Low",
                "work_address": "Kumharan Wala Bazaar, Multan",
                "is_current": True, "start_date": "2004-03-01", "end_date": ""
            },
            "income_record": {
                "monthly_income": 225000, "annual_income": 2700000,
                "declared_income": 2700000, "verified_income": 2400000,
                "income_source": "Business", "currency": "PKR",
                "income_stability_score": 74, "discrepancy_flag": True, "is_verified": False
            },
            "beneficiary": {
                "first_name": "Imran", "last_name": "Qureshi",
                "cnic_number": "36302-5512109-3", "date_of_birth": "1976-08-11",
                "relationship": "Spouse", "share_percentage": 100,
                "phone": "0301-6618901", "email": "",
                "address": "B-7, Gulgasht Colony, Multan",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": True, "is_smoker": False,
                "is_diabetic": False, "has_hypertension": False, "has_heart_disease": False,
                "surgical_history": "Appendectomy (2001)",
                "notes": "Mild intermittent asthma since childhood. Uses inhaler occasionally."
            },
            "conditions": [
                {"condition_name": "Asthma", "severity": "Mild",
                 "diagnosis_date": "1995-01-01", "is_chronic": True}
            ],
            "family_history": [
                {"relation": "Father", "age": "70", "is_alive": True, "condition_name": "Hypertension"},
                {"relation": "Mother", "age": "66", "is_alive": True, "condition_name": "Asthma"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 160, "weight_kg": 68, "bmi": 26.6,
                "exercise_frequency": "Light", "diet_type": "Regular",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "Habib Bank Limited", "average_monthly_balance": 420000,
                    "transaction_volume": 58, "income_credits": 225000,
                    "expense_debits": 160000, "cash_flow_score": 72, "anomaly_flag": False
                },
                "debts": [],
                "credit_bureau": {
                    "credit_score": 680, "credit_history_length": 12,
                    "delinquency_count": 1, "default_history": False,
                    "inquiry_count": 3, "risk_grade": "B", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Child", "number_of_dependents": 3,
                    "financial_burden_score": 55, "dependency_ratio": 0.62
                }
            }
        },
        "_policy": {
            "product_name": "Endowment / Savings Plan", "insurance_type": "ENDOWMENT",
            "coverage_amount": 8_000_000, "term_years": 15,
            "dependent_name": None, "dependent_dob": None,
        }
    },

    # ── 7. Hassan Raza — Junior Developer, Karachi, entry-level healthy ────────
    {
        "cnic":            "42301-3345678-2",
        "first_name":      "Hassan",
        "last_name":       "Raza",
        "date_of_birth":   date(1998, 6, 11),
        "gender":          "Male",
        "marital_status":  "Single",
        "nationality":     "Pakistani",
        "occupation":      "Software Developer",
        "declared_income": 960_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2016-06-18", "expiry_date": "2026-06-18",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-05-01T12:00:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "Flat 3, Block A, North Nazimabad",
                "area": "North Nazimabad", "city": "Karachi",
                "district": "Karachi Central", "province": "Sindh",
                "country": "Pakistan", "postal_code": "74700",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0316-2256789", "phone_number": "",
                "email": "hassan.raza.dev@gmail.com",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Shaukat Raza",
                "emergency_contact_phone": "0316-2256700",
                "emergency_contact_relation": "Father"
            },
            "occupation_details": {
                "job_title": "Junior Software Developer", "employer_name": "Arbisoft",
                "industry": "Information Technology", "employment_type": "Salaried",
                "years_of_experience": 2, "occupation_hazard_level": "Low",
                "work_address": "Arbisoft, Karachi Tech Hub",
                "is_current": True, "start_date": "2022-09-01", "end_date": ""
            },
            "income_record": {
                "monthly_income": 80000, "annual_income": 960000,
                "declared_income": 960000, "verified_income": 960000,
                "income_source": "Salary", "currency": "PKR",
                "income_stability_score": 85, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Shaukat", "last_name": "Raza",
                "cnic_number": "42301-1134567-9", "date_of_birth": "1965-02-14",
                "relationship": "Parent", "share_percentage": 100,
                "phone": "0316-2256700", "email": "",
                "address": "North Nazimabad, Karachi",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": False, "is_smoker": False,
                "is_diabetic": False, "has_hypertension": False, "has_heart_disease": False,
                "surgical_history": "None",
                "notes": "No health issues. Sedentary lifestyle due to desk job."
            },
            "conditions": [],
            "family_history": [
                {"relation": "Father", "age": "59", "is_alive": True, "condition_name": "None"},
                {"relation": "Mother", "age": "55", "is_alive": True, "condition_name": "Hypertension"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 170, "weight_kg": 65, "bmi": 22.5,
                "exercise_frequency": "Sedentary", "diet_type": "Regular",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "Faysal Bank", "average_monthly_balance": 95000,
                    "transaction_volume": 20, "income_credits": 80000,
                    "expense_debits": 60000, "cash_flow_score": 76, "anomaly_flag": False
                },
                "debts": [],
                "credit_bureau": {
                    "credit_score": 650, "credit_history_length": 2,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 0, "risk_grade": "B", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Parent", "number_of_dependents": 0,
                    "financial_burden_score": 8, "dependency_ratio": 0.1
                }
            }
        },
        "_policy": {
            "product_name": "Term Life", "insurance_type": "TERM_LIFE",
            "coverage_amount": 3_000_000, "term_years": 10,
            "dependent_name": None, "dependent_dob": None,
        }
    },

    # ── 8. Rukhsana Malik — Govt Officer, Quetta, hypertension/overweight ──────
    {
        "cnic":            "54400-2241897-3",
        "first_name":      "Rukhsana",
        "last_name":       "Malik",
        "date_of_birth":   date(1974, 12, 9),
        "gender":          "Female",
        "marital_status":  "Widowed",
        "nationality":     "Pakistani",
        "occupation":      "Government Officer",
        "declared_income": 1_800_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2013-01-22", "expiry_date": "2023-01-22",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-01-08T07:45:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "House 12, Satellite Town",
                "area": "Satellite Town", "city": "Quetta",
                "district": "Quetta", "province": "Balochistan",
                "country": "Pakistan", "postal_code": "87300",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0311-8834521", "phone_number": "081-9202123",
                "email": "rukhsana.malik.govt@gmail.com",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Amina Malik",
                "emergency_contact_phone": "0311-8834500",
                "emergency_contact_relation": "Sister"
            },
            "occupation_details": {
                "job_title": "Deputy Director — Public Health",
                "employer_name": "Government of Balochistan — Health Department",
                "industry": "Government / Public Sector", "employment_type": "Salaried",
                "years_of_experience": 24, "occupation_hazard_level": "Low",
                "work_address": "Directorate of Health, Civil Lines, Quetta",
                "is_current": True, "start_date": "2000-09-01", "end_date": ""
            },
            "income_record": {
                "monthly_income": 150000, "annual_income": 1800000,
                "declared_income": 1800000, "verified_income": 1800000,
                "income_source": "Salary", "currency": "PKR",
                "income_stability_score": 97, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Zain", "last_name": "Malik",
                "cnic_number": "", "date_of_birth": "2008-05-30",
                "relationship": "Child", "share_percentage": 100,
                "phone": "", "email": "",
                "address": "House 12, Satellite Town, Quetta",
                "is_minor": True, "guardian_name": "Amina Malik",
                "guardian_cnic": "54400-3341897-5", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": True, "is_smoker": False,
                "is_diabetic": False, "has_hypertension": True, "has_heart_disease": False,
                "surgical_history": "C-section (2008)",
                "notes": "Stage 1 hypertension. On low-dose medication. BMI borderline."
            },
            "conditions": [
                {"condition_name": "Hypertension", "severity": "Mild",
                 "diagnosis_date": "2017-06-14", "is_chronic": True}
            ],
            "family_history": [
                {"relation": "Father", "age": "deceased", "is_alive": False, "condition_name": "Heart Disease"},
                {"relation": "Mother", "age": "73", "is_alive": True, "condition_name": "Hypertension"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 158, "weight_kg": 80, "bmi": 32.0,
                "exercise_frequency": "Sedentary", "diet_type": "Regular",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "National Bank of Pakistan", "average_monthly_balance": 240000,
                    "transaction_volume": 18, "income_credits": 150000,
                    "expense_debits": 110000, "cash_flow_score": 79, "anomaly_flag": False
                },
                "debts": [],
                "credit_bureau": {
                    "credit_score": 700, "credit_history_length": 15,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 1, "risk_grade": "B", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Child", "number_of_dependents": 1,
                    "financial_burden_score": 40, "dependency_ratio": 0.5
                }
            }
        },
        "_policy": {
            "product_name": "Whole Life", "insurance_type": "WHOLE_LIFE",
            "coverage_amount": 7_000_000, "term_years": 20,
            "dependent_name": None, "dependent_dob": None,
        }
    },

    # ── 9. Faisal Chaudhry — Banker, Islamabad, child plan for twin ────────────
    {
        "cnic":            "61101-7789034-6",
        "first_name":      "Faisal",
        "last_name":       "Chaudhry",
        "date_of_birth":   date(1990, 1, 20),
        "gender":          "Male",
        "marital_status":  "Married",
        "nationality":     "Pakistani",
        "occupation":      "Assistant Vice President — Retail Banking",
        "declared_income": 3_000_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2008-01-28", "expiry_date": "2028-01-28",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-02-20T10:15:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "House 7B, F-7/2",
                "area": "F-7", "city": "Islamabad",
                "district": "Islamabad", "province": "Federal",
                "country": "Pakistan", "postal_code": "44000",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0345-5112347", "phone_number": "051-8437890",
                "email": "faisal.chaudhry@ubl.com.pk",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Sana Chaudhry",
                "emergency_contact_phone": "0345-5112300",
                "emergency_contact_relation": "Spouse"
            },
            "occupation_details": {
                "job_title": "AVP — Retail Banking", "employer_name": "United Bank Limited",
                "industry": "Banking & Finance", "employment_type": "Salaried",
                "years_of_experience": 9, "occupation_hazard_level": "Low",
                "work_address": "UBL Head Office, Jinnah Avenue, Islamabad",
                "is_current": True, "start_date": "2015-06-01", "end_date": ""
            },
            "income_record": {
                "monthly_income": 250000, "annual_income": 3000000,
                "declared_income": 3000000, "verified_income": 3000000,
                "income_source": "Salary", "currency": "PKR",
                "income_stability_score": 94, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Sana", "last_name": "Chaudhry",
                "cnic_number": "61101-4489034-1", "date_of_birth": "1992-07-04",
                "relationship": "Spouse", "share_percentage": 100,
                "phone": "0345-5112300", "email": "sana.chaudhry@gmail.com",
                "address": "House 7B, F-7/2, Islamabad",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": False, "is_smoker": False,
                "is_diabetic": False, "has_hypertension": False, "has_heart_disease": False,
                "surgical_history": "None",
                "notes": "Healthy. Mild work stress — monitored by GP annually."
            },
            "conditions": [],
            "family_history": [
                {"relation": "Father", "age": "64", "is_alive": True, "condition_name": "High Cholesterol"},
                {"relation": "Mother", "age": "61", "is_alive": True, "condition_name": "None"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 176, "weight_kg": 80, "bmi": 25.8,
                "exercise_frequency": "Moderate", "diet_type": "Balanced",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "United Bank Limited", "average_monthly_balance": 520000,
                    "transaction_volume": 42, "income_credits": 250000,
                    "expense_debits": 140000, "cash_flow_score": 90, "anomaly_flag": False
                },
                "debts": [{"debt_type": "Car Loan", "outstanding_amount": 1200000, "monthly_emi": 35000}],
                "credit_bureau": {
                    "credit_score": 760, "credit_history_length": 8,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 2, "risk_grade": "A", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Child", "number_of_dependents": 2,
                    "financial_burden_score": 38, "dependency_ratio": 0.42
                }
            }
        },
        "_policy": {
            "product_name": "Child Education & Marriage Plan",
            "insurance_type": "CHILD_EDUCATION_MARRIAGE",
            "coverage_amount": 5_000_000, "term_years": 18,
            "dependent_name": "Ayaan Chaudhry", "dependent_dob": date(2019, 3, 12),
        }
    },

    # ── 10. Zara Siddiqi — Lecturer, Lahore, lowest risk, fresh graduate ───────
    {
        "cnic":            "35201-9912345-4",
        "first_name":      "Zara",
        "last_name":       "Siddiqi",
        "date_of_birth":   date(2002, 8, 25),
        "gender":          "Female",
        "marital_status":  "Single",
        "nationality":     "Pakistani",
        "occupation":      "University Lecturer",
        "declared_income": 840_000,
        "details": {
            "cnic_metadata": {
                "issue_date": "2020-08-30", "expiry_date": "2030-08-30",
                "is_valid": True, "validation_status": "Valid",
                "validated_at": "2024-06-01T09:00:00", "ocr_extracted": False,
                "front_image_url": "", "back_image_url": ""
            },
            "address": {
                "address_type": "Residential",
                "street_address": "House 4, Block Z, Valencia Town",
                "area": "Valencia Town", "city": "Lahore",
                "district": "Lahore", "province": "Punjab",
                "country": "Pakistan", "postal_code": "54770",
                "is_primary": True, "is_verified": True
            },
            "contact": {
                "mobile_number": "0307-4433210", "phone_number": "",
                "email": "zara.siddiqi@lums.edu.pk",
                "is_primary": True, "is_verified": True,
                "emergency_contact_name": "Iftikhar Siddiqi",
                "emergency_contact_phone": "0307-4433200",
                "emergency_contact_relation": "Father"
            },
            "occupation_details": {
                "job_title": "Visiting Lecturer — English Literature",
                "employer_name": "Lahore University of Management Sciences (LUMS)",
                "industry": "Education", "employment_type": "Salaried",
                "years_of_experience": 1, "occupation_hazard_level": "Low",
                "work_address": "LUMS, DHA Phase 5, Lahore",
                "is_current": True, "start_date": "2024-01-01", "end_date": ""
            },
            "income_record": {
                "monthly_income": 70000, "annual_income": 840000,
                "declared_income": 840000, "verified_income": 840000,
                "income_source": "Salary", "currency": "PKR",
                "income_stability_score": 82, "discrepancy_flag": False, "is_verified": True
            },
            "beneficiary": {
                "first_name": "Iftikhar", "last_name": "Siddiqi",
                "cnic_number": "35201-7712345-1", "date_of_birth": "1970-11-17",
                "relationship": "Parent", "share_percentage": 100,
                "phone": "0307-4433200", "email": "iftikhar.siddiqi@gmail.com",
                "address": "House 4, Block Z, Valencia Town, Lahore",
                "is_minor": False, "guardian_name": "", "guardian_cnic": "", "is_active": True
            },
            "medical_history": {
                "has_pre_existing_conditions": False, "is_smoker": False,
                "is_diabetic": False, "has_hypertension": False, "has_heart_disease": False,
                "surgical_history": "None",
                "notes": "Perfect health. No medications, no history of serious illness."
            },
            "conditions": [],
            "family_history": [
                {"relation": "Father", "age": "54", "is_alive": True, "condition_name": "None"},
                {"relation": "Mother", "age": "51", "is_alive": True, "condition_name": "Mild Arthritis"}
            ],
            "lifestyle": {
                "smoking_status": "NonSmoker", "packs_per_day": 0, "smoking_years": 0,
                "quit_smoking_date": "", "alcohol_status": "None", "units_per_week": 0,
                "height_cm": 161, "weight_kg": 53, "bmi": 20.5,
                "exercise_frequency": "Moderate", "diet_type": "Balanced",
                "has_hazardous_hobby": False, "hazardous_hobby_details": "",
                "occupation_hazard_level": "Low"
            },
            "financial_records": {
                "tax_records": [],
                "bank_statement": {
                    "bank_name": "Meezan Bank", "average_monthly_balance": 80000,
                    "transaction_volume": 14, "income_credits": 70000,
                    "expense_debits": 50000, "cash_flow_score": 78, "anomaly_flag": False
                },
                "debts": [],
                "credit_bureau": {
                    "credit_score": 620, "credit_history_length": 1,
                    "delinquency_count": 0, "default_history": False,
                    "inquiry_count": 0, "risk_grade": "B", "bureau_name": "ECIB"
                },
                "external_policies": [],
                "dependents": {
                    "dependent_type": "Parent", "number_of_dependents": 0,
                    "financial_burden_score": 5, "dependency_ratio": 0.05
                }
            }
        },
        "_policy": {
            "product_name": "Term Life", "insurance_type": "TERM_LIFE",
            "coverage_amount": 2_000_000, "term_years": 15,
            "dependent_name": None, "dependent_dob": None,
        }
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# Core seed function
# ─────────────────────────────────────────────────────────────────────────────

async def _publish_customer_created(producer: AIOKafkaProducer, tenant_id: UUID, customer: Customer) -> None:
    """Mirrors routers/customers.py::create_customer so seeded customers
    trigger the same background quote-generation job (see quote_worker.py in
    api-gateway) that a real POST /customers call does."""
    event = CustomerCreatedEvent(
        tenant_id=tenant_id,
        payload=CustomerCreatedPayload(
            customer_id=customer.id,
            cnic=customer.cnic,
            name=customer.name,
            dob=str(customer.dob),
            gender=customer.gender.value,
            occupation=customer.occupation,
            declared_income=customer.declared_income,
            is_smoker=customer.is_smoker,
            height_cm=customer.height_cm,
            weight_kg=customer.weight_kg,
        ),
    )
    try:
        await producer.send_and_wait(
            CUSTOMER_CREATED_TOPIC,
            value=event.model_dump_json(),
            key=str(tenant_id),
        )
    except Exception:
        logger.exception("Failed to publish CustomerCreated event | customer_id=%s", customer.id)


async def seed_customers(
    session: AsyncSession,
    tenant_id: UUID,
    producer: Optional[AIOKafkaProducer] = None,
) -> list[Customer]:
    """Insert 10 customers (+ one policy each) for a single tenant.

    Idempotent — skips any CNIC already registered for this tenant.
    Commits once at the end; returns the Customer rows actually created.

    When `producer` is given, publishes CustomerCreated to Kafka for each
    newly created customer — same background quote-generation trigger a real
    POST /tenants/{id}/customers call fires.
    """
    existing_result = await session.exec(
        select(Customer.cnic).where(Customer.tenant_id == tenant_id)
    )
    existing_cnics: set[str] = set(existing_result.all())

    # Ensure this tenant has its producer roster, then credit each newly-created
    # customer to a randomly-picked source so the seed data looks organic (a
    # spread of agents / brokers / banks) rather than everyone coming from one.
    sources = await get_or_seed_sources(session, tenant_id)

    # Fetch branches for this tenant to associate customers with branches
    branches_res = await session.exec(select(Branch).where(Branch.tenant_id == tenant_id))
    tenant_branches = list(branches_res.all())
    branch_map_by_city = {b.city.lower(): b for b in tenant_branches if b.city}

    # Backfill: credit any pre-existing customer that has no source yet (rows
    # seeded before this feature existed) to a random source, so "who brought
    # the customer" is populated across the board — not only newly-added rows.
    # Idempotent: once a customer has a source, it's never reassigned.
    if sources:
        unassigned = await session.exec(
            select(Customer).where(
                Customer.tenant_id == tenant_id,
                Customer.acquisition_source_id.is_(None),
            )
        )
        for existing in unassigned.all():
            existing.acquisition_source_id = random.choice(sources).id
            session.add(existing)

    created: list[Customer] = []

    for spec in CUSTOMER_SEED_DATA:
        policy_spec: dict = spec.pop("_policy")
        cnic: str = spec["cnic"]

        if cnic in existing_cnics:
            spec["_policy"] = policy_spec  # restore for repeated calls
            continue

        details = spec.get("details") or {}
        medical_history = details.get("medical_history") or {}
        lifestyle = details.get("lifestyle") or {}

        city_str = details.get("address", {}).get("city", "") or ""
        matched_branch = branch_map_by_city.get(city_str.lower()) if city_str else None
        if not matched_branch and tenant_branches:
            matched_branch = tenant_branches[len(created) % len(tenant_branches)]

        customer = Customer(
            tenant_id=tenant_id,
            cnic=cnic,
            name=f"{spec['first_name']} {spec['last_name']}".strip(),
            dob=spec["date_of_birth"],
            gender=spec["gender"],
            occupation=spec["occupation"],
            declared_income=spec["declared_income"],
            is_smoker=medical_history.get("is_smoker", False),
            height_cm=lifestyle.get("height_cm", 170),
            weight_kg=lifestyle.get("weight_kg", 70),
            details=details,
            acquisition_source_id=random.choice(sources).id if sources else None,
            branch_id=matched_branch.id if matched_branch else None,
            city=matched_branch.city if matched_branch else (city_str or None),
            province=matched_branch.region if matched_branch else None,
        )
        session.add(customer)
        await session.flush()  # obtain customer.id before linking the policy

        policy = Policy(
            tenant_id=tenant_id,
            customer_id=customer.id,
            product_name=policy_spec["product_name"],
            insurance_type=policy_spec["insurance_type"],
            coverage_amount=policy_spec["coverage_amount"],
            term_years=policy_spec["term_years"],
            dependent_name=policy_spec.get("dependent_name"),
            dependent_dob=policy_spec.get("dependent_dob"),
        )
        session.add(policy)
        created.append(customer)

        spec["_policy"] = policy_spec  # restore so list remains reusable

    await session.commit()
    for a in created:
        await session.refresh(a)

    if producer is not None:
        for a in created:
            await _publish_customer_created(producer, tenant_id, a)

    return created


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry-point  (mirrors insurance_plans_seed.py exactly)
# ─────────────────────────────────────────────────────────────────────────────

async def _run(tenant_id: UUID | None, all_tenants: bool) -> None:
    from database import _session_factory  # lazy import — avoids DB engine at module load

    kafka_bootstrap = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
    producer = AIOKafkaProducer(
        bootstrap_servers=kafka_bootstrap,
        value_serializer=lambda v: v.encode("utf-8"),
        key_serializer=lambda k: k.encode("utf-8") if k else None,
        acks="all",
        enable_idempotence=True,
    )
    await producer.start()

    try:
        async with _session_factory() as session:
            if all_tenants:
                tenants = list((await session.exec(select(Tenant))).all())
                if not tenants:
                    print("No tenants found — nothing to seed.")
                    return
            else:
                tenant = await session.get(Tenant, tenant_id)
                if tenant is None:
                    raise SystemExit(f"Tenant '{tenant_id}' not found.")
                tenants = [tenant]

            for tenant in tenants:
                created = await seed_customers(session, tenant.id, producer)
                skipped = len(CUSTOMER_SEED_DATA) - len(created)
                print(
                    f"[{tenant.name}] {tenant.id}: "
                    f"created {len(created)} customer(s) ({skipped} already present) "
                    f"— quote worker notified in the background"
                )
                for a in created:
                    print(f"  ✓ {a.name}")
    finally:
        await producer.stop()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed 10 realistic customer profiles (+ one policy each) for a tenant."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant-id",   type=UUID, help="UUID of the tenant to seed.")
    group.add_argument("--all-tenants", action="store_true", help="Seed every tenant in the database.")
    args = parser.parse_args()

    asyncio.run(_run(args.tenant_id, args.all_tenants))


if __name__ == "__main__":
    main()
