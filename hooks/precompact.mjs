#!/usr/bin/env node
// PreCompact hook — saves a session summary before context compaction
// Prevents knowledge loss when Claude Code compresses the conversation

import { readFile } from "node:fs/promises";
import { getWatermark, setWatermark } from "./watermark.mjs";

const MEM0_HOST = process.env.MEM0_HOST;
const MEM0_USER_ID = process.env.MEM0_USER_ID || "claude-code";

function extractText(entry) {
  if (entry.type === "user" && entry.message?.content) {
    const text =
      typeof entry.message.content === "string"
        ? entry.message.content
        : entry.message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(" ");
    return text.trim();
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

    const prompt = `Context is about to be compacted. Save the key facts from this session that should survive compaction:
- What was being worked on and current state
- Decisions made and their rationale
- Problems encountered and solutions found
- Files modified and why

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
