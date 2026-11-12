import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_FILE = "pi-guy.json";

/** Returns one feature's section of pi-guy.json without validating it, or undefined when the file is missing, is not a JSON object, or lacks the key. */
export async function loadSettingsSection(key: string, path = join(getAgentDir(), SETTINGS_FILE)): Promise<unknown> {
  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  return Object.hasOwn(settings, key) ? (settings as Record<string, unknown>)[key] : undefined;
}
