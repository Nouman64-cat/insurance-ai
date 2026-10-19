"""Lead capture and plan selection without proposal or underwriting side effects."""
from datetime import date
import math
import re

from tool_executor import Ctx, _action, _current_user, handles, is_placeholder_cnic
from profile_risk_tools import _customer


def lead_result(customer):
    cid = str(customer['id'])
    return {'success': True, 'customer_id': cid, 'message': f"Lead **{customer.get('name') or cid}** recorded. Missing demographic facts can be added later.",
            'last_action': _action('record_lead', 'customer', cid, 'admin/leads', 'Lead recorded'),
            'quick_actions': [
                {'label': 'Assess lead risk', 'actionType': 'submit', 'payload': f'Run the demographic lead risk assessment for customer_id {cid}'},
                {'label': 'Compare plans', 'actionType': 'submit', 'payload': f'Compare insurance plans for customer_id {cid}'},
            ]}


@handles('record_lead')
async def record_lead(args: dict, ctx: Ctx):
    phone = str(args.get('phone') or '').strip()
    if not str(args.get('first_name') or '').strip() or not re.fullmatch(r'\+?[\d\s()\-]+', phone) or not 10 <= len(re.sub(r'\D', '', phone)) <= 15:
        return {'success': False, 'error_code': 'validation', 'message': "Provide the lead's actual name and a valid phone number."}
    if is_placeholder_cnic(args.get('cnic')):
        return {'success': False, 'error_code': 'validation', 'message': 'Provide the customer’s actual CNIC or leave it unrecorded. Placeholder CNICs are not accepted.'}
    if ctx.exec_ctx.role == 'Agent':
        actor = await _current_user(ctx)
    else:
        from tool_executor import _resolve_lead_agent
        actor, error = await _resolve_lead_agent(args, ctx)
        if error:
            return error
    contact = {'mobile_number': phone}
    if args.get('email'):
        contact['email'] = args['email']
    payload = {k: v for k, v in args.items() if k not in ('phone', 'email') and v is not None}
    payload.update(details={'contact': contact}, assigned_agent_id=actor['id'] if actor else None)
    response = await ctx.client.post(ctx.tsvc('/customers'), json=payload)
    response.raise_for_status()
    return lead_result(response.json())


@handles('select_customer_plan')
async def select_customer_plan(args: dict, ctx: Ctx):
    customer = await _customer(args, ctx, 'Select an insurance plan for')
    if 'success' in customer:
        return customer
    detail = await ctx.client.get(ctx.tsvc(f"/customers/{customer['id']}"))
    detail.raise_for_status()
    customer = detail.json()
    if customer.get('profile_status') in ('DRAFT', 'POLICYHOLDER'):
        return {'success': False, 'error_code': 'prerequisite_missing', 'message': 'This record has already left lead acquisition. Ask the responsible team to review its existing proposal or policy.'}
    try:
        dob = date.fromisoformat(str(customer.get('dob') or customer.get('date_of_birth'))[:10])
        today = date.today()
        if dob > today:
            raise ValueError()
        age = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
    except (ValueError, TypeError):
        return {'success': False, 'error_code': 'validation', 'message': "Record the customer's actual date of birth before comparing plans."}
    response = await ctx.client.get(ctx.tsvc('/insurance-plans'))
    response.raise_for_status()
    eligible = [p for p in response.json() if p.get('category') == 'Individual' and p.get('status') == 'Active'
                and int(p.get('entry_age_min', 0)) <= age <= int(p.get('entry_age_max', 0))
                and age + int(p.get('term_min_years', 0)) <= int(p.get('max_maturity_age', 120))]
    if not args.get('plan_id'):
        return {'success': True, 'customer_id': customer['id'], 'age': age, 'plans': eligible,
                'message': f"Found {len(eligible)} active individual plans within the recorded age limits. Discuss needs, income, coverage and term before choosing; this is not a final underwriting decision.",
                'quick_actions': [{'label': p['label'], 'actionType': 'submit',
                                   'payload': f"Select insurance plan {p['id']} for customer_id {customer['id']}"} for p in eligible[:8]]}
    plan = next((p for p in eligible if str(p['id']) == str(args['plan_id'])), None)
    if not plan:
        return {'success': False, 'error_code': 'validation', 'message': 'That plan is not active individual cover within this lead’s age limits. Compare the current catalogue and choose an available plan.'}
    if args.get('coverage_amount') is None or args.get('term_years') is None:
        return {'success': False, 'error_code': 'validation', 'message': 'What coverage amount and term has the customer chosen? No plan has been saved yet.'}
    cover, term = float(args['coverage_amount']), int(args['term_years'])
    if not math.isfinite(cover) or cover <= 0 or not int(plan['term_min_years']) <= term <= int(plan['term_max_years']) or age + term > int(plan['max_maturity_age']):
        return {'success': False, 'error_code': 'validation', 'message': 'The requested coverage or term is outside this plan’s age/term limits. Choose values within the live plan limits.'}
    if plan.get('max_income_multiple'):
        income = customer.get('declared_income')
        if not income or float(income) <= 0:
            return {'success': False, 'error_code': 'validation', 'message': 'Record the customer’s declared annual income to check the selected cover against this plan’s income limit.'}
        if cover > float(income) * float(plan['max_income_multiple']):
            return {'success': False, 'error_code': 'validation', 'message': 'The requested cover exceeds this plan’s configured income multiple. Choose a lower amount or correct the recorded income with the customer.'}
    pending = {'plan_id': plan['id'], 'product_name': plan['label'], 'insurance_type': plan['insurance_type'],
               'coverage_amount': cover, 'term_years': term}
    details = {**(customer.get('details') or {}), 'pending_plan': pending}
    response = await ctx.client.put(ctx.tsvc(f"/customers/{customer['id']}"), json={'details': details})
    response.raise_for_status()
    return {'success': True, 'customer_id': customer['id'], 'selected_plan': pending,
            'message': f"Selected **{plan['label']}** on the lead for PKR {cover:,.0f}, {term} years. No proposal or underwriting case was created.",
            'last_action': _action('select_customer_plan', 'customer', str(customer['id']), 'admin/leads', 'Lead plan selected'),
            'quick_actions': [{'label': 'Assess lead risk', 'actionType': 'submit', 'payload': f"Run the demographic lead risk assessment for customer_id {customer['id']}"}]}
