import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { syncImages } from "@/inngest/functions/sync-images";

/**
 * Inngest HTTP handler.
 * Vercel automatically wires this up at /api/inngest.
 * Inngest calls this endpoint to execute your functions.
 *
 * The `servePath` must match the actual route path so Inngest
 * can correctly discover and invoke these functions.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [syncImages],
  servePath: "/api/inngest",
});

