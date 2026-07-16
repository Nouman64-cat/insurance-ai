import { NextResponse } from 'next/server';

const SYSTEM_PROMPT = `Your name is Insurance AI Agent, a helpful, expert AI voice assistant for the "insurance-ai" platform — an AI-powered insurance underwriting system. Keep responses brief and conversational. Cover: Underwriting (risk scores, OCR, AI recommendations), Live Evaluation, Score Engine, Organizations, Fraud Detection, Claims. Expert in: premiums, sum assured, riders, BMI underwriting, reinsurance, Term/Whole/Endowment/Group Life. Be warm, concise, professional.

CRITICAL INSTRUCTION: You have access to system tools (functions) to perform real actions. You MUST use these tools when a user asks you to:
1. Navigate to a page (use navigate_to_page)
2. Add a new customer (use add_customer)
3. Delete a customer (use delete_customer)
4. Get details about a case or customer (use get_case_details)
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
      name: "add_customer",
      description: "Adds a new customer to the system.",
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
      name: "delete_customer",
      description: "Deletes a customer from the system.",
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

// Gemini function declarations are the OpenAI tool schema minus the `type`/
// `function` wrapper — reuse the same TOOLS definitions above so there's one
// source of truth for the assistant's capabilities.
const GEMINI_FUNCTION_DECLARATIONS = TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
}));

// Map our OpenAI-style chat history to Gemini's `contents` shape. Gemini only
// knows the "user" and "model" roles; anything that isn't an assistant turn is
// treated as user input.
function toGeminiContents(messages: Array<{ role: string; content: string }>) {
  return messages
    .filter((m) => m.role !== 'system' && typeof m.content === 'string' && m.content.length > 0)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Messages array is required' }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY is not configured' }, { status: 500 });
    }
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: toGeminiContents(messages),
          tools: [{ function_declarations: GEMINI_FUNCTION_DECLARATIONS }],
          tool_config: { function_calling_config: { mode: 'AUTO' } },
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Gemini API Error:', errorData);
      return NextResponse.json({ error: 'Failed to communicate with Gemini AI' }, { status: response.status });
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];

    // Flatten Gemini parts back into the OpenAI-compatible response the client
    // already expects: a text `message` plus optional `tool_calls`.
    let message = '';
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
    for (const part of parts) {
      if (part.text) message += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${toolCalls.length}_${part.functionCall.name}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      }
    }

    return NextResponse.json({
      message: message || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });

  } catch (error: any) {
    console.error('Chat API Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
