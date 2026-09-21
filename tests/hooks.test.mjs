import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeMem0 } from "./helpers/fake-mem0.mjs";

const HOOKS = resolve(import.meta.dirname, "../hooks");

function runHook(file, input, env) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [join(HOOKS, file)], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => done({ code, out: out.trim() ? JSON.parse(out) : {} }));
    p.stdin.end(JSON.stringify(input));
  });
}

async function withMem0(opts, fn) {
  const mem0 = await startFakeMem0(opts);
  const stateDir = await mkdtemp(join(tmpdir(), "mem0-state-"));
  try {
    return await fn(mem0, {
      MEM0_HOST: mem0.host, MEM0_USER_ID: "doug", MEM0_API_KEY: "k-hook",
      MEM0_LLM_KEY: "", MEM0_LLM_BASE: "", MEM0_STATE_DIR: stateDir,
    });
  } finally {
    await mem0.close();
  }
}

test("context hook searches with identity in filters, includes a project-scoped query, and sends the api key", () =>
  withMem0({ searchResults: [{ id: "1", memory: "remembered thing", score: 0.9 }] }, async (mem0, env) => {
    const { out } = await runHook("context.mjs", { source: "startup", cwd: "/x/my-proj" }, env);
    assert.match(out.additionalContext, /remembered thing/);
    const searches = mem0.requests.filter((r) => r.path === "/search");
    assert.ok(searches.length >= 3);
    for (const s of searches) {
      assert.equal(s.body.user_id, undefined, "top-level user_id is deprecated");
      assert.equal(s.body.filters.user_id, "doug");
      assert.equal(s.headers["x-api-key"], "k-hook");
    }
    assert.ok(searches.some((s) => s.body.filters.agent_id === "project:my-proj"), "one query is project-scoped");
  }));

test("context hook does nothing for non-startup sources", () =>
  withMem0({}, async (mem0, env) => {
    const { out } = await runHook("context.mjs", { source: "resume", cwd: "/x/p" }, env);
    assert.deepEqual(out, {});
    assert.equal(mem0.requests.length, 0);
  }));

test("prompt hook reads the `prompt` field, filters via filters, and applies the score threshold server-side", () =>
  withMem0({ searchResults: [{ id: "1", memory: "relevant memory", score: 0.8 }] }, async (mem0, env) => {
    const { out } = await runHook("prompt.mjs", { prompt: "how is the mem0 server deployed on ceto?", cwd: "/x/p" }, env);
    assert.match(out.additionalContext, /relevant memory/);
    const s = mem0.requests[0];
    assert.equal(s.path, "/search");
    assert.deepEqual(s.body, { query: "how is the mem0 server deployed on ceto?", filters: { user_id: "doug" }, top_k: 5, threshold: 0.4 });
  }));

test("prompt hook still accepts the legacy user_message field", () =>
  withMem0({ searchResults: [{ id: "1", memory: "m", score: 0.8 }] }, async (mem0, env) => {
    const { out } = await runHook("prompt.mjs", { user_message: "a sufficiently long legacy message here" }, env);
    assert.match(out.additionalContext, /m/);
  }));

test("prompt hook skips short prompts and slash commands", () =>
  withMem0({}, async (mem0, env) => {
    assert.deepEqual((await runHook("prompt.mjs", { prompt: "short" }, env)).out, {});
    assert.deepEqual((await runHook("prompt.mjs", { prompt: "/compact please do it now thanks" }, env)).out, {});
    assert.equal(mem0.requests.length, 0);
  }));

async function transcript(lines) {
  const dir = await mkdtemp(join(tmpdir(), "mem0-hook-"));
  const path = join(dir, "t.jsonl");
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}
const user = (t) => ({ type: "user", message: { content: t } });
const asst = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const conversation = [
  user("Please migrate the mem0 server image to the new pgvector base image"),
  asst("Done: the stack now uses pgvector/pgvector:pg17 and POSTGRES_PASSWORD is required"),
  user("Also remember that /configure corrupts the memory singleton on this build"),
  asst("Noted, I will avoid POST /configure and use env vars instead"),
  user("Great, now update the README with the migration steps for existing installs"),
  asst("README updated with the pg_dumpall export and restore ordering"),
];

for (const [file, type] of [["stop.mjs", "session_summary"], ["precompact.mjs", "precompact_summary"]]) {
  test(`${file} writes with project agent_id, session run_id, expiry and the api key`, () =>
    withMem0({}, async (mem0, env) => {
      const session_id = `sess-${file}`;
      await runHook(file, { transcript_path: await transcript(conversation), session_id, cwd: "/x/my-proj" },
        { ...env, MEM0_SUMMARY_TTL_DAYS: "45" });
      const add = mem0.requests.find((r) => r.method === "POST" && r.path === "/memories");
      assert.ok(add, "a memory was written");
      assert.equal(add.headers["x-api-key"], "k-hook");
      assert.equal(add.body.user_id, "doug");
      assert.equal(add.body.agent_id, "project:my-proj");
      assert.equal(add.body.run_id, session_id);
      assert.match(add.body.expiration_date, /^\d{4}-\d{2}-\d{2}$/);
      const expected = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
      assert.equal(add.body.expiration_date, expected);
      assert.equal(add.body.metadata.type, type);
      assert.equal(add.body.metadata.project, "my-proj");
      assert.equal(add.body.metadata.session_id, session_id);
      assert.equal(typeof add.body.prompt, "string");
    }));

  test(`${file} omits expiration when MEM0_SUMMARY_TTL_DAYS=0`, () =>
    withMem0({}, async (mem0, env) => {
      await runHook(file, { transcript_path: await transcript(conversation), session_id: `s0-${file}`, cwd: "/x/p" },
        { ...env, MEM0_SUMMARY_TTL_DAYS: "0" });
      const add = mem0.requests.find((r) => r.method === "POST" && r.path === "/memories");
      assert.ok(add);
      assert.equal("expiration_date" in add.body, false);
    }));
}

test("stop hook uses client-side extraction when the key arrives as LITELLM_API_KEY (claude-config's name)", () =>
  withMem0({ llmFacts: [{ text: "coeus runs the sync timer", category: "project_knowledge" }] }, async (mem0, env) => {
    await runHook("stop.mjs", { transcript_path: await transcript(conversation), session_id: "sess-alias", cwd: "/x/p" },
      { ...env, MEM0_LLM_KEY: "", LITELLM_API_KEY: "lk-1", MEM0_LLM_BASE: `${mem0.host}/v1` });
    const llm = mem0.requests.find((r) => r.path === "/v1/chat/completions");
    assert.ok(llm, "extraction LLM was called");
    assert.equal(llm.headers.authorization, "Bearer lk-1");
    const add = mem0.requests.find((r) => r.method === "POST" && r.path === "/memories");
    assert.equal(add.body.infer, false);
    assert.equal(add.body.metadata.category, "project_knowledge");
  }));

test("MEM0_LLM_KEY still wins over LITELLM_API_KEY when both are set", () =>
  withMem0({ llmFacts: [{ text: "f", category: "results" }] }, async (mem0, env) => {
    await runHook("precompact.mjs", { transcript_path: await transcript(conversation), session_id: "sess-both", cwd: "/x/p" },
      { ...env, MEM0_LLM_KEY: "mk-2", LITELLM_API_KEY: "lk-1", MEM0_LLM_BASE: `${mem0.host}/v1` });
    const llm = mem0.requests.find((r) => r.path === "/v1/chat/completions");
    assert.equal(llm.headers.authorization, "Bearer mk-2");
  }));
