import { z } from "zod";
import { tool } from "@langchain/core/tools";

export const navigateToPageTool = tool(
  async (args) => {
    return JSON.stringify({ success: true, message: `Navigating to ${args.page_name}` });
  },
  {
    name: "navigate_to_page",
    description: `Navigates the user to a specific section of the application. Use this tool IMMEDIATELY when the user says any navigation-related phrase.

NATURAL LANGUAGE TO PAGE MAPPINGS (use these EXACTLY):
- "leads", "customers", "people", "applicants", "clients" → "admin/customers"
- "cases", "applications", "underwriting cases" → "cases"
- "dashboard", "home", "main" → "dashboard"
- "artifacts", "documents" → "artifacts"
- "proposals", "quotations", "quotes" → "proposal"
- "live evaluation", "evaluate now" → "live-evaluation"
- "case summarizer", "summarize" → "case-summarizer"
- "assessments", "risk" → "assessments"
- "organizations", "corporate", "companies" → "admin/organizations"
- "users", "team", "staff", "agents" → "admin/users"
- "profile", "my profile", "account" → "profile"
- "tenants" → "super-admin/tenants"
- "underwriting" → "underwriting"

Always resolve the user's intent to the closest page path from the enum.`,
    schema: z.object({
      page_name: z.enum([
        "dashboard",
        "underwriting",
        "cases",
        "artifacts",
        "proposal",
        "live-evaluation",
        "case-summarizer",
        "assessments",
        "admin/customers",
        "admin/organizations",
        "super-admin/tenants",
        "super-admin/admins",
        "super-admin/branches",
        "super-admin/tokens",
        "admin/users",
        "profile"
      ]).describe("The exact page path. Map user intent using the descriptions above.")
    }),
  }
);

export const addCustomerTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); }, // Execution happens in the frontend or API router
  {
    name: "add_customer",
    description: "Adds a new customer or applicant to the system.",
    schema: z.object({
      first_name: z.string().describe("First name."),
      last_name: z.string().describe("Last name. If only one name is known, use it here too."),
      cnic: z.string().describe("Format: XXXXX-XXXXXXX-X. Intelligently format this from 13 digit input."),
      date_of_birth: z.string().describe("YYYY-MM-DD. Parse natural language or different formats into this automatically."),
      gender: z.enum(["Male", "Female", "Other"]).describe("Gender of the customer."),
      occupation: z.string().describe("Customer's occupation."),
      declared_income: z.number().describe("Convert shorthand like '50k' to 50000 automatically.")
    }),
  }
);

export const addUserTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "add_user",
    description: "Adds a new system user (e.g. admin, agent, underwriter) to the system.",
    schema: z.object({
      full_name: z.string().describe("The full name of the user to be added."),
      email: z.string().describe("The email address for the new user. If not provided, generate a sensible dummy email like firstname.lastname@example.com."),
      role_name: z.enum(["SuperAdmin", "Admin", "Underwriter", "Agent", "Viewer"]).describe("The role of the user. If not specified, default to Agent.")
    }),
  }
);

export const deleteCustomerTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "delete_customer",
    description: "Deletes a customer from the system.",
    schema: z.object({
      cnic: z.string().optional().describe("CNIC of the customer to delete."),
      name: z.string().optional().describe("Name of the customer to delete.")
    }),
  }
);

export const runRiskAssessmentTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "run_risk_assessment",
    description: "Runs the AI underwriting risk assessment for a specific case.",
    schema: z.object({
      applicant_name: z.string().optional().describe("Name of the applicant."),
      cnic: z.string().optional().describe("CNIC of the applicant. Prefer this if provided."),
      case_number: z.string().optional().describe("Case number.")
    }),
  }
);

export const getCaseDetailsTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "get_case_details",
    description: "Fetches the status and details of a specific case or applicant.",
    schema: z.object({
      applicant_name: z.string().optional().describe("Name of the applicant."),
      cnic: z.string().optional().describe("CNIC of the applicant."),
      case_number: z.string().optional().describe("Case number.")
    }),
  }
);

export const addOrganizationTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "add_organization",
    description: "Adds a new corporate or organization insurance group.",
    schema: z.object({
      name: z.string().describe("Name of the organization."),
      contact_person: z.string().optional().describe("Contact person name."),
      contact_email: z.string().optional().describe("Contact email."),
      contact_phone: z.string().optional().describe("Contact phone number.")
    }),
  }
);

