"use client";

import { useState } from "react";

type SyncStatus = "idle" | "triggering" | "triggered" | "error";

export default function Home() {
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState("");
  const [force, setForce] = useState(false);
  const [filterName, setFilterName] = useState("");

  async function handleSync() {
    setStatus("triggering");
    setMessage("");

    try {
      const res = await fetch("/api/trigger-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force,
          filterName: filterName.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (data.ok) {
        setStatus("triggered");
        setMessage(data.message);
      } else {
        setStatus("error");
        setMessage(
          data.error + (data.hint ? `\n\n💡 ${data.hint}` : "")
        );
      }
    } catch (err: any) {
      setStatus("error");
      setMessage(err.message);
    }
  }

  return (
    <main
      style={{
        maxWidth: 600,
        margin: "0 auto",
        padding: "4rem 1.5rem",
      }}
    >
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "3rem" }}>
        <h1
          style={{
            fontSize: "2rem",
            fontWeight: 700,
            marginBottom: "0.5rem",
            background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          Square ↔ BGG Image Sync
        </h1>
        <p style={{ color: "#94a3b8", fontSize: "0.95rem" }}>
          Import board game images from BoardGameGeek into your Square catalog.
        </p>
      </div>

      {/* Controls */}
      <div
        style={{
          background: "#1e293b",
          borderRadius: 12,
          padding: "2rem",
          border: "1px solid #334155",
        }}
      >
        {/* Filter */}
        <label
          style={{
            display: "block",
            marginBottom: "1.5rem",
          }}
        >
          <span
            style={{
              display: "block",
              fontSize: "0.85rem",
              color: "#94a3b8",
              marginBottom: 6,
            }}
          >
            Filter by name (optional)
          </span>
          <input
            type="text"
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
            placeholder='e.g. "Catan"'
            style={{
              width: "100%",
              padding: "0.65rem 0.85rem",
              borderRadius: 8,
              border: "1px solid #475569",
              background: "#0f172a",
              color: "#e2e8f0",
              fontSize: "0.95rem",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </label>

        {/* Force checkbox */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: "2rem",
            cursor: "pointer",
            fontSize: "0.9rem",
            color: "#cbd5e1",
          }}
        >
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            style={{ accentColor: "#3b82f6" }}
          />
          Re-sync items that already have images
        </label>

        {/* Sync button */}
        <button
          onClick={handleSync}
          disabled={status === "triggering"}
          style={{
            width: "100%",
            padding: "0.85rem",
            borderRadius: 8,
            border: "none",
            background:
              status === "triggering"
                ? "#475569"
                : "linear-gradient(135deg, #3b82f6, #8b5cf6)",
            color: "#fff",
            fontWeight: 600,
            fontSize: "1rem",
            cursor: status === "triggering" ? "wait" : "pointer",
            transition: "opacity 0.2s",
          }}
        >
          {status === "triggering" ? "Queuing…" : "Start Image Sync"}
        </button>

        {/* Status message */}
        {message && (
          <div
            style={{
              marginTop: "1.25rem",
              padding: "0.85rem 1rem",
              borderRadius: 8,
              background:
                status === "error" ? "#7f1d1d33" : "#14532d33",
              border: `1px solid ${status === "error" ? "#991b1b" : "#166534"}`,
              color: status === "error" ? "#fca5a5" : "#86efac",
              fontSize: "0.9rem",
            }}
          >
            {message}
          </div>
        )}
      </div>

      {/* Info */}
      <div
        style={{
          marginTop: "2.5rem",
          padding: "1.5rem",
          background: "#1e293b",
          borderRadius: 12,
          border: "1px solid #334155",
          fontSize: "0.85rem",
          color: "#94a3b8",
          lineHeight: 1.7,
        }}
      >
        <h3
          style={{
            margin: "0 0 0.75rem",
            color: "#e2e8f0",
            fontSize: "0.95rem",
          }}
        >
          How it works
        </h3>
        <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
          <li>
            Fetches all items from your Square catalog (excluding Drinks &amp;
            Shirts categories).
          </li>
          <li>
            Searches <strong>BoardGameGeek</strong> for each item by name (or
            UPC if available).
          </li>
          <li>
            Verifies the match using year &amp; publisher when metadata is
            present.
          </li>
          <li>
            Downloads the high-res image from BGG and uploads it to Square via{" "}
            <code>CreateCatalogImage</code>.
          </li>
        </ol>
        <p style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          The sync runs as a background job via{" "}
          <strong>Inngest</strong>, so it won&apos;t time out—even for large
          catalogs. Monitor progress in your{" "}
          <a
            href="https://app.inngest.com"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#60a5fa" }}
          >
            Inngest dashboard
          </a>
          .
        </p>
        <hr style={{ border: "none", borderTop: "1px solid #334155", margin: "1rem 0" }} />
        <h3
          style={{
            margin: "0 0 0.75rem",
            color: "#e2e8f0",
            fontSize: "0.95rem",
          }}
        >
          ⚠️ First-time setup: Sync your app with Inngest
        </h3>
        <p style={{ margin: "0 0 0.5rem" }}>
          Before the sync button works, Inngest must discover your functions.
          Do <strong>one</strong> of the following:
        </p>
        <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
          <li>
            <strong>Recommended:</strong> Install the{" "}
            <a
              href="https://vercel.com/integrations/inngest"
              target="_blank"
              rel="noreferrer"
              style={{ color: "#60a5fa" }}
            >
              Inngest Vercel Integration
            </a>{" "}
            — it auto-syncs on every deploy.
          </li>
          <li>
            <strong>Manual:</strong> In{" "}
            <a
              href="https://app.inngest.com"
              target="_blank"
              rel="noreferrer"
              style={{ color: "#60a5fa" }}
            >
              app.inngest.com
            </a>
            {" → Apps → Sync New App"}, enter your URL:{" "}
            <code style={{ color: "#60a5fa" }}>
              https://YOUR-APP.vercel.app/api/inngest
            </code>
          </li>
        </ul>
      </div>
    </main>
  );
}

