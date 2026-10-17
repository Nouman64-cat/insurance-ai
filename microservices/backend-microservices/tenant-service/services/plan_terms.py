"""The policy wording, worked out from the plan attached to the policy.

Every policy gets a wording written from its own plan: eligibility, benefits, charges, surrender / withdrawal / loan terms
and the free-look period come from the plan's catalogue entry, and the process rules (grace, lapse, reinstatement,
claims) from the insurer's configuration. Nothing here is made up per policy: where the plan does not record a term, the
clause says the term is "as per the policy contract" instead of stating a number.

The wording summarises the key terms; the issued policy contract prevails if the two ever differ.
"""

from typing import Any, Dict, List, Tuple

from services import insurer_config as ic

_BENEFITS: Dict[str, str] = {
    "TERM_LIFE": "If the Life Assured dies during the policy term while the policy is in force, the Sum Assured is paid to the nominees. "
                 "There is no payment if the Life Assured survives the term.",
    "WHOLE_LIFE": "The Sum Assured is paid to the nominees on the death of the Life Assured, whenever it happens, while the policy is in force.",
    "ENDOWMENT": "If the Life Assured dies during the term, the death benefit is paid to the nominees. If the Life Assured survives to the end "
                 "of the term, the maturity benefit is paid to the Policyholder.",
    "SAVINGS": "The plan combines life cover with savings. A death benefit is paid to the nominees if the Life Assured dies during the term; "
               "on survival to maturity the maturity benefit (the value of the policy account) is paid to the Policyholder.",
    "SINGLE_PREMIUM": "One premium is paid at the start. The plan provides life cover for the term and a maturity benefit on survival to the end of the term.",
    "CHILD_EDUCATION_MARRIAGE": "The plan builds a fund for the child's education or marriage. A benefit is paid at the chosen milestone, and "
                                "the plan's death benefit protects the fund if the Policyholder dies during the term.",
    "HEALTH_CASH": "A cash benefit is paid for hospital confinement due to sickness or accident, as set out in the plan's benefit schedule.",
    "FAMILY_FLOATER": "One policy covers the family members named in the schedule under a shared limit, as set out in the plan's benefit schedule.",
    "GROUP_LIFE": "Each covered member is insured for the benefit set by their grade in the group schedule.",
}