export const addFamilyGroupTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "add_family_group",
    description: "Adds a new family insurance group. Optionally enrolls members into a floater policy simultaneously if members are provided. IMPORTANT: If the user asks for generic or test data, you MUST autonomously generate all the generic data for the members yourself without asking the user for clarification.",
    schema: z.object({
      name: z.string().describe("Name of the family group (e.g. Smith Family)."),
      contact_person: z.string().optional().describe("Contact person name."),
      contact_email: z.string().optional().describe("Contact email."),
      contact_phone: z.string().optional().describe("Contact phone number."),
      household_declared_income: z.number().optional().describe("Total household declared income."),
      members: z.array(z.object({
        cnic: z.string().describe("Format: XXXXX-XXXXXXX-X"),
        name: z.string().describe("Full name"),
        dob: z.string().describe("YYYY-MM-DD"),
        gender: z.enum(["Male", "Female", "Other"]),
        relationship: z.enum(["Self", "Spouse", "Child", "Parent"]).describe("Relationship to primary member. Exactly one member must be 'Self'."),
        occupation: z.string(),
        declared_income: z.number(),
        is_smoker: z.boolean().optional(),
        height_cm: z.number().optional(),
        weight_kg: z.number().optional()
      })).optional().describe("List of members to enroll. If generating generic data, invent reasonable details for 3-4 people and ensure EXACTLY ONE member has the relationship 'Self'.")
    }),
  }
);

export const bulkAddCustomersTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "bulk_add_customers",
    description: "Adds multiple individual insurance customers at once.",
    schema: z.object({
      customers_json: z.string().describe("A JSON stringified array of customer objects. Each object must have: first_name, last_name, cnic, date_of_birth, gender (Male/Female), occupation, declared_income (number), is_smoker (boolean), height_cm (number), weight_kg (number).")
    }),
  }
);

export const createCaseTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "create_case",
    description: "Creates an insurance application (case) for an existing customer so that underwriting and evaluation can proceed.",
    schema: z.object({
      applicant_name: z.string().optional().describe("The name of the applicant to create the case for."),
      cnic: z.string().optional().describe("CNIC of the applicant. Prefer this if provided."),
      case_type: z.enum(["Underwriting", "Claim", "Inquiry"]).optional().describe("Type of case. Default to Underwriting."),
      priority_level: z.enum(["Low", "Normal", "High", "Critical"]).optional().describe("Priority level. Default to Normal.")
    }),
  }
);

export const createProposalTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "create_proposal",
    description: "Creates an insurance proposal (quote/policy) for a customer. Used when a customer has no policy and needs one to proceed with an underwriting case or risk assessment.",
    schema: z.object({
      customer_id: z.string().optional().describe("The ID of the customer. Optional if cnic or applicant_name is provided."),
      cnic: z.string().optional().describe("CNIC of the customer. Prefer this if provided."),
      applicant_name: z.string().optional().describe("Name of the applicant."),
      product_name: z.string().optional().describe("Name of the insurance product (e.g., 'Term Life Plus'). Defaults to Term Life Plus."),
      insurance_type: z.enum(["Life", "Health", "Auto", "Property"]).optional().describe("Type of insurance. Defaults to Life."),
      coverage_amount: z.number().optional().describe("The total coverage or sum assured amount. Defaults to 5000000."),
      term_years: z.number().optional().describe("The term of the policy in years. Defaults to 10.")
    }),
  }
);

export const uploadDocumentTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "upload_document",
    description: "Uploads a document (artifact) to a customer's case. Use this when the user attaches a file and specifies what type of document it is (e.g. CNIC, Salary Slip, Medical Report).",
    schema: z.object({
      applicant_name: z.string().optional().describe("The name of the applicant the document belongs to."),
      cnic: z.string().optional().describe("CNIC of the applicant."),
      document_type: z.string().describe("The type of document being uploaded (e.g. CNIC, Salary Slip, Medical Report).")
    })
  }
);

export const ALL_TOOLS = [
  navigateToPageTool,
  addCustomerTool,
  addUserTool,
  deleteCustomerTool,
  runRiskAssessmentTool,
  getCaseDetailsTool,
  addOrganizationTool,
  addFamilyGroupTool,
  bulkAddCustomersTool,
  createCaseTool,
  createProposalTool,
  uploadDocumentTool
];
