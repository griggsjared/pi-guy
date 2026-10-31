import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverAgents,
  loadSubagentSettings,
  parseFrontmatter,
  parseSubagentSettings,
  resolveAgentSettings,
  resolveExtensionPaths,
  SESSION_PROFILE_NAME,
} from "../../src/subagents/agents.ts";
import { tempDir } from "../helpers/fs.ts";

test("frontmatter separates metadata from the body", () => {
  const { meta, body } = parseFrontmatter("---\nname: scout\ndescription: Fast\n---\n\nBody text");
  assert.deepEqual(meta, { name: "scout", description: "Fast" });
  assert.equal(body, "Body text");
});

test("text without frontmatter remains the body", () => {
  const { meta, body } = parseFrontmatter("just body");
  assert.deepEqual(meta, {});
  assert.equal(body, "just body");
});

test("frontmatter skips lines without a colon", () => {
  const { meta } = parseFrontmatter("---\nnot a key value pair\nname: x\n---\nbody");
  assert.deepEqual(meta, { name: "x" });
});

test("discovery parses agent metadata", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  const file = join(dir, "worker.md");
  await writeFile(
    file,
    [
      "---",
      "name: worker",
      "description: Implements things",
      "model: opencode-go/deepseek-v4-pro",
      "thinkingLevel: high",
      "tools: read, grep, bash, edit",
      "inactivityTimeoutMs: 300000",
      "---",
      "You are a worker.",
    ].join("\n"),
  );
  const [agent] = await discoverAgents(dir);
  assert.equal(agent?.name, "worker");
  assert.equal(agent?.description, "Implements things");
  assert.equal(agent?.model, "opencode-go/deepseek-v4-pro");
  assert.equal(agent?.thinkingLevel, "high");
  assert.deepEqual(agent?.tools, ["read", "grep", "bash", "edit"]);
  assert.equal(agent?.inactivityTimeoutMs, 300000);
  assert.equal(agent?.systemPrompt, "You are a worker.");
});

test("discovery falls back to filename and validates inactivityTimeoutMs strictly", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  const file = join(dir, "fallback.md");
  for (const [value, expected] of [
    ["0", 0],
    ["2147483647", 2147483647],
    ["banana", undefined],
    ["", undefined],
    ["10ms", undefined],
    ["1.5", undefined],
    ["1e3", undefined],
    ["-1", undefined],
    ["2147483648", undefined],
  ] as const) {
    await writeFile(file, `---\ndescription: no name\ninactivityTimeoutMs: ${value}\n---\nbody`);
    const [agent] = await discoverAgents(dir);
    assert.equal(agent?.name, "fallback");
    assert.equal(agent?.inactivityTimeoutMs, expected, value);
    assert.equal(agent?.description, "no name");
    assert.equal(agent?.systemPrompt, "body");
  }
});

test("discovery loads only readable .md files, in name order", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir);
  await writeFile(join(agentsDir, "a.md"), "---\nname: alpha\n---\nprompt");
  await writeFile(join(agentsDir, "b.md"), "---\ndescription: no name\n---\nprompt");
  await writeFile(join(agentsDir, "ignore.txt"), "not an agent");
  await mkdir(join(agentsDir, "0-unreadable.md"));
  const agents = await discoverAgents(agentsDir);
  assert.deepEqual(
    agents.map((a) => a.name),
    ["alpha", "b"],
  );
});

test("discovery returns no agents for a missing directory", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  assert.deepEqual(await discoverAgents(join(dir, "agents")), []);
});

test("legacy settings become the default profile with validated overrides", () => {
  const settings = parseSubagentSettings({
    defaults: { model: "gpt-5", thinkingLevel: "max", tools: ["edit"] },
    agents: {
      scout: { model: "sonnet:high", thinkingLevel: "high" },
      invalid: { model: "openai/gpt\u0000", thinkingLevel: "maximum" },
    },
  });
  assert.deepEqual(Object.keys(settings.profiles), ["session", "default"]);
  assert.deepEqual(settings.profiles.default!.defaults, { model: "gpt-5", thinkingLevel: "max" });
  assert.deepEqual(settings.profiles.default!.agents.scout, { model: "sonnet:high", thinkingLevel: "high" });
  assert.equal(settings.profiles.default!.agents.invalid, undefined);
});

