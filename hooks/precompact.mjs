#!/usr/bin/env node
// PreCompact hook — saves a session summary before context compaction
// Prevents knowledge loss when Claude Code compresses the conversation

import { readFile } from "node:fs/promises";
import { getWatermark, setWatermark } from "./watermark.mjs";

const MEM0_HOST = process.env.MEM0_HOST;
const MEM0_USER_ID = process.env.MEM0_USER_ID || "claude-code";

// Markers injected by the SessionStart/UserPromptSubmit hooks — if a message
// contains these, it's echoed mem0 context, not original conversation.
const ECHO_MARKERS = [
  "mem0 Cross-Session Memory",
  "memories were retrieved from previous sessions",
  "[mem0 context] Relevant memories",
];

function isEchoedContext(text) {
  return ECHO_MARKERS.some((m) => text.includes(m));
}

function extractText(entry) {
  if (entry.type === "user" && entry.message?.content) {
    const text =
      typeof entry.message.content === "string"
        ? entry.message.content
        : entry.message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(" ");
    const trimmed = text.trim();
    if (isEchoedContext(trimmed)) return null;
    return trimmed;
  }
  if (entry.type === "assistant" && entry.message?.content) {
    const text = entry.message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    return text.trim();
  }
  return null;
}

async function main() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  try {
    const raw = await readFile(transcriptPath, "utf-8");
    const lines = raw.trim().split("\n");

    // Only summarize transcript lines not already covered this session, so a
    // later Stop (or a second compaction) doesn't re-summarize the same tail.
    const prevLines = await getWatermark(input.session_id);
    const newLines = lines.slice(prevLines);

    const messages = [];
    for (const line of newLines) {
      try {
        const entry = JSON.parse(line);
        const text = extractText(entry);
        if (text && text.length > 20) {
          messages.push({
            role: entry.type === "user" ? "user" : "assistant",
            content: text.slice(0, 300),
          });
        }
      } catch {
        continue;
      }
    }

    if (messages.length < 5) process.exit(0);

    const selected = messages.slice(-30);
    const projectName = (input.cwd || "").split("/").pop() || "unknown";
    const summary = selected.map((m) => `${m.role}: ${m.content}`).join("\n");

    const prompt = `Context is about to be compacted. Extract ONLY durable facts that a future AI assistant would need — things true beyond this session that aren't obvious from code or git history.

INCLUDE:
- Architectural decisions and WHY they were made
- Infrastructure topology changes (new services, endpoints, config locations)
- Non-obvious gotchas or debugging lessons learned
- User preferences for how they like to work

EXCLUDE (do not extract):
- Session narrative ("user asked X", "assistant did Y")
- Procedural steps ("committed", "pushed", "ran tests", "deleted")
- Transient state (counts, errors, task progress)
- Facts derivable from code, git log, or config files

If there are NO durable facts worth saving, respond with exactly: NO_DURABLE_FACTS

Project: ${projectName}
Session so far:
${summary}`;

    const res = await fetch(`${MEM0_HOST}/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        user_id: MEM0_USER_ID,
        metadata: {
          type: "precompact_summary",
          project: projectName,
          session_id: input.session_id,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    // Advance the watermark only on success so the next hook covers the delta.
    if (res.ok) await setWatermark(input.session_id, lines.length);
  } catch {
    // Non-fatal
  }

  process.exit(0);
}

main();
