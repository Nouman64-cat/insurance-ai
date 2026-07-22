import { NextResponse } from 'next/server';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ALL_TOOLS } from "../../../lib/agent/tools";

const SYSTEM_PROMPT = `Your name is Insurance AI Agent, a helpful, expert AI voice assistant for the "insurance-ai" platform — an AI-powered insurance underwriting system. Keep responses brief and conversational. Cover: Underwriting (risk scores, OCR, AI recommendations), Live Evaluation, Score Engine, Organizations, Fraud Detection, Claims. Expert in: premiums, sum assured, riders, BMI underwriting, reinsurance, Term/Whole/Endowment/Group Life. Be warm, concise, professional.

CRITICAL INSTRUCTION: You have access to system tools (functions) to perform real actions. You MUST use these tools when a user asks you to.

DO NOT hallucinate or pretend to perform these actions. If you need more information to execute a tool, ask the user for it first, and once you have it, EXECUTE the tool call. Never just output text saying you updated it without calling the function!

IMPORTANT RULES FOR ADDING CUSTOMERS AND USERS:
- If the user asks to add a "user" (e.g. admin, agent, system user), use the 'add_user' tool.
- If the user asks to add an insurance "customer" or "applicant", use the 'add_customer' tool.
- If the user asks to add an "organization" or "corporate" insurance, use the 'add_organization' tool.
- If the user asks to add a "family" insurance, use the 'add_family_group' tool.
- If the user provides a list or table of multiple customers to add, use the 'bulk_add_customers' tool to add them all in a single action.
- If the user asks to generate "generic", "random", or "dummy" data for a customer or user, you MUST generate completely unique values each time (especially a random 13-digit CNIC like XXXXX-XXXXXXX-X with different numbers, or a random email) to avoid duplicate errors. Do not reuse the same generic CNIC or email from a previous request. Instead of asking for info, automatically generate the generic data and execute the tool.

BE HIGHLY INTELLIGENT AND FRIENDLY. Never complain about formatting or act confused about obvious inputs. You MUST automatically parse, normalize, and infer user inputs to match the required tool parameters without bothering the user. For example:
- Automatically format CNIC as XXXXX-XXXXXXX-X (e.g. 4567897654367 -> 45678-9765436-7).
- Automatically format dates as YYYY-MM-DD (e.g. '12 14 2004' -> 2004-12-14).
- Automatically convert shorthand values to numbers (e.g., '50kpkr', '50k' -> 50000).
- If only one name is provided (like "zia"), use it for both first_name and last_name or use a logical default so you don't block the user.
- If you ask the user to choose between multiple valid options (for example, due to a validation error like an invalid product name), you MUST append a quick actions block at the very end of your message. Format it exactly like this:
<quick_actions>
[Option 1]
[Option 2]
</quick_actions>
Each option must be on a new line and wrapped in square brackets. This will automatically render as clickable buttons for the user!
Act as an intelligent agent that actively helps the user.`;

function toLangchainMessages(messages: Array<any>, role: string) {
  let finalPrompt = SYSTEM_PROMPT;
  if (role && role !== "SuperAdmin" && role !== "Admin") {
    finalPrompt += `\n\nCRITICAL SECURITY INSTRUCTION: The current user's role is '${role}'. They are NOT an Admin. You are strictly FORBIDDEN from using any tools that create, edit, or delete data (e.g. add_customer, bulk_add_customers, add_organization, add_family_group, add_user, delete_customer). If the user asks you to perform these actions, politely refuse and state that they do not have sufficient permissions. You can only view or assess data.`;
  }

  const lcMessages: any[] = [new SystemMessage(finalPrompt)];

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'user') {
      lcMessages.push(new HumanMessage(m.content || ""));
    } else if (m.role === 'assistant') {
      let tool_calls: any[] = [];
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          let parsedArgs = {};
          try {
            parsedArgs = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : (tc.function.arguments || {});
          } catch (e) {
            console.error('Error parsing tool arguments:', e);
          }
          tool_calls.push({
            name: tc.function.name,
            args: parsedArgs,
            id: tc.id
          });
        }
      }
      lcMessages.push(new AIMessage({ content: m.content || "", tool_calls }));
    } else if (m.role === 'tool') {
      lcMessages.push(new ToolMessage({
        tool_call_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        name: m.name
      }));
    }
  }
  return lcMessages;
}

export async function POST(req: Request) {
  try {
    const { messages, role } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Messages array is required' }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY is not configured' }, { status: 500 });
    }
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    const llm = new ChatGoogleGenerativeAI({
      model,
      apiKey: geminiApiKey,
      temperature: 0.1,
      maxOutputTokens: 2048
    }).bindTools(ALL_TOOLS);

    const lcMessages = toLangchainMessages(messages, role);
    const response = await llm.invoke(lcMessages);

    let message = '';
    if (typeof response.content === "string") {
      message = response.content;
    } else if (Array.isArray(response.content)) {
      message = response.content.map(c => typeof c === 'string' ? c : c.text || '').join('');
    }

    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const tc of response.tool_calls) {
        toolCalls.push({
          id: tc.id || `call_${toolCalls.length}_${tc.name}`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {}),
          },
        });
      }
    }

    console.log("=== CHAT API RESPONSE ===");
    console.log("Message:", message);
    console.log("Tool Calls:", JSON.stringify(toolCalls));
    console.log("=========================");

    return NextResponse.json({
      message: message || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });

  } catch (error: any) {
    console.error('Chat API Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