test("timeout-only overrides survive when inactivityTimeoutMs is valid", () => {
  for (const value of [0, 2147483647, -1, 2147483648, 1.5, "100", null, NaN, Infinity]) {
    const settings = parseSubagentSettings({
      profiles: {
        idle: { defaults: { inactivityTimeoutMs: value }, agents: { worker: { inactivityTimeoutMs: value } } },
      },
    });
    const expected = value === 0 || value === 2147483647 ? { inactivityTimeoutMs: value } : {};
    assert.deepEqual(settings.profiles.idle!.defaults, expected);
    assert.deepEqual(settings.profiles.idle!.agents, Object.keys(expected).length ? { worker: expected } : {});
  }
});

test("missing or malformed configuration uses the session profile", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  const file = join(dir, "subagents.json");
  const fallback = join(dir, "settings.json");
  const empty = { profiles: { session: { defaults: {}, agents: {} } }, extensions: [] };
  assert.deepEqual(await loadSubagentSettings(file, fallback), empty);

  await writeFile(fallback, "{");
  assert.deepEqual(await loadSubagentSettings(file, fallback), empty);

  await writeFile(fallback, JSON.stringify({ subagents: { profiles: { saved: {} } } }));
  await writeFile(file, "{");
  assert.deepEqual(await loadSubagentSettings(file, fallback), empty);
});

test("configuration uses the agent directory and prefers subagents.json over settings.json", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const file = join(dir, "subagents.json");
  const fallback = join(dir, "settings.json");
  try {
    await writeFile(fallback, JSON.stringify({ subagents: { profiles: { legacy: {} } } }));
    assert.deepEqual(Object.keys((await loadSubagentSettings()).profiles), ["session", "legacy"]);

    await writeFile(file, JSON.stringify({ profiles: { current: {} } }));
    assert.deepEqual(Object.keys((await loadSubagentSettings()).profiles), ["session", "current"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("dedicated and fallback configuration reject reserved session profiles", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  const file = join(dir, "subagents.json");
  const fallback = join(dir, "settings.json");
  await writeFile(fallback, JSON.stringify({ subagents: { profiles: { session: { enabled: false } } } }));
  await assert.rejects(loadSubagentSettings(file, fallback), /profile name "session" is reserved/);

  await writeFile(fallback, JSON.stringify({ subagents: { profiles: { valid: {} } } }));
  await writeFile(file, JSON.stringify({ profiles: { session: {} } }));
  await assert.rejects(loadSubagentSettings(file, fallback), /profile name "session" is reserved/);
});

test("extension settings keep only well-formed npm package specs", () => {
  const settings = parseSubagentSettings({
    extensions: [
      "npm:pi-claude-bridge",
      "npm:@scope/pkg",
      "npm:pi-claude-bridge",
      "pi-claude-bridge",
      "npm:../escape",
      "npm:has space",
      42,
    ],
    defaults: { model: "gpt-5" },
  });
  assert.deepEqual(settings.extensions, ["npm:pi-claude-bridge", "npm:@scope/pkg"]);
});

test("extensions are retained when no profiles are defined", () => {
  const settings = parseSubagentSettings({ extensions: ["npm:pi-claude-bridge"] });
  assert.deepEqual(settings.extensions, ["npm:pi-claude-bridge"]);
  assert.deepEqual(settings.profiles, { session: { defaults: {}, agents: {} } });
});

test("extension paths use package manifests and honor the configured package directory", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousPackage = process.env.PI_PACKAGE_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_PACKAGE_DIR;
  const packageDir = join(dir, "npm");
  try {
    const bridge = join(packageDir, "node_modules", "pi-claude-bridge");
    await mkdir(bridge, { recursive: true });
    await writeFile(join(bridge, "package.json"), JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }));

    const noPi = join(packageDir, "node_modules", "pi-plain");
    await mkdir(noPi, { recursive: true });
    await writeFile(join(noPi, "package.json"), JSON.stringify({ name: "pi-plain" }));

    const paths = await resolveExtensionPaths(["npm:pi-claude-bridge", "npm:pi-plain", "npm:pi-missing"]);
    assert.deepEqual(paths, [join(bridge, "src", "index.ts")]);
    process.env.PI_PACKAGE_DIR = join(dir, "override");
    const override = join(process.env.PI_PACKAGE_DIR, "node_modules", "pi-claude-bridge");
    await mkdir(override, { recursive: true });
    await writeFile(join(override, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }));
    assert.deepEqual(await resolveExtensionPaths(["npm:pi-claude-bridge"]), [join(override, "index.ts")]);
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousPackage === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = previousPackage;
  }
});

