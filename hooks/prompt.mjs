#!/usr/bin/env node
// UserPromptSubmit hook — searches mem0 for context relevant to the user's message

import { clientFromEnv } from "../lib/client.mjs";

const MIN_QUERY_LENGTH = 20;
const MAX_RESULTS = 5;
const MIN_SCORE = 0.4;

async function main() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  // Claude Code sends the text as `prompt`; older builds used `user_message`.
  const raw = input.prompt ?? input.user_message;
  const userMessage = typeof raw === "string" ? raw : raw?.content || "";

  if (userMessage.length < MIN_QUERY_LENGTH) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  if (/^\/(exit|clear|help|doctor|mcp|compact)/.test(userMessage.trim())) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  try {
    const mem0 = clientFromEnv(process.env, { timeoutMs: 3000 });
    // The score floor is applied server-side via `threshold`.
    const data = await mem0.search({
      query: userMessage.slice(0, 500),
      topK: MAX_RESULTS,
      threshold: MIN_SCORE,
    });

    const relevant = data.results || [];
    if (relevant.length === 0) {
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    const lines = relevant.map((m) => `- ${m.memory}`).join("\n");
    const context = `[mem0 context] Relevant memories:\n${lines}`;

    console.log(JSON.stringify({ additionalContext: context }));
  } catch {
    console.log(JSON.stringify({}));
  }
}

main();
