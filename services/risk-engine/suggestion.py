from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate

import usage
from llm import structured_llm

class SuggestPlanOutput(BaseModel):
    suggested_plan_id: str = Field(description="The exact 'id' of the recommended insurance plan from the provided list.")
    suggested_coverage: int = Field(description="The recommended coverage amount in PKR.")
    suggested_term: int = Field(description="The recommended policy term in years.")
    reasoning: str = Field(description="A brief, professional explanation of why this plan, coverage, and term were selected, suitable for the admin UI.")

def suggest_plan(customer: Dict[str, Any], plans: List[Dict[str, Any]], tenant_id: Optional[str] = None) -> Dict[str, Any]:
    if not plans:
        raise ValueError("No plans provided for suggestion.")
        
    model = structured_llm(SuggestPlanOutput)

    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert life insurance advisor and underwriter.
You will be provided with an customer's demographic, financial, and medical details, along with a list of available insurance plans.
Your task is to recommend the single best plan from the provided list.

Guidelines:
1. Income multiplier: Do not recommend a coverage amount that exceeds the plan's `max_income_multiple` times the customer's declared annual income.
2. Term constraints: Ensure the term is between `term_min_years` and `term_max_years`.
3. Maturity Age: Ensure the customer's current age + suggested term does not exceed `max_maturity_age`.
4. Life Stage: Factor in occupation, dependents, and marital status to choose between Term Life, Endowment, Savings, etc.
5. If you cannot find a perfect fit, select the most reasonable fallback plan and adjust the coverage and term to be compliant with its constraints.

Output your selection strictly adhering to the structured format."""),
        ("user", "Customer Data: {customer}\n\nAvailable Plans: {plans}")
    ])
    
    raw = (prompt | model).invoke({
        "customer": customer,
        "plans": plans
    })
    usage.record(raw["raw"], tenant_id=tenant_id)
    result = raw["parsed"]

    return {
        "suggested_plan_id": result.suggested_plan_id,
        "suggested_coverage": result.suggested_coverage,
        "suggested_term": result.suggested_term,
        "reasoning": result.reasoning
    }