def _surrender(terms: Dict[str, Any], profile: str, rules: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    if terms.get("has_surrender_value"):
        sched = []
        for row in terms.get("charge_schedule") or []:
            end = row.get("through")
            span = (f"year {row['from']}" if end == row["from"]
                    else f"year {row['from']} onward" if end is None else f"years {row['from']} to {end}")
            sched.append(f"{span}: {row.get('charge_pct')}%")
        out.append("The Policyholder may surrender the policy and receive the net surrender value. Surrender charge by policy year - "
                   + ("; ".join(sched) if sched else "as per the product specification") + ".")
        if terms.get("processing_fee_pkr") is not None:
            out.append(f"A processing fee of PKR {terms['processing_fee_pkr']:,.0f} applies to a surrender.")
        pw = terms.get("partial_withdrawal") or {}
        if pw:
            out.append(f"Partial withdrawal is allowed after {pw.get('minimum_inforce_months')} months in force: up to "
                       f"{pw.get('maximum_pct_of_net_cash_surrender_value')}% of the net cash value, at most {pw.get('maximum_per_year')} "
                       f"times a year, leaving at least PKR {(pw.get('minimum_remaining_net_cash_surrender_value_pkr') or 0):,.0f}.")
        loan = terms.get("loan") or {}
        if loan:
            out.append(f"A loan of up to {loan.get('maximum_pct_of_net_cash_surrender_value')}% of the net cash value may be available. "
                       f"{loan.get('eligibility_text') or ''}".strip())
        sv = terms.get("servicing") or {}
        if sv.get("required_documents"):
            out.append("To surrender, send: " + ", ".join(sv["required_documents"]) + ".")
    elif profile == "Savings":
        out.append(f"The policy may be surrendered after {rules['surrender_min_years']} completed policy years. The surrender value and any "
                   "charges are quoted when the request is made and depend on the policy contract.")
    else:
        out.append("This plan has no surrender value.")
    return out


def clauses(ctx: Dict[str, Any]) -> List[Tuple[str, List[str]]]:
    """(heading, paragraphs) for the wording of this policy's plan."""
    plan = ctx.get("plan") or {}
    ins_type = ctx.get("insurance_type") or plan.get("insurance_type") or ""
    profile = ic.EXIT_PROFILE_BY_TYPE.get(ins_type, "Protection")
    rules = ic.EXIT_DEFAULT_RULES
    terms = plan.get("surrender_terms") or {}
    product = ctx.get("product_name") or plan.get("label") or "this plan"
    out: List[Tuple[str, List[str]]] = []

    out.append(("1. Schedule summary", [
        f"Plan: {product}" + (f" ({plan['code']})" if plan.get("code") else "") + ".",
        f"Plan type: {ins_type or '-'}" + (f" · {plan['product_category']}" if plan.get("product_category") else "")
        + (f" · {plan['category']}" if plan.get("category") else "") + ".",
        f"Sum assured: PKR {ctx.get('coverage_amount') or 0:,.0f} · Policy term: {ctx.get('term_years')} years · "
        f"Premium frequency: {ctx.get('billing_frequency') or 'Annual'}.",
        f"Commencement: {ctx.get('effective_date') or 'on realisation of the first premium'} · Expiry: {ctx.get('expiry_date') or '-'}.",
    ]))

    out.append(("2. Definitions", [
        "Policyholder: the person who owns the policy. Life Assured: the person whose life is insured. Sum Assured: the amount shown in the "
        "schedule. Premium: the amount payable for the cover. Policy Year: each year from the commencement date. Nominee: the person the "
        "Policyholder names to receive the benefit. Grace Period: the time after a due date in which the premium may still be paid.",
    ]))

    elig = []
    if plan.get("entry_age_min") is not None:
        elig.append(f"Entry age ({plan.get('entry_age_label') or 'Proposer'}): {plan['entry_age_min']} to {plan['entry_age_max']} years.")
    if plan.get("term_min_years") is not None:
        elig.append(f"Policy term: {plan['term_min_years']} to {plan['term_max_years']} years. Maximum age at maturity: {plan.get('max_maturity_age')}.")
    if plan.get("max_income_multiple"):
        elig.append(f"Sum assured may not exceed {plan['max_income_multiple']:g} times the declared annual income.")
    if elig:
        out.append(("3. Eligibility under this plan", elig))

    benefits = [_BENEFITS.get(ins_type, "The benefits are as set out in the plan's benefit schedule.")]
    if plan.get("description"):
        benefits.append(str(plan["description"]))
    out.append(("4. Benefits", benefits))

    if plan.get("product_category") == "Takaful":
        out.append(("5. Takaful", [
            "This is a Takaful plan: contributions are managed under the Wakala model"
            + (f", with a Wakala fee of {plan['wakala_fee_pct']:g}%" if plan.get("wakala_fee_pct") is not None else "")
            + ". Surplus, if any, is shared as set out in the plan's Takaful rules.",
        ]))

    out.append(("6. Premiums, grace period and lapse", [
        ic.NOTICE_ACTIVATION_CLAUSE, ic.NOTICE_GRACE_LAPSE,
    ]))

    days = terms.get("free_look_days") or 14
    out.append(("7. Free-look (return of the policy)", [ic.NOTICE_FREE_LOOK.replace("14 days", f"{days} days")]))

    out.append(("8. Surrender, partial withdrawal and loan", _surrender(terms, profile, rules)))

    if profile == "Savings":
        out.append(("9. Maturity", [
            f"At the end of the term the maturity benefit is paid to the Policyholder. Maturing policies are identified "
            f"{rules['maturity_window_days']} days ahead and the Policyholder is written to before the maturity date.",
        ]))
    else:
        out.append(("9. End of the term", ["This is a protection plan: at the end of the term the cover ends and the policy closes with no maturity payment."]))

    rr = ic.reinstatement_rules(product)
    out.append(("10. Reinstatement", [
        f"A lapsed policy may be revived within {rr['window_days']} days of lapsing by paying the unpaid premiums and signing a Declaration of "
        f"Good Health. Within {rr['declaration_only_days']} days the declaration is normally enough; after {rr['medical_evidence_days']} days a "
        "medical examination may be required. Revival is subject to underwriting approval.",
    ]))

    bens = ctx.get("beneficiaries") or []
    out.append(("11. Nomination", [
        ("The benefit is payable to: " + "; ".join(f"{b['name']} ({b.get('relationship') or 'nominee'}, {b.get('share_pct')}%)" for b in bens) + ".")
        if bens else "No nominee is recorded. The benefit is payable to the Policyholder's legal heirs.",
    ]))

    uw = [ctx.get("loadings_text") or "Accepted at ordinary (standard) rates."]
    if ctx.get("exclusions"):
        uw.append("Additional exclusions on this policy: " + "; ".join(ctx["exclusions"]) + ".")
    out.append(("12. Underwriting terms", uw))

    out.append(("13. Exclusions", [
        f"No death benefit is paid for suicide within {ic.CLAIM_SUICIDE_EXCLUSION_DAYS} days of the commencement date.",
        ic.NOTICE_FRAUD,
    ]))

    out.append(("14. Claims", [
        "Tell us as soon as an event occurs, quoting the policy number, and send the claim form with the required documents. "
        f"We aim to decide within {ic.CLAIM_DECISION_SLA_WORKING_DAYS} working days of receiving complete documents.",
        ic.NOTICE_GRIEVANCE,
    ]))

    out.append(("15. About this document", [
        "This wording summarises the key terms of the plan attached to this policy. If anything here differs from the issued policy "
        "contract, the contract prevails.",
    ]))
    # Number the sections in order (the Takaful section is only present for Takaful plans).
    return [(f"{n}. {h.split('. ', 1)[1]}", [p for p in paras if p]) for n, (h, paras) in enumerate(out, 1)]
