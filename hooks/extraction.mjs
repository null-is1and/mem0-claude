// Shared extraction logic for the Stop / PreCompact hooks.
//
// Preferred path (when MEM0_LLM_KEY is set): distill the conversation into
// durable facts CLIENT-SIDE via LiteLLM, then store them verbatim in mem0 with
// `infer:false`. Our prompt is then the only instruction the model sees, so the
// EXCLUDE rules are obeyed reliably — unlike mem0's server-side extractor, which
// wraps our prompt in its own scaffolding and leaks ~25% narrative.
//
// Fallback path (no key or no MEM0_LLM_BASE): POST the real conversation as
// `messages` and steer mem0's own extractor via the `prompt` field. Weaker, but
// needs no credential — keeps hosts that haven't been redeployed working.
//
// No LLM endpoint is hardcoded here (this repo is public). The client-side path
// requires both MEM0_LLM_KEY and MEM0_LLM_BASE in the environment; without a
// base URL it falls back automatically.

import { createClient } from "../lib/client.mjs";

export const EXTRACTION_PROMPT = `You extract ONLY durable facts that a future engineer would need — things true beyond this session that are not obvious from code, git history, or config files.

INCLUDE:
- Architectural decisions and the reasoning behind them
- Infrastructure topology / endpoint / config-location changes
- Non-obvious gotchas or debugging lessons learned
- Durable user preferences for how they like to work

EXCLUDE entirely (never return these):
- Session narrative ("user asked", "assistant said", "quit and restarted", "asked a quick question")
- Procedural steps ("ran /compact", "committed", "pushed", "ran tests", "deleted entries")
- Transient state (counts, baselines, "76 entries", "returned 502", task progress)
- Tool/command output summaries and pleasantries

Tag each fact with exactly one category:
- project_knowledge: how a system/repo/infra is built or laid out
- decisions_and_constraints: choices made, and the reasons or limits behind them
- workflows: how the user likes work done; commands or procedures that work
- problems_and_fixes: gotchas, failure modes, and what fixed them
- results: durable outcomes of completed work (not progress)

If the conversation contains nothing durable, return an empty list.`;

export const CATEGORIES = [
  "project_knowledge",
  "decisions_and_constraints",
  "workflows",
  "problems_and_fixes",
  "results",
];
const DEFAULT_CATEGORY = CATEGORIES[0];


const DEFAULT_LLM_MODEL = "gpt-5.4-mini";
const MAX_FACTS = 12;
const MAX_FACT_LEN = 500;

// Pull a {"facts":[...]} array out of a model response, tolerating stray prose
// or a bare top-level array. Facts may be strings or {text, category} objects;
// the result is always [{text, category}] with an upstream category name.
export function parseFacts(content) {
  if (!content) return [];
  let obj;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return [];
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.facts) ? obj.facts : [];
  return arr
    .map((f) => {
      if (typeof f === "string") return { text: f, category: DEFAULT_CATEGORY };
      if (f && typeof f.text === "string") {
        const category = CATEGORIES.includes(f.category) ? f.category : DEFAULT_CATEGORY;
        return { text: f.text, category };
      }
      return null;
    })
    .filter((f) => f && f.text.trim())
    .map((f) => ({ text: f.text.trim().slice(0, MAX_FACT_LEN), category: f.category }))
    .slice(0, MAX_FACTS);
}

// { category: [text, ...] } preserving first-seen order.
export function groupByCategory(facts) {
  const groups = {};
  for (const f of facts) (groups[f.category] ??= []).push(f.text);
  return groups;
}

// Client-side extraction. Returns an array of durable fact strings ([] if none).
// Throws on transport/HTTP failure so the caller can skip the watermark advance
// and retry on the next hook.
export async function distill(messages, { apiKey, model, baseUrl, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new Error("MEM0_LLM_BASE not set");
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_LLM_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `${EXTRACTION_PROMPT}\n\nReturn a JSON object of the form {"facts": [{"text": "fact one", "category": "workflows"}]}. Each fact is a single self-contained sentence with one category from: ${CATEGORIES.join(", ")}. If nothing durable, return {"facts": []}.`,
        },
        { role: "user", content: `Conversation to distill:\n\n${transcript}` },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  return parseFacts(data?.choices?.[0]?.message?.content);
}

// Distill (or fall back) and write to mem0. Returns { ok, stored }.
// Throws only on a hard failure that should NOT advance the watermark.
//
// Every write carries user_id + agent_id (project) + run_id (session) and an
// optional expiration_date (see lib/scope.mjs). On the client-side path facts
// are grouped by category and written one add per category, so each memory's
// metadata.category is filterable on search.
export async function summarizeAndStore({
  host,
  apiKey = process.env.MEM0_API_KEY,
  llmKey,
  llmBase = process.env.MEM0_LLM_BASE,
  llmModel = process.env.MEM0_LLM_MODEL,
  fetch: fetchImpl = globalThis.fetch,
  messages,
  userId,
  agentId,
  runId,
  expirationDate,
  metadata,
}) {
  const mem0 = createClient({ host, userId, apiKey, fetch: fetchImpl, timeoutMs: 15000 });
  const scope = { agentId, runId, expirationDate };

  // Preferred: client-side distill + verbatim store. Requires both a key and a
  // base URL (no LLM endpoint is hardcoded in this public repo); otherwise we
  // fall through to the server-side extractor below.
  if (llmKey && llmBase) {
    const facts = await distill(messages, { apiKey: llmKey, model: llmModel, baseUrl: llmBase, fetch: fetchImpl });
    if (facts.length === 0) return { ok: true, stored: 0 }; // processed; nothing durable
    for (const [category, texts] of Object.entries(groupByCategory(facts))) {
      await mem0.add({
        messages: texts.map((t) => ({ role: "user", content: t })),
        ...scope,
        infer: false,
        metadata: { ...metadata, category },
      });
    }
    return { ok: true, stored: facts.length };
  }

  // Fallback: let mem0's extractor run, steered by the prompt field.
  await mem0.add({ messages, ...scope, prompt: EXTRACTION_PROMPT, metadata });
  return { ok: true, stored: null };
}
