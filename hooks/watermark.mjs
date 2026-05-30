// Per-session watermark — tracks how many transcript lines a session has
// already summarized into mem0, so Stop and PreCompact only summarize the
// delta since the last summary instead of overlapping on the same tail.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const STATE_DIR = resolve(dirname(new URL(import.meta.url).pathname), ".state");

function stateFile(sessionId) {
  // session_id is a UUID, safe to use directly as a filename
  return resolve(STATE_DIR, `${sessionId}.json`);
}

// Lines already summarized for this session (0 if never summarized).
export async function getWatermark(sessionId) {
  if (!sessionId) return 0;
  try {
    const raw = await readFile(stateFile(sessionId), "utf-8");
    return JSON.parse(raw).lineCount || 0;
  } catch {
    return 0;
  }
}

// Record how many transcript lines have now been summarized. Call only after a
// successful write so skipped (too-small) deltas are retried by the next hook.
export async function setWatermark(sessionId, lineCount) {
  if (!sessionId) return;
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(stateFile(sessionId), JSON.stringify({ lineCount }));
  } catch {
    // Non-fatal — at worst the next hook re-summarizes this delta.
  }
}
