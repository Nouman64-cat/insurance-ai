// Legacy discovery endpoint. Never return a long-lived provider credential.
export async function GET() {
  return Response.json({provider: 'openai', model: 'gpt-realtime-2.1-mini', sessionEndpoint: '/api/voice/session'},
    {headers: {'Cache-Control': 'no-store'}});
}
