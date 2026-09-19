import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("watermark state dir can be overridden with MEM0_STATE_DIR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mem0-wm-"));
  process.env.MEM0_STATE_DIR = dir;
  const { getWatermark, setWatermark } = await import("../hooks/watermark.mjs?" + Date.now());
  assert.equal(await getWatermark("abc"), 0);
  await setWatermark("abc", 42);
  assert.equal(await getWatermark("abc"), 42);
  assert.equal(JSON.parse(await readFile(join(dir, "abc.json"), "utf-8")).lineCount, 42);
});
