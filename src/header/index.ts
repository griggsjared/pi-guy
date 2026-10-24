/**
 * Installer-style Pi startup header.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { DefaultPackageManager, loadProjectContextFiles, SettingsManager, VERSION, type BeforeAgentStartEvent, type ExtensionAPI, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// Rows of each letter in "pi-guy"; LOGO_COLORS[i] colors LOGO_GLYPHS[i].
const LOGO_COLORS: ThemeColor[] = ["error", "accent", "warning", "customMessageLabel", "success", "mdHeading"];
const LOGO_GLYPHS = [
	["     ", "█▀▀▀▄", "█▄▄▄▀", "█    "],
	["▀", "█", "█", " "],
	["   ", "▄▄▄", "   ", "   "],
	["     ", "▄▀▀▀█", "▀▄▄▄█", "▄▄▄▄▀"],
	["     ", "█   █", "▀▄▄▄█", "     "],
	["     ", "█   █", "▀▄▄▄█", "▄▄▄▄▀"],
];

export default function (pi: ExtensionAPI) {
	let contextPaths: string[] = [];
	let promptOptions: BeforeAgentStartEvent["systemPromptOptions"] | undefined;
	let requestRender: (() => void) | undefined;
	let piBoltVersion: string | undefined;
	let piBoltChecked = false;
	let extensionNames: string[] | undefined;
	let extensionsChecked = false;
	const reportedContextPaths = new Map<string, string[]>();

	pi.events.on("context:files", (data) => {
		const { source, paths } = data as { source: string; paths: string[] };
		reportedContextPaths.set(source, paths);
		requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		contextPaths = [];
		promptOptions = undefined;
		requestRender = undefined;
		if (ctx.mode !== "tui") return;

		// Pi-Bolt is a Bun-compiled build that exposes its own version only through --version; extensions see Pi's VERSION.
		if (!piBoltChecked && process.versions.bun) {
			piBoltChecked = true;
			execFile(process.execPath, ["--version"], { timeout: 5000 }, (_error, stdout) => {
				piBoltVersion = /\(Pi-Bolt ([^,)]+)/.exec(stdout)?.[1];
				requestRender?.();
			});
		}

		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		contextPaths = loadProjectContextFiles({ cwd: ctx.cwd, agentDir }).map(({ path }) => path);
		// Pi doesn't expose its loaded-extension list, so resolve the configured extensions the same way it does, without loading them.
		if (!extensionsChecked) {
			extensionsChecked = true;
			new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: SettingsManager.create(ctx.cwd, agentDir) })
				.resolve(async () => "skip")
				.then(({ extensions }) => {
					const trusted = ctx.isProjectTrusted();
					const names = extensions
						.filter(({ enabled, metadata }) => enabled && (trusted || metadata.scope !== "project"))
						.map(({ path, metadata }) => metadata.packageRoot ? basename(metadata.packageRoot) : parse(path).name === "index" ? basename(dirname(path)) : parse(path).name);
					extensionNames = [...new Set(names)].filter((name) => name !== "pi-guy");
					requestRender?.();
				}, () => {});
		}
		ctx.ui.setHeader((tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				invalidate() {},
				render(width: number): string[] {
					const logo = LOGO_GLYPHS[0]!.map((_, row) => `  ${LOGO_GLYPHS.map((glyph, letter) => theme.fg(LOGO_COLORS[letter]!, glyph[row]!)).join(" ")}`);
					const title = `${theme.bold("  π")}${theme.fg("dim", ` v${VERSION} · `)}${piBoltVersion ? `${theme.bold("pi-bolt")}${theme.fg("dim", ` v${piBoltVersion} · `)}` : ""}${theme.bold("pi-guy")}${theme.fg("dim", ` v${PACKAGE_VERSION}`)}`;
					const paths = [...new Set([...contextPaths, ...Array.from(reportedContextPaths.values()).flat()])];
					const agents = paths.length
						? ["  Context:", ...paths.map((path) => `    ${path.startsWith(`${homedir()}/`) ? `~/${path.slice(homedir().length + 1)}` : path}`)]
						: ["  Context: none"];
					const extensions = !extensionNames ? [] : extensionNames.length
						? [`  Extensions: ${extensionNames.join(" · ")}`]
						: ["  Extensions: none"];

					return [
						"",
						...logo.map((line) => truncateToWidth(line, width, "")),
						"",
						truncateToWidth(title, width),
						...[...extensions, ...agents].flatMap((line) => wrapTextWithAnsi(theme.fg("dim", line), Math.max(1, width)).map((line) => truncateToWidth(line, width, ""))),
						"",
					];
				},
			};
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		promptOptions = event.systemPromptOptions;
	});

	pi.on("agent_start", () => {
		if (!promptOptions) return;
		contextPaths = promptOptions.contextFiles.map(({ path }) => path);
		promptOptions = undefined;
		requestRender?.();
	});
}
