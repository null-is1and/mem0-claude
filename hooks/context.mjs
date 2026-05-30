#!/usr/bin/env node
// SessionStart hook — injects mem0 memories as additional context

const MEM0_HOST = process.env.MEM0_HOST;
const MEM0_USER_ID = process.env.MEM0_USER_ID || "claude-code";

async function main() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  if (input.source !== "startup" && input.source !== "compact") {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const projectName = (input.cwd || "").split("/").pop() || "project";

  try {
    const queries = [
      `${projectName} architecture conventions setup`,
      "recent decisions and session context",
      "user preferences and workflow patterns",
    ];

    const seen = new Set();
    const memories = [];

    for (const query of queries) {
      const res = await fetch(`${MEM0_HOST}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, user_id: MEM0_USER_ID, top_k: 10 }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) continue;

      const data = await res.json();
      for (const m of data.results || []) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          memories.push(m);
        }
      }
    }

    if (memories.length === 0) {
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    memories.sort((a, b) => (b.score || 0) - (a.score || 0));

    const lines = memories
      .slice(0, 20)
      .map((m, i) => `${i + 1}. ${m.memory}`)
      .join("\n");

    const context = `# mem0 Cross-Session Memory\n\nThe following memories were retrieved from previous sessions:\n\n${lines}\n\nUse these for context. Do not repeat them back to the user unless asked.`;

    console.log(JSON.stringify({ additionalContext: context }));
  } catch {
    console.log(JSON.stringify({}));
  }
}

main();
