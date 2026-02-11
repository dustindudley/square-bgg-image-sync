import { NextResponse } from "next/server";

/**
 * GET /api/health
 *
 * Simple health check to verify the deployment is live.
 * Use this to confirm the Vercel app is reachable before
 * registering the Inngest URL.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    env: {
      hasSquareToken: !!process.env.SQUARE_ACCESS_TOKEN,
      hasInngestEventKey: !!process.env.INNGEST_EVENT_KEY,
      hasInngestSigningKey: !!process.env.INNGEST_SIGNING_KEY,
      squareEnvironment: process.env.SQUARE_ENVIRONMENT ?? "not set",
    },
  });
}

