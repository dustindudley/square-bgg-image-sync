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
    const body = await req.json().catch(() => ({}));

    await inngest.send({
      name: "sync/images.requested",
      data: {
        force: body.force ?? false,
        filterName: body.filterName ?? undefined,
      },
    });

    return NextResponse.json({
      ok: true,
      message: "Sync job queued. Check the Inngest dashboard for progress.",
    });
  } catch (err: any) {
    console.error("Failed to trigger sync:", err);
    return NextResponse.json(
      { ok: false, error: err.message },
      { status: 500 }
    );
  }
}

