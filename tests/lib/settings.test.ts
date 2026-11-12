import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettingsSection } from "../../src/lib/settings.ts";
import { tempDir } from "../helpers/fs.ts";

test("returns the named settings section", async (t) => {
  const dir = await tempDir(t, "settings-");
  const path = join(dir, "pi-guy.json");
  await writeFile(path, JSON.stringify({ subagents: { a: 1 }, other: {} }));

  assert.deepEqual(await loadSettingsSection("subagents", path), { a: 1 });
});

test("returns undefined for missing or unusable settings", async (t) => {
  const dir = await tempDir(t, "settings-");
  const path = join(dir, "pi-guy.json");

  assert.equal(await loadSettingsSection("subagents", path), undefined, "missing file");
  for (const [description, contents] of [
    ["invalid JSON", "{"],
    ["array top level", "[]"],
    ["missing key", '{"other":{}}'],
  ]) {
    await writeFile(path, contents!);
    assert.equal(await loadSettingsSection("subagents", path), undefined, description);
  }
});
