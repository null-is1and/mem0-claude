// Thin client for the self-hosted mem0 REST server, shared by the MCP server
// and the session hooks. Mirrors the current upstream server/main.py surface:
//   POST /search        filters / top_k / threshold / explain / show_expired
//   POST /memories      user_id / agent_id / run_id / metadata / expiration_date / infer / memory_type / prompt
//   GET  /memories      user_id / agent_id / run_id / top_k / show_expired
//   PUT  /memories/:id  text / metadata / expiration_date
//   GET  /entities, DELETE /entities/:type/:id
// Identity always goes inside `filters` on /search; the top-level form is
// deprecated upstream and logs a warning per call.

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function createClient({ host, userId, apiKey, fetch: fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  if (!host) throw new Error("mem0 client: host is required");
  const base = host.replace(/\/+$/, "");

  async function request(path, { method = "GET", body, query } = {}) {
    let url = `${base}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(compact(query))) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;
    const options = { method, headers };
    if (body !== undefined) options.body = JSON.stringify(body);
    if (timeoutMs) options.signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(url, options);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`mem0 API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  const scope = ({ userId: u, agentId, runId }) =>
    compact({ user_id: u ?? userId, agent_id: agentId, run_id: runId });

  return {
    search({ query, userId: u, agentId, runId, filters, topK, threshold, explain, showExpired }) {
      return request("/search", {
        method: "POST",
        body: compact({
          query,
          filters: { ...scope({ userId: u, agentId, runId }), ...(filters || {}) },
          top_k: topK,
          threshold,
          explain,
          show_expired: showExpired,
        }),
      });
    },

    add({ messages, userId: u, agentId, runId, metadata, expirationDate, infer, memoryType, prompt }) {
      return request("/memories", {
        method: "POST",
        body: compact({
          messages,
          ...scope({ userId: u, agentId, runId }),
          metadata,
          expiration_date: expirationDate,
          infer,
          memory_type: memoryType,
          prompt,
        }),
      });
    },

    list({ userId: u, agentId, runId, topK, showExpired } = {}) {
      return request("/memories", {
        query: { ...scope({ userId: u, agentId, runId }), top_k: topK, show_expired: showExpired },
      });
    },

    get(id) {
      return request(`/memories/${encodeURIComponent(id)}`);
    },

    update(id, { text, metadata, expirationDate } = {}) {
      return request(`/memories/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: compact({ text, metadata, expiration_date: expirationDate }),
      });
    },

    remove(id) {
      return request(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    removeAll({ userId: u, agentId, runId } = {}) {
      return request("/memories", { method: "DELETE", query: scope({ userId: u, agentId, runId }) });
    },

    history(id) {
      return request(`/memories/${encodeURIComponent(id)}/history`);
    },

    listEntities() {
      return request("/entities");
    },

    deleteEntity(type, id) {
      return request(`/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

// Build a client from the hook/MCP environment (MEM0_HOST, MEM0_USER_ID, MEM0_API_KEY).
export function clientFromEnv(env = process.env, extra = {}) {
  return createClient({
    host: env.MEM0_HOST,
    userId: env.MEM0_USER_ID || "claude-code",
    apiKey: env.MEM0_API_KEY,
    ...extra,
  });
}
