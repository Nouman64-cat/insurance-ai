const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { SystemMessage, HumanMessage } = require("@langchain/core/messages");
const { tool } = require("@langchain/core/tools");
const z = require("zod");

const runRiskAssessmentTool = tool(
  async (args) => { return JSON.stringify({ success: true, dummy: true }); },
  {
    name: "run_risk_assessment",
    description: "Evaluates the risk profile of an underwriting case and generates an AI decision.",
    schema: z.object({
      applicant_name: z.string().optional().describe("The name of the applicant. Provide this if available."),
      cnic: z.string().optional().describe("CNIC of the applicant. Prefer this if provided."),
      case_number: z.string().optional().describe("The unique case number, e.g., CASE-YYYY-XXXXXX.")
    }),
  }
);

async function run() {
  const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.1,
    maxOutputTokens: 2048
  }).bindTools([runRiskAssessmentTool]);
  
  const res = await llm.invoke([
    new SystemMessage("You are a helpful assistant."),
    new HumanMessage("Evaluate risk profile 12323-4232479-6")
  ]);
  
  console.log("RESPONSE CONTENT:", res.content);
  console.log("TOOL CALLS:", JSON.stringify(res.tool_calls, null, 2));
}

run();
