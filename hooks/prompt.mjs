#!/usr/bin/env node
// UserPromptSubmit hook — searches mem0 for context relevant to the user's message

const MEM0_HOST = process.env.MEM0_HOST;
const MEM0_USER_ID = process.env.MEM0_USER_ID || "claude-code";
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

  const userMessage =
    typeof input.user_message === "string"
      ? input.user_message
      : input.user_message?.content || "";

  if (userMessage.length < MIN_QUERY_LENGTH) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  if (/^\/(exit|clear|help|doctor|mcp|compact)/.test(userMessage.trim())) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  try {
    const res = await fetch(`${MEM0_HOST}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: userMessage.slice(0, 500),
        user_id: MEM0_USER_ID,
        top_k: MAX_RESULTS,
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    const data = await res.json();
    const relevant = (data.results || []).filter(
      (m) => (m.score || 0) >= MIN_SCORE
    );

    if (relevant.length === 0) {
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    const lines = relevant
      .map((m) => `- ${m.memory}`)
      .join("\n");

    const context = `[mem0 context] Relevant memories:\n${lines}`;

    console.log(JSON.stringify({ additionalContext: context }));
  } catch {
    console.log(JSON.stringify({}));
  }
}

main();
