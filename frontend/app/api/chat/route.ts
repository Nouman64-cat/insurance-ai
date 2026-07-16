import { NextResponse } from 'next/server';

const SYSTEM_PROMPT = `Your name is Sara, a helpful, expert AI voice assistant for the "insurance-ai" platform — an AI-powered insurance underwriting system. Keep responses brief and conversational. Cover: Underwriting (risk scores, OCR, AI recommendations), Live Evaluation, Score Engine, Organizations, Fraud Detection, Claims. Expert in: premiums, sum assured, riders, BMI underwriting, reinsurance, Term/Whole/Endowment/Group Life. Be warm, concise, professional.

CRITICAL INSTRUCTION: You have access to system tools (functions) to perform real actions. You MUST use these tools when a user asks you to:
1. Navigate to a page (use navigate_to_page)
2. Add a new applicant (use add_applicant)
3. Delete an applicant (use delete_applicant)
4. Get details about a case or applicant (use get_case_details)
5. Run an underwriting risk assessment (use run_risk_assessment)

DO NOT hallucinate or pretend to perform these actions. If you need more information to execute a tool (like a CNIC, Date of Birth, etc.), ask the user for it first, and once you have it, EXECUTE the tool call. Never just output text saying you updated it without calling the function!`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "navigate_to_page",
      description: "Navigates the user to a specific section of the application.",
      parameters: {
        type: "object",
        properties: {
          page_name: { 
            type: "string", 
            enum: [
              "dashboard", 
              "underwriting", 
              "cases", 
              "artifacts", 
              "quote", 
              "live-evaluation", 
              "case-summarizer", 
              "assessments", 
              "admin/applicants", 
              "admin/organizations",
              "super-admin/tenants",
              "super-admin/admins",
              "super-admin/branches",
              "super-admin/tokens",
              "admin/users",
              "profile"
            ],
            description: "The path of the page to navigate to (e.g. 'underwriting' for the Underwriting page, 'cases' for Cases, etc.)"
          }
        },
        required: ["page_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_applicant",
      description: "Adds a new applicant to the system.",
      parameters: {
        type: "object",
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          cnic: { type: "string", description: "Format: XXXXX-XXXXXXX-X" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          gender: { type: "string", enum: ["Male", "Female", "Other"] },
          occupation: { type: "string" },
          declared_income: { type: "number" }
        },
        required: ["first_name", "last_name", "cnic", "date_of_birth", "gender", "occupation", "declared_income"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_applicant",
      description: "Deletes an applicant from the system.",
      parameters: {
        type: "object",
        properties: {
          cnic: { type: "string" },
          name: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_risk_assessment",
      description: "Runs the AI underwriting risk assessment for a specific case.",
      parameters: {
        type: "object",
        properties: {
          applicant_name: { type: "string" },
          case_number: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_case_details",
      description: "Fetches the status and details of a specific case or applicant.",
      parameters: {
        type: "object",
        properties: {
          applicant_name: { type: "string" },
          case_number: { type: "string" }
        }
      }
    }
  }
];

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Messages array is required' }, { status: 400 });
    }

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return NextResponse.json({ error: 'GROQ_API_KEY is not configured' }, { status: 500 });
    }

    // Prepend the system prompt to the message history
    const payloadMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: payloadMessages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 1024,
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Groq API Error:', errorData);
      return NextResponse.json({ error: 'Failed to communicate with Groq AI' }, { status: response.status });
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message;
    
    return NextResponse.json({
      message: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls
    });

  } catch (error: any) {
    console.error('Chat API Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
