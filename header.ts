/**
 * Installer-style Pi startup header.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProjectContextFiles, VERSION, type BeforeAgentStartEvent, type ExtensionAPI, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

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

		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		contextPaths = loadProjectContextFiles({ cwd: ctx.cwd, agentDir }).map(({ path }) => path);
		ctx.ui.setHeader((tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				invalidate() {},
				render(width: number): string[] {
					const logo = LOGO_GLYPHS[0]!.map((_, row) => `  ${LOGO_GLYPHS.map((glyph, letter) => theme.fg(LOGO_COLORS[letter]!, glyph[row]!)).join(" ")}`);
					const title = `${theme.bold("  π")}${theme.fg("dim", ` v${VERSION} · `)}${theme.bold("pi-guy")}${theme.fg("dim", ` v${PACKAGE_VERSION}`)}`;
					const paths = [...new Set([...contextPaths, ...Array.from(reportedContextPaths.values()).flat()])];
					const agents = theme.fg(
						"dim",
						`  Context: ${paths
							.map((path) => path.startsWith(`${homedir()}/`) ? `~/${path.slice(homedir().length + 1)}` : path)
							.join(" · ") || "none"}`,
					);

					return [
						"",
						...logo.map((line) => truncateToWidth(line, width, "")),
						"",
						truncateToWidth(title, width),
						...wrapTextWithAnsi(agents, Math.max(1, width)).map((line) => truncateToWidth(line, width, "")),
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
