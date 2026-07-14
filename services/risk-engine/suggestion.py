import os
from typing import Any, Dict, List
from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI

def _llm() -> ChatGoogleGenerativeAI:
    return ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        temperature=0.1,
        google_api_key=os.getenv("GEMINI_API_KEY"),
    )

class SuggestPlanOutput(BaseModel):
    suggested_plan_id: str = Field(description="The exact 'id' of the recommended insurance plan from the provided list.")
    suggested_coverage: int = Field(description="The recommended coverage amount in PKR.")
    suggested_term: int = Field(description="The recommended policy term in years.")
    reasoning: str = Field(description="A brief, professional explanation of why this plan, coverage, and term were selected, suitable for the admin UI.")

def suggest_plan(applicant: Dict[str, Any], plans: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not plans:
        raise ValueError("No plans provided for suggestion.")
        
    structured_llm = _llm().with_structured_output(SuggestPlanOutput)
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert life insurance advisor and underwriter.
You will be provided with an applicant's demographic, financial, and medical details, along with a list of available insurance plans.
Your task is to recommend the single best plan from the provided list.

Guidelines:
1. Income multiplier: Do not recommend a coverage amount that exceeds the plan's `max_income_multiple` times the applicant's declared annual income.
2. Term constraints: Ensure the term is between `term_min_years` and `term_max_years`.
3. Maturity Age: Ensure the applicant's current age + suggested term does not exceed `max_maturity_age`.
4. Life Stage: Factor in occupation, dependents, and marital status to choose between Term Life, Endowment, Savings, etc.
5. If you cannot find a perfect fit, select the most reasonable fallback plan and adjust the coverage and term to be compliant with its constraints.

Output your selection strictly adhering to the structured format."""),
        ("user", "Applicant Data: {applicant}\n\nAvailable Plans: {plans}")
    ])
    
    result = (prompt | structured_llm).invoke({
        "applicant": applicant,
        "plans": plans
    })
    
    return {
        "suggested_plan_id": result.suggested_plan_id,
        "suggested_coverage": result.suggested_coverage,
        "suggested_term": result.suggested_term,
        "reasoning": result.reasoning
    }
