import { Inngest } from "inngest";

/**
 * Single Inngest client used across the app.
 * The id becomes the app name in the Inngest dashboard.
 *
 * Environment variables used by Inngest automatically:
 *   INNGEST_EVENT_KEY   – for sending events (set in Vercel env vars)
 *   INNGEST_SIGNING_KEY – for verifying incoming requests from Inngest
 *
 * The easiest way to set these is to install the official Inngest
 * integration from the Vercel Marketplace – it auto-configures both keys.
 */
export const inngest = new Inngest({ id: "square-bgg-image-sync" });

