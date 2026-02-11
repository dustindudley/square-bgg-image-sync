import { Inngest } from "inngest";

/**
 * Single Inngest client used across the app.
 * The id becomes the app name in the Inngest dashboard.
 */
export const inngest = new Inngest({ id: "square-bgg-image-sync" });

