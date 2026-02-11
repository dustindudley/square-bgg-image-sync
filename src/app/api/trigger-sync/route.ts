import { NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

/**
 * POST /api/trigger-sync
 *
 * Manually trigger the BGG → Square image sync.
 * Body (optional JSON):
 *   { "force": true, "filterName": "Catan" }
 */
export async function POST(req: Request) {
  try {
    // Verify event key is present before attempting to send
    if (!process.env.INNGEST_EVENT_KEY) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "INNGEST_EVENT_KEY is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.",
        },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));

    const sendResult = await inngest.send({
      name: "sync/images.requested",
      data: {
        force: body.force ?? false,
        filterName: body.filterName ?? undefined,
      },
    });

    console.log("Inngest send result:", JSON.stringify(sendResult));

    return NextResponse.json({
      ok: true,
      message:
        "Event sent to Inngest successfully. If no function run appears in your Inngest dashboard, make sure you have synced the app URL (see instructions below).",
      sendResult,
    });
  } catch (err: any) {
    console.error("Failed to trigger sync:", err);
    return NextResponse.json(
      {
        ok: false,
        error: `Failed to send event to Inngest: ${err.message}`,
        hint: "Check that INNGEST_EVENT_KEY is correct and your app is synced in the Inngest dashboard.",
      },
      { status: 500 }
    );
  }
}

