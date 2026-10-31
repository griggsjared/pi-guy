import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createEventBus,
  DefaultPackageManager,
  loadProjectContextFiles,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import agentsLocal from "../../src/agents-local/index.ts";
import header from "../../src/header/index.ts";
import { tempDir } from "../helpers/fs.ts";
import { captureHandlers } from "../helpers/pi.ts";
import { fakeTheme } from "../helpers/theme.ts";
import { sleep } from "../helpers/wait.ts";

test("header shows final context files regardless of extension order and resets each session", async (t) => {
  const root = await tempDir(t, "pi-header-");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const sharedFile = join(root, "AGENTS.md");
  const localFile = join(root, "AGENTS.local.md");
  await writeFile(sharedFile, "shared");
  await writeFile(localFile, "local");
  const initialContextFiles = loadProjectContextFiles({ cwd: root, agentDir: root });
  const { handlers, on } = captureHandlers();
  const pi = { events: createEventBus(), on } as unknown as ExtensionAPI;
  let rendered: { render(width: number): string[] } | undefined;
  let renderRequests = 0;
  const ctx = {
    mode: "tui",
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      setHeader(factory: any) {
        rendered = factory(
          {
            requestRender() {
              renderRequests++;
            },
          },
          { fg: (_color: string, value: string) => `\x1b[2m${value}\x1b[0m`, bold: (value: string) => value },
        );
      },
    },
  };
  header(pi);
  agentsLocal(pi);
  let extraPath: string | undefined = join(homedir(), "extra-上下.md");
  on("before_agent_start", (event) => {
    if (extraPath) {
      event.systemPromptOptions.contextFiles = [
        ...event.systemPromptOptions.contextFiles,
        { path: extraPath, content: "extra" },
      ];
    }
  });

  for (const handler of handlers.get("session_start")!) await handler({}, ctx);
  assert.ok(rendered);
  let lines = rendered
    .render(500)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(lines.includes(sharedFile));
  assert.ok(lines.includes(localFile));
  assert.ok(renderRequests > 0);
  assert.ok(!lines.includes("extra-上下.md"));
  await rm(sharedFile);
  assert.ok(rendered.render(500).join("\n").includes(sharedFile));

  let event = { systemPromptOptions: { contextFiles: [...initialContextFiles] } };
  for (const handler of handlers.get("before_agent_start")!) await handler(event, ctx);
  assert.ok(!rendered.render(500).join("\n").includes("extra-上下.md"));
  let beforeAgentRenderRequests = renderRequests;
  for (const handler of handlers.get("agent_start")!) await handler({}, ctx);
  assert.equal(renderRequests, beforeAgentRenderRequests + 1);
  lines = rendered
    .render(500)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(lines.includes("  Context:\n"));
  assert.ok(lines.includes(`    ${sharedFile}\n    ${localFile}\n    ~/extra-上下.md`));
  for (const width of [0, 1, 2, 4, 20, 80, 100, 500]) {
    const output = rendered.render(width);
    for (const line of output) assert.ok(visibleWidth(line) <= width);
    if (width >= 2) {
      const content = output.join("").replace(/\x1b\[[0-9;]*m/g, "");
      for (const path of [sharedFile, localFile, "~/extra-上下.md"]) {
        assert.ok(content.includes(path), `${path} missing at width ${width}`);
      }
    }
  }

  await rm(localFile);
  extraPath = join(root, "later.md");
  event = { systemPromptOptions: { contextFiles: [...initialContextFiles] } };
  for (const handler of handlers.get("before_agent_start")!) await handler(event, ctx);
  beforeAgentRenderRequests = renderRequests;
  for (const handler of handlers.get("agent_start")!) await handler({}, ctx);
  assert.equal(renderRequests, beforeAgentRenderRequests + 1);
  lines = rendered
    .render(500)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(lines.includes(`    ${sharedFile}\n    ${localFile}\n    ${extraPath}`));
  assert.ok(!lines.includes("extra-上下.md"));

  extraPath = undefined;
  event = { systemPromptOptions: { contextFiles: [] } };
  for (const handler of handlers.get("before_agent_start")!) await handler(event, ctx);
  for (const handler of handlers.get("agent_start")!) await handler({}, ctx);
  assert.ok(rendered.render(500).join("\n").includes(localFile));

  const child = join(root, "child");
  await mkdir(child);
  const childFile = join(child, "AGENTS.md");
  await writeFile(childFile, "child");
  ctx.cwd = child;
  for (const handler of handlers.get("session_start")!) await handler({}, ctx);
  lines = rendered
    .render(500)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(lines.includes(childFile));
  assert.ok(!lines.includes(sharedFile));
  assert.ok(!lines.includes(localFile));
  assert.ok(!lines.includes("later.md"));
});

