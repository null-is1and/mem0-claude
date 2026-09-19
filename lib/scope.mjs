// Memory scoping helpers shared by the hooks.
//
// Every hook-written memory carries three ids, mirroring upstream's plugin:
//   user_id  = the person (MEM0_USER_ID)         -> personal, cross-project recall
//   agent_id = the project ("project:<basename>") -> project-scoped recall
//   run_id   = the Claude Code session id         -> per-session listing / cleanup
// Hook-written summaries also get an expiration date so narrative ages out
// while explicitly curated memories (MCP add_memory) stay permanent.

const DEFAULT_SUMMARY_TTL_DAYS = 60;

export function projectAgentId(cwd) {
  const name = (cwd || "").replace(/\/+$/, "").split("/").pop() || "unknown";
  return `project:${name}`;
}

// YYYY-MM-DD `days` from `now` (UTC), or undefined when expiry is disabled.
export function expirationDate(days, now = new Date()) {
  if (!Number.isFinite(days) || days <= 0) return undefined;
  const d = new Date(now.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

export function summaryTtlDays(env = process.env) {
  const raw = env.MEM0_SUMMARY_TTL_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_SUMMARY_TTL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SUMMARY_TTL_DAYS;
}
