#!/usr/bin/env node
// Stop hook — saves a focused session summary to mem0
// Extracts decisions, outcomes, and discoveries — filters conversational noise

import { readFile } from "node:fs/promises";
import { getWatermark, setWatermark } from "./watermark.mjs";

const MEM0_HOST = process.env.MEM0_HOST;
const MEM0_USER_ID = process.env.MEM0_USER_ID || "claude-code";
const MAX_MESSAGES = 20;
const MIN_MESSAGES = 3;

const NOISE_PATTERNS = [
  /^(ok|yes|no|sure|thanks|great|cool|nice|got it|sounds good|perfect)/i,
  /^(\/exit|\/clear|\/help|\/doctor|\/mcp)/,
  /^tool loaded/i,
  /^(let me|i'll|now let me|checking|looking)/i,
];

function isNoise(text) {
  const trimmed = text.trim();
  if (trimmed.length < 15) return true;
  return NOISE_PATTERNS.some((p) => p.test(trimmed));
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

    // Only summarize transcript lines not already covered by an earlier
    // summary this session (e.g. a prior PreCompact), so we don't duplicate.
    const prevLines = await getWatermark(input.session_id);
    const newLines = lines.slice(prevLines);

    const messages = [];
    for (const line of newLines) {
      try {
        const entry = JSON.parse(line);
        const text = extractText(entry);
        if (text && !isNoise(text)) {
          messages.push({
            role: entry.type === "user" ? "user" : "assistant",
            content: text.slice(0, 300),
          });
        }
      } catch {
        continue;
      }
    }

    if (messages.length < MIN_MESSAGES) process.exit(0);

    const selected = messages.slice(-MAX_MESSAGES);
    const projectName = (input.cwd || "").split("/").pop() || "unknown";

    const summary = selected.map((m) => `${m.role}: ${m.content}`).join("\n");

    const prompt = `Extract key facts, decisions, and outcomes from this session. Focus on:
- What was built, fixed, or configured
- Technical decisions made and why
- Problems encountered and how they were resolved
- User preferences or workflow patterns discovered

Ignore: conversational filler, assistant process narration, "user asked X" meta-commentary.

Project: ${projectName}
Session:
${summary}`;

    const res = await fetch(`${MEM0_HOST}/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        user_id: MEM0_USER_ID,
        metadata: {
          type: "session_summary",
          project: projectName,
          session_id: input.session_id,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    // Advance the watermark only on success, so a failed write is retried
    // (and re-covered) by the next hook rather than silently lost.
    if (res.ok) await setWatermark(input.session_id, lines.length);
  } catch {
    // Non-fatal
  }

  process.exit(0);
}

main();