test("header shows startup reports from multiple sources and clears updated reports", async (t) => {
  const root = await tempDir(t, "pi-header-reports-");
  const { handlers, on } = captureHandlers();
  const events = createEventBus();
  header({ events, on } as unknown as ExtensionAPI);
  let rendered: { render(width: number): string[] } | undefined;
  let renderRequests = 0;
  const ctx = {
    mode: "tui",
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      setHeader(factory: any) {
        rendered = factory(
          {
            requestRender() {
              renderRequests++;
            },
          },
          fakeTheme(),
        );
      },
    },
  };
  const privatePath = "/virtual/private.rules.md";
  const teamPath = "/virtual/team.instructions.md";
  events.emit("context:files", { source: "private", paths: [privatePath] });
  events.emit("context:files", { source: "team", paths: [teamPath] });
  await handlers.get("session_start")![0]!({}, ctx);
  assert.ok(rendered);
  assert.ok(rendered.render(500).join("\n").includes(privatePath));
  assert.ok(rendered.render(500).join("\n").includes(teamPath));
  await handlers.get("before_agent_start")![0]!(
    { systemPromptOptions: { contextFiles: [{ path: privatePath, content: "private" }] } },
    ctx,
  );
  await handlers.get("agent_start")![0]!({}, ctx);
  assert.equal(rendered.render(500).join("\n").split(privatePath).length - 1, 1);
  events.emit("context:files", { source: "private", paths: [] });
  await handlers.get("before_agent_start")![0]!({ systemPromptOptions: { contextFiles: [] } }, ctx);
  await handlers.get("agent_start")![0]!({}, ctx);
  assert.ok(!rendered.render(500).join("\n").includes(privatePath));
  assert.ok(rendered.render(500).join("\n").includes(teamPath));
  assert.ok(renderRequests > 0);
});

test("header shows the pi-bolt version between Pi and pi-guy only when running on pi-bolt", async (t) => {
  t.after(() => Reflect.deleteProperty(process.versions, "bun"));
  const onNode = await startHeaderProbe();
  assert.deepEqual(onNode.calls, []);
  assert.ok(onNode.render().includes(`pi v${VERSION} · pi-guy v`));

  Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.3.0" });
  const onPiBolt = await startHeaderProbe();
  assert.deepEqual(
    onPiBolt.calls.map(([file, args]) => [file, ...args]),
    [[process.execPath, "--version"]],
  );
  assert.equal(onPiBolt.calls[0]![2]!.timeout, 5000);
  assert.ok(onPiBolt.render().includes(`pi v${VERSION} · pi-guy v`));
  const beforeReply = onPiBolt.renderRequests;
  onPiBolt.result.resolve({
    stdout: `${VERSION} (Pi-Bolt 1.0.1, darwin-arm64, JIT off)\n`,
    stderr: "",
    code: 0,
    killed: false,
  });
  await onPiBolt.result.promise;
  assert.equal(onPiBolt.renderRequests, beforeReply + 1);
  assert.ok(onPiBolt.render().includes(`pi v${VERSION} · pi-bolt v1.0.1 · pi-guy v`));
});

