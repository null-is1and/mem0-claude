// Minimal in-process stand-in for the mem0 REST server: records every request
// and answers with canned JSON so hooks and the MCP server can be exercised
// end-to-end over real HTTP.
import { createServer } from "node:http";

export async function startFakeMem0({ searchResults = [], llmFacts = null } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/search") return res.end(JSON.stringify({ results: searchResults }));
      // Doubles as an OpenAI-compatible extraction LLM when llmFacts is given.
      if (url.pathname === "/v1/chat/completions") {
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: llmFacts || [] }) } }] }));
      }
      if (url.pathname === "/entities") return res.end(JSON.stringify([{ id: "doug", type: "user" }]));
      res.end(JSON.stringify({ results: [], ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const host = `http://127.0.0.1:${server.address().port}`;
  return { host, requests, close: () => new Promise((r) => server.close(r)) };
}
