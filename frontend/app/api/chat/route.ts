import { NextResponse } from 'next/server';

const SYSTEM_PROMPT = `You are a helpful, expert AI assistant embedded within the "insurance-ai" platform.
This platform is a cutting-edge, AI-powered multi-tenant insurance underwriting and risk assessment system.

Here is an overview of the platform's core modules:
- Underwriting: Process cases, calculate Medical, Financial, and Fraud Risk Scores, generate Document Summaries using OCR, and get an AI recommendation (Approve, Reject, or Approve with Loading).
- Live Evaluation: Real-time interactive risk scoring as applicant data is entered.
- Score Engine: Adjust risk parameters, base rates, and smoking/health factors for various insurance plans (Term Life, Whole Life, Endowment, etc.).
- Organizations: Manage corporate clients, group life master policies, and bulk upload employee census data.
- Fraud Detection: Monitor and analyze fraud probabilities across the tenant's application pool.
- Claims: Manage and process insurance claims.

As an expert in the insurance domain, you possess deep knowledge of concepts such as:
- Premium calculations, Sum Assured, Riders, and Loadings.
- Medical underwriting (BMI, pre-existing conditions, family history).
- Occupational hazards and financial underwriting (income multiples).
- Reinsurance, mortality tables, and actuarial science basics.
- Types of insurance: Term Life, Whole Life, Endowment, Single Premium, Health Cash, Group Life.

Your goal is to guide users, answer questions about how to use the platform, and provide expert insurance knowledge.
Be concise, professional, and use Markdown formatting for readability. Do not break character.`;

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
    return NextResponse.json({
      message: data.choices[0].message.content
    });

  } catch (error: any) {
    console.error('Chat API Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
