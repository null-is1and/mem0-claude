// Shared extraction prompt for the Stop / PreCompact hooks.
//
// IMPORTANT: mem0's /memories add endpoint runs its OWN extraction LLM over
// whatever you POST. Instructions stuffed into message *content* are treated as
// data to mine for facts (so they leak back as memories) — they are NOT obeyed.
// The supported channel for steering extraction is the `prompt` field on the
// add request, which overrides mem0's server-side extractor instructions. Pass
// the real conversation as `messages` and this string as `prompt`.
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