test("agent overrides take precedence over frontmatter and profile defaults", () => {
  const settings = parseSubagentSettings({
    defaults: { model: "default/model", thinkingLevel: "low", inactivityTimeoutMs: 100 },
    agents: { scout: { model: "local/model", thinkingLevel: "high", inactivityTimeoutMs: 0 } },
  });
  const agent = resolveAgentSettings(
    {
      name: "scout",
      description: "",
      model: "frontmatter/model",
      thinkingLevel: "medium",
      tools: ["read"],
      systemPrompt: "",
      inactivityTimeoutMs: 200,
    },
    settings,
    "default",
  );
  assert.equal(agent.model, "local/model");
  assert.equal(agent.thinkingLevel, "high");
  assert.equal(agent.inactivityTimeoutMs, 0);
  assert.deepEqual(agent.tools, ["read"]);

  const frontmatter = resolveAgentSettings(
    {
      name: "worker",
      description: "",
      model: "frontmatter/model",
      thinkingLevel: "medium",
      systemPrompt: "",
      inactivityTimeoutMs: 0,
    },
    settings,
    "default",
  );
  assert.equal(frontmatter.model, "frontmatter/model");
  assert.equal(frontmatter.thinkingLevel, "medium");
  assert.equal(frontmatter.inactivityTimeoutMs, 0);

  const defaults = resolveAgentSettings({ name: "worker", description: "", systemPrompt: "" }, settings, "default");
  assert.equal(defaults.model, "default/model");
  assert.equal(defaults.thinkingLevel, "low");
  assert.equal(defaults.inactivityTimeoutMs, 100);
});

test("the session profile ignores agent models but retains thinking and inactivity settings", () => {
  const settings = parseSubagentSettings({
    profiles: { other: { defaults: { model: "other/model", thinkingLevel: "low" } } },
  });
  const agent = {
    name: "scout",
    description: "",
    model: "frontmatter/model",
    thinkingLevel: "high",
    systemPrompt: "",
    inactivityTimeoutMs: 0,
  };
  const resolved = resolveAgentSettings(agent, settings, SESSION_PROFILE_NAME);
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.thinkingLevel, "high");
  assert.equal(resolved.inactivityTimeoutMs, 0);
  assert.equal(agent.model, "frontmatter/model");
  assert.equal(resolveAgentSettings(agent, settings).model, "frontmatter/model");

  const withoutThinking = resolveAgentSettings({ ...agent, thinkingLevel: undefined }, settings, SESSION_PROFILE_NAME);
  assert.equal(withoutThinking.model, undefined);
  assert.equal(withoutThinking.thinkingLevel, undefined);
});

test("invalid profiles and defaultProfile are ignored", () => {
  const settings = parseSubagentSettings({
    defaultProfile: "fast",
    profiles: {
      fast: { defaults: { model: "fast/model" } },
      slow: { defaults: { model: "slow/model" } },
      "not valid": { defaults: { model: "ignored/model" } },
      broken: null,
    },
  });
  assert.equal("defaultProfile" in settings, false);
  assert.deepEqual(Object.keys(settings.profiles), ["session", "fast", "slow"]);
  assert.deepEqual(settings.profiles.fast!.defaults, { model: "fast/model" });
  assert.deepEqual(settings.profiles.slow!.defaults, { model: "slow/model" });
});

test("session and off remain reserved for disabled or malformed profiles", () => {
  for (const profile of [{}, { enabled: false }, null]) {
    assert.throws(
      () => parseSubagentSettings({ profiles: { session: profile } }),
      /profile name "session" is reserved/,
    );
    assert.throws(() => parseSubagentSettings({ profiles: { off: profile } }), /profile name "off" is reserved/);
  }
});

test("profiles are enabled unless enabled is explicitly false", () => {
  for (const enabled of [undefined, true, "false", 0, null]) {
    const settings = parseSubagentSettings({
      defaultProfile: "disabled",
      profiles: {
        disabled: { enabled: false, defaults: { model: "disabled/model" } },
        active: { enabled, defaults: { model: "active/model" } },
      },
    });
    assert.deepEqual(Object.keys(settings.profiles), ["session", "active"]);
    assert.deepEqual(settings.profiles.active!.defaults, { model: "active/model" });
    const agent = { name: "worker", description: "", systemPrompt: "" };
    assert.equal(resolveAgentSettings(agent, settings, "disabled").model, undefined);
  }
});