test("shutdown aborts the version probe and ignores its late result", async (t) => {
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.3.0" });
  t.after(() => Reflect.deleteProperty(process.versions, "bun"));
  const probe = await startHeaderProbe();
  const signal = probe.calls[0]![2]!.signal!;
  assert.equal(signal.aborted, false);
  await probe.handlers.get("session_shutdown")![0]!({}, {});
  assert.equal(signal.aborted, true);
  probe.result.resolve({ stdout: `${VERSION} (Pi-Bolt 1.0.1)\n`, stderr: "", code: 0, killed: false });
  await probe.result.promise;
  assert.ok(probe.render().includes(`pi v${VERSION} · pi-guy v`));
});

test("header leaves out the pi-bolt version when its probe fails", async (t) => {
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.3.0" });
  t.after(() => Reflect.deleteProperty(process.versions, "bun"));
  for (const failure of ["non-zero exit", "killed", "rejection"]) {
    await t.test(failure, async () => {
      const probe = await startHeaderProbe();
      if (failure === "rejection") probe.result.reject(new Error("probe failed"));
      else
        probe.result.resolve({
          stdout: `${VERSION} (Pi-Bolt 1.0.1)\n`,
          stderr: "probe failed",
          code: failure === "non-zero exit" ? 1 : 0,
          killed: failure === "killed",
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(probe.render().includes(`pi v${VERSION} · pi-guy v`));
    });
  }
});

test("header lists configured extensions by short name, without pi-guy or untrusted project extensions", async (t) => {
  const root = await tempDir(t, "pi-header-extensions-");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const files: Record<string, string> = {
    "agent/extensions/rtk.ts": "export default () => {};",
    "agent/extensions/notes/index.ts": "export default () => {};",
    "agent/settings.json": JSON.stringify({ packages: ["npm:@acme/pi-tools", "npm:pi-guy"] }),
    "agent/npm/node_modules/@acme/pi-tools/package.json": JSON.stringify({
      name: "@acme/pi-tools",
      version: "1.0.0",
      pi: { extensions: ["./a.ts", "./b.ts"] },
    }),
    "agent/npm/node_modules/@acme/pi-tools/a.ts": "export default () => {};",
    "agent/npm/node_modules/@acme/pi-tools/b.ts": "export default () => {};",
    "agent/npm/node_modules/pi-guy/package.json": JSON.stringify({
      name: "pi-guy",
      version: "1.0.0",
      pi: { extensions: ["./index.ts"] },
    }),
    "agent/npm/node_modules/pi-guy/index.ts": "export default () => {};",
    "project/.pi/extensions/local.ts": "export default () => {};",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const start = async (trusted: boolean) => {
    const { handlers, on } = captureHandlers();
    header({ events: createEventBus(), on } as unknown as ExtensionAPI);
    let rendered: { render(width: number): string[] } | undefined;
    let resolved = false;
    await handlers.get("session_start")![0]!(
      {},
      {
        mode: "tui",
        cwd: project,
        isProjectTrusted: () => trusted,
        ui: {
          setHeader(factory: any) {
            rendered = factory(
              {
                requestRender() {
                  resolved = true;
                },
              },
              fakeTheme(),
            );
          },
        },
      },
    );
    for (let waited = 0; !resolved && waited < 1000; waited += 5) await sleep(5);
    return rendered!.render(500).join("\n");
  };

  assert.ok((await start(false)).includes("  Extensions: notes · rtk · pi-tools\n  Context: none\n"));
  assert.ok((await start(true)).includes("  Extensions: local · notes · rtk · pi-tools\n"));
});

test("header does not install or request terminal rendering in noninteractive modes", async () => {
  const { handlers, on } = captureHandlers();
  header({ events: createEventBus(), on } as unknown as ExtensionAPI);
  for (const mode of ["print", "json", "rpc"]) {
    const ctx = {
      mode,
      get cwd() {
        return assert.fail("unexpected context discovery");
      },
      ui: {
        setHeader() {
          assert.fail("unexpected terminal header");
        },
      },
    };
    await handlers.get("session_start")![0]!({}, ctx);
    await handlers.get("before_agent_start")![0]!({ systemPromptOptions: { contextFiles: [] } }, ctx);
    await handlers.get("agent_start")![0]!({}, ctx);
  }
});

test("header uses the package version tag or its Git commit, without using a parent repository", async (t) => {
  const packageDir = fileURLToPath(new URL("../../", import.meta.url));
  const version = (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
  ).version;
  for (const scenario of ["tagged", "untagged", "git unavailable", "parent repository"]) {
    await t.test(scenario, async (t) => {
      const calls: Parameters<ExtensionAPI["exec"]>[] = [];
      const tagResult = Promise.withResolvers<Awaited<ReturnType<ExtensionAPI["exec"]>>>();
      if (scenario === "untagged") {
        t.mock.method(DefaultPackageManager.prototype, "resolve", async () => ({
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
        }));
      }
      const probe = await startHeaderProbe(async (...args) => {
        calls.push(args);
        if (scenario === "git unavailable") throw new Error("git unavailable");
        if (scenario === "untagged" && args[1][0] === "tag") return tagResult.promise;
        const stdout =
          args[1][0] === "rev-parse"
            ? `${scenario === "parent repository" ? tmpdir() : packageDir}\n843cbb0\n`
            : (scenario === "tagged") === (args[1][2] === "843cbb0")
              ? `v${version}\n`
              : "";
        return { stdout, stderr: "", code: 0, killed: false };
      });
      if (scenario === "untagged") {
        assert.ok(probe.render().includes("  Extensions: none\n"));
        const beforeReply = probe.renderRequests;
        tagResult.resolve({
          stdout: calls[1]![1][2] === "843cbb0" ? "" : `v${version}\n`,
          stderr: "",
          code: 0,
          killed: false,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(probe.renderRequests, beforeReply + 1);
      }
      const suffix = scenario === "untagged" ? "-843cbb0" : "";
      assert.ok(probe.render().includes(`pi-guy v${version}${suffix}\n`));
      assert.equal(calls[0]![2]!.cwd, packageDir);
      assert.equal(calls[0]![2]!.timeout, 5000);
      if (scenario !== "tagged" && scenario !== "untagged") assert.equal(calls.length, 1);
    });
  }
});

test("shutdown ignores a late Git version result", async () => {
  const result = Promise.withResolvers<Awaited<ReturnType<ExtensionAPI["exec"]>>>();
  let signal: AbortSignal | undefined;
  const probe = await startHeaderProbe(async (_file, _args, options) => {
    signal = options?.signal;
    return result.promise;
  });
  const before = probe.render();
  await probe.handlers.get("session_shutdown")![0]!({}, {});
  assert.equal(signal?.aborted, true);
  result.resolve({
    stdout: `${fileURLToPath(new URL("../../", import.meta.url))}\n843cbb0\n`,
    stderr: "",
    code: 0,
    killed: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probe.render(), before);
});

async function startHeaderProbe(
  gitExec: ExtensionAPI["exec"] = async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
) {
  const calls: Parameters<ExtensionAPI["exec"]>[] = [];
  const result = Promise.withResolvers<Awaited<ReturnType<ExtensionAPI["exec"]>>>();
  const { handlers, on } = captureHandlers();
  header({
    events: createEventBus(),
    on,
    exec(...args: Parameters<ExtensionAPI["exec"]>) {
      if (args[0] === "git") return gitExec(...args);
      calls.push(args);
      return result.promise;
    },
  } as unknown as ExtensionAPI);
  let rendered: { render(width: number): string[] } | undefined;
  let renderRequests = 0;
  await handlers.get("session_start")![0]!(
    {},
    {
      mode: "tui",
      cwd: tmpdir(),
      isProjectTrusted: () => true,
      ui: {
        setHeader(factory: any) {
          rendered = factory(
            {
              requestRender() {
                renderRequests++;
              },
            },
            fakeTheme(),
          );
        },
      },
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    calls,
    result,
    handlers,
    render: () => rendered!.render(500).join("\n"),
    get renderRequests() {
      return renderRequests;
    },
  };
}
