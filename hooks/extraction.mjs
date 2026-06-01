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

If the conversation contains nothing durable, return an empty list.`;

const DEFAULT_LLM_MODEL = "gpt-5.4-mini";
const MAX_FACTS = 12;
const MAX_FACT_LEN = 500;

// Pull a {"facts":[...]} array out of a model response, tolerating stray prose
// or a bare top-level array.
function parseFacts(content) {
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
    .filter((f) => typeof f === "string")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => f.slice(0, MAX_FACT_LEN))
    .slice(0, MAX_FACTS);
}

// Client-side extraction. Returns an array of durable fact strings ([] if none).
// Throws on transport/HTTP failure so the caller can skip the watermark advance
// and retry on the next hook.
export async function distill(messages, { apiKey, model, baseUrl } = {}) {
  if (!baseUrl) throw new Error("MEM0_LLM_BASE not set");
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const res = await fetch(`${baseUrl}/chat/completions`, {
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
          content: `${EXTRACTION_PROMPT}\n\nReturn a JSON object of the form {"facts": ["fact one", "fact two"]}. Each fact is a single self-contained sentence. If nothing durable, return {"facts": []}.`,
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
export async function summarizeAndStore({ host, llmKey, messages, userId, metadata }) {
  // Preferred: client-side distill + verbatim store. Requires both a key and a
  // base URL (no LLM endpoint is hardcoded in this public repo); otherwise we
  // fall through to the server-side extractor below.
  if (llmKey && process.env.MEM0_LLM_BASE) {
    const facts = await distill(messages, {
      apiKey: llmKey,
      model: process.env.MEM0_LLM_MODEL,
      baseUrl: process.env.MEM0_LLM_BASE,
    });
    if (facts.length === 0) return { ok: true, stored: 0 }; // processed; nothing durable
    const res = await fetch(`${host}/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: facts.map((f) => ({ role: "user", content: f })),
        user_id: userId,
        infer: false,
        metadata,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`mem0 ${res.status}`);
    return { ok: true, stored: facts.length };
  }

  // Fallback: let mem0's extractor run, steered by the prompt field.
  const res = await fetch(`${host}/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      user_id: userId,
      prompt: EXTRACTION_PROMPT,
      metadata,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`mem0 ${res.status}`);
  return { ok: true, stored: null };
}
