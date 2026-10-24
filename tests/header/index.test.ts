import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, loadProjectContextFiles, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import agentsLocal from "../../agents-local.ts";
import header from "../../src/header/index.ts";

test("header shows final context files regardless of extension order and resets each session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-header-"));
	t.after(() => rm(root, { recursive: true, force: true }));
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
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const pi = {
		events: createEventBus(),
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;
	let rendered: { render(width: number): string[] } | undefined;
	let renderRequests = 0;
	const ctx = {
		mode: "tui", cwd: root, isProjectTrusted: () => true,
		ui: {
			setHeader(factory: any) {
				rendered = factory(
					{ requestRender() { renderRequests++; } },
					{ fg: (_color: string, value: string) => `\x1b[2m${value}\x1b[0m`, bold: (value: string) => value },
				);
			},
		},
	};
	header(pi);
	agentsLocal(pi);
	let extraPath: string | undefined = join(homedir(), "extra-上下.md");
	pi.on("before_agent_start", (event) => {
		if (extraPath) {
			event.systemPromptOptions.contextFiles = [...event.systemPromptOptions.contextFiles, { path: extraPath, content: "extra" }];
		}
	});

	for (const handler of handlers.get("session_start")!) await handler({}, ctx);
	assert.ok(rendered);
	let lines = rendered.render(500).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
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
	lines = rendered.render(500).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
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
	lines = rendered.render(500).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
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
	lines = rendered.render(500).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(lines.includes(childFile));
	assert.ok(!lines.includes(sharedFile));
	assert.ok(!lines.includes(localFile));
	assert.ok(!lines.includes("later.md"));
});

test("header shows startup reports from multiple sources and clears updated reports", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-header-reports-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const events = createEventBus();
	header({ events, on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	let rendered: { render(width: number): string[] } | undefined;
	let renderRequests = 0;
	const ctx = {
		mode: "tui", cwd: root, isProjectTrusted: () => true,
		ui: {
			setHeader(factory: any) {
				rendered = factory(
					{ requestRender() { renderRequests++; } },
					{ fg: (_color: string, value: string) => value, bold: (value: string) => value },
				);
			},
		},
	};
	const privatePath = "/virtual/private.rules.md";
	const teamPath = "/virtual/team.instructions.md";
	events.emit("context:files", { source: "private", paths: [privatePath] });
	events.emit("context:files", { source: "team", paths: [teamPath] });
	await handlers.get("session_start")!({}, ctx);
	assert.ok(rendered);
	assert.ok(rendered.render(500).join("\n").includes(privatePath));
	assert.ok(rendered.render(500).join("\n").includes(teamPath));
	await handlers.get("before_agent_start")!({ systemPromptOptions: { contextFiles: [{ path: privatePath, content: "private" }] } }, ctx);
	await handlers.get("agent_start")!({}, ctx);
	assert.equal(rendered.render(500).join("\n").split(privatePath).length - 1, 1);
	events.emit("context:files", { source: "private", paths: [] });
	await handlers.get("before_agent_start")!({ systemPromptOptions: { contextFiles: [] } }, ctx);
	await handlers.get("agent_start")!({}, ctx);
	assert.ok(!rendered.render(500).join("\n").includes(privatePath));
	assert.ok(rendered.render(500).join("\n").includes(teamPath));
	assert.ok(renderRequests > 0);
});

test("header shows the pi-bolt version between Pi and pi-guy only when running on pi-bolt", async (t) => {
	const runs: string[][] = [];
	let reply: ((error: Error | null, stdout: string) => void) | undefined;
	t.mock.method(childProcess, "execFile", ((file: string, args: string[], _options: unknown, callback: typeof reply) => {
		runs.push([file, ...args]);
		reply = callback;
	}) as unknown as typeof childProcess.execFile);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		Reflect.deleteProperty(process.versions, "bun");
	});
	let renderRequests = 0;
	const start = async () => {
		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		header({ events: createEventBus(), on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
		let rendered: { render(width: number): string[] } | undefined;
		await handlers.get("session_start")!({}, {
			mode: "tui", cwd: tmpdir(), isProjectTrusted: () => true,
			ui: {
				setHeader(factory: any) {
					rendered = factory(
						{ requestRender() { renderRequests++; } },
						{ fg: (_color: string, value: string) => value, bold: (value: string) => value },
					);
				},
			},
		});
		return () => rendered!.render(500).join("\n");
	};

	const onNode = await start();
	assert.deepEqual(runs, []);
	assert.ok(onNode().includes(`π v${VERSION} · pi-guy v`));

	Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.3.0" });
	const onPiBolt = await start();
	assert.deepEqual(runs, [[process.execPath, "--version"]]);
	const beforeReply = renderRequests;
	reply!(null, `${VERSION} (Pi-Bolt 1.0.1, darwin-arm64, JIT off)\n`);
	assert.equal(renderRequests, beforeReply + 1);
	assert.ok(onPiBolt().includes(`π v${VERSION} · pi-bolt v1.0.1 · pi-guy v`));
});

test("header lists configured extensions by short name, without pi-guy or untrusted project extensions", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-header-extensions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
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
		"agent/npm/node_modules/@acme/pi-tools/package.json": JSON.stringify({ name: "@acme/pi-tools", version: "1.0.0", pi: { extensions: ["./a.ts", "./b.ts"] } }),
		"agent/npm/node_modules/@acme/pi-tools/a.ts": "export default () => {};",
		"agent/npm/node_modules/@acme/pi-tools/b.ts": "export default () => {};",
		"agent/npm/node_modules/pi-guy/package.json": JSON.stringify({ name: "pi-guy", version: "1.0.0", pi: { extensions: ["./index.ts"] } }),
		"agent/npm/node_modules/pi-guy/index.ts": "export default () => {};",
		"project/.pi/extensions/local.ts": "export default () => {};",
	};
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), content);
	}
	const start = async (trusted: boolean) => {
		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		header({ events: createEventBus(), on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
		let rendered: { render(width: number): string[] } | undefined;
		let resolved = false;
		await handlers.get("session_start")!({}, {
			mode: "tui", cwd: project, isProjectTrusted: () => trusted,
			ui: {
				setHeader(factory: any) {
					rendered = factory(
						{ requestRender() { resolved = true; } },
						{ fg: (_color: string, value: string) => value, bold: (value: string) => value },
					);
				},
			},
		});
		for (let waited = 0; !resolved && waited < 1000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
		return rendered!.render(500).join("\n");
	};

	assert.ok((await start(false)).includes("  Extensions: notes · rtk · pi-tools\n  Context: none\n"));
	assert.ok((await start(true)).includes("  Extensions: local · notes · rtk · pi-tools\n"));
});

test("header does not install or request terminal rendering in noninteractive modes", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	header({ events: createEventBus(), on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	for (const mode of ["print", "json", "rpc"]) {
		const ctx = {
			mode,
			get cwd() { return assert.fail("unexpected context discovery"); },
			ui: { setHeader() { assert.fail("unexpected terminal header"); } },
		};
		await handlers.get("session_start")!({}, ctx);
		await handlers.get("before_agent_start")!({ systemPromptOptions: { contextFiles: [] } }, ctx);
		await handlers.get("agent_start")!({}, ctx);
	}
});
