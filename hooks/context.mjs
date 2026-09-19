#!/usr/bin/env node
// SessionStart hook — injects mem0 memories as additional context

import { clientFromEnv } from "../lib/client.mjs";
import { projectAgentId } from "../lib/scope.mjs";

const MAX_MEMORIES = 20;

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
    const mem0 = clientFromEnv(process.env, { timeoutMs: 5000 });

    // Personal (user-scoped) queries plus one project-scoped query so memories
    // the hooks wrote for this repo (agent_id) surface even when their text
    // doesn't mention the project by name.
    const queries = [
      { query: `${projectName} architecture conventions setup` },
      { query: "recent decisions and session context" },
      { query: "user preferences and workflow patterns" },
      { query: "project conventions decisions gotchas", agentId: projectAgentId(input.cwd) },
    ];

    const seen = new Set();
    const memories = [];

    for (const q of queries) {
      let data;
      try {
        data = await mem0.search({ ...q, topK: 10 });
      } catch {
        continue;
      }
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
      .slice(0, MAX_MEMORIES)
      .map((m, i) => `${i + 1}. ${m.memory}`)
      .join("\n");

    const context = `# mem0 Cross-Session Memory\n\nThe following memories were retrieved from previous sessions:\n\n${lines}\n\nUse these for context. Do not repeat them back to the user unless asked.`;

    console.log(JSON.stringify({ additionalContext: context }));
  } catch {
    console.log(JSON.stringify({}));
  }
}

main();
