"""Customer acquisition availability shared by text, voice and tool execution."""

COMING_SOON_TOOLS = {
    "add_family_group": "Family",
    "prepare_family_insurance": "Family",
    "add_organization": "Corporate",
}

CUSTOMER_CREATION_POLICY = (
    "CUSTOMER CREATION AVAILABILITY: Family and corporate customer creation is coming soon. "
    "For requests to add/register/create a family, household, company, organization or corporate customer, "
    "including demo data or converting an individual to a new family, explain that the feature is coming soon "
    "and suggest creating an individual customer, which is available now. Do not collect family/company "
    "details, request an agent/source selection for that creation, offer creation forms or demo actions, "
    "or use other tools to bypass this restriction. Do not create an individual instead without the user's request. "
    "Existing family/corporate records can still be viewed and serviced within the user's permissions. "
    "Reply in the user's language, including Urdu when appropriate."
)


def coming_soon_result(tool_name: str) -> dict | None:
    category = COMING_SOON_TOOLS.get(tool_name)
    if not category:
        return None
    message = (
        f"{category} customer creation is coming soon. "
        "Individual customer creation is available now. Would you like to add an individual customer?"
    )
    return {
        "success": False,
        "error_code": "coming_soon",
        "retryable": False,
        "message": message,
        "error": message,
        "quick_actions": [{"label": "Add individual customer", "actionType": "submit",
                           "payload": "Add a new individual customer"}],
    }