test("a profile named default and former defaultProfile are not privileged", () => {
  const settings = parseSubagentSettings({
    defaultProfile: "disabled",
    profiles: {
      disabled: { enabled: false },
      backup: { defaults: { model: "backup/model" } },
      default: { defaults: { model: "default/model" } },
    },
  });
  assert.deepEqual(Object.keys(settings.profiles), ["session", "backup", "default"]);
  const agent = { name: "worker", description: "", systemPrompt: "" };
  assert.equal(resolveAgentSettings(agent, settings).model, undefined);
  assert.equal(resolveAgentSettings(agent, settings, "default").model, "default/model");
  assert.equal(resolveAgentSettings(agent, settings, "backup").model, "backup/model");
  assert.equal(resolveAgentSettings(agent, settings, "disabled").model, undefined);
});

test("disabled profile configuration remains in the file and can be restored", async (t) => {
  const dir = await tempDir(t, "subagents-test-");
  const file = join(dir, "subagents.json");
  const config = {
    profiles: {
      active: {},
      disabled: {
        enabled: false,
        defaults: { model: "saved/model", thinkingLevel: "low" },
        agents: { scout: { thinkingLevel: "high" } },
      },
    },
  };
  const text = JSON.stringify(config);
  await writeFile(file, text);
  assert.deepEqual(Object.keys((await loadSubagentSettings(file)).profiles), ["session", "active"]);
  assert.equal(await readFile(file, "utf8"), text);

  config.profiles.disabled.enabled = true;
  const restored = parseSubagentSettings(config);
  assert.deepEqual(restored.profiles.disabled, {
    defaults: { model: "saved/model", thinkingLevel: "low" },
    agents: { scout: { thinkingLevel: "high" } },
  });
});

test("the session profile is used when every configured profile is disabled", () => {
  const extensions = ["npm:pi-claude-bridge"];
  const settings = parseSubagentSettings({
    defaultProfile: "disabled",
    extensions,
    profiles: {
      disabled: { enabled: false, defaults: { model: "disabled/model", thinkingLevel: "low" } },
      default: { enabled: false, agents: { scout: { model: "saved/model" } } },
    },
  });
  assert.deepEqual(settings.profiles, { session: { defaults: {}, agents: {} } });
  assert.deepEqual(settings.extensions, extensions);
  assert.deepEqual(settings, parseSubagentSettings({ extensions }));
  const agent = { name: "scout", description: "", model: "frontmatter/model", thinkingLevel: "high", systemPrompt: "" };
  const resolved = resolveAgentSettings(agent, settings);
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.thinkingLevel, "high");
});

test("explicitly selected profiles determine agent settings", () => {
  const settings = parseSubagentSettings({
    defaultProfile: "fast",
    profiles: {
      fast: { defaults: { model: "fast/model" } },
      slow: { defaults: { model: "slow/model" } },
    },
  });
  const agent = { name: "worker", description: "", systemPrompt: "" };
  assert.equal(resolveAgentSettings(agent, settings).model, undefined);
  assert.equal(resolveAgentSettings(agent, settings, "fast").model, "fast/model");
  assert.equal(resolveAgentSettings(agent, settings, "slow").model, "slow/model");
  assert.equal(resolveAgentSettings(agent, settings, "missing").model, undefined);
});

test("agent resolution uses only an explicitly selected own profile or implicit session", () => {
  const agent = { name: "worker", description: "", systemPrompt: "", model: "file/model" };
  const none = parseSubagentSettings(undefined);
  assert.equal(resolveAgentSettings(agent, none).model, undefined);
  for (const name of ["default", "constructor"]) {
    assert.equal(resolveAgentSettings(agent, none, name).model, "file/model");
  }
  const one = parseSubagentSettings({
    defaultProfile: "missing",
    profiles: { only: { defaults: { model: "only/model" } } },
  });
  const bare = { ...agent, model: undefined };
  assert.equal(resolveAgentSettings(bare, one).model, undefined);
  assert.equal(resolveAgentSettings(bare, one, "only").model, "only/model");
  for (const name of ["missing", "constructor"]) {
    assert.equal(resolveAgentSettings(agent, one, name).model, "file/model");
  }
});
