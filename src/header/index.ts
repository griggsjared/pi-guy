import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, getAgentDir, loadProjectContextFiles, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent, ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CONTEXT_FILES_EVENT } from "../lib/events.ts";
import type { ContextFilesEvent } from "../lib/events.ts";

const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));
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
  let packageVersion = PACKAGE_VERSION;
  let packageVersionChecked = false;
  let packageVersionAbort: AbortController | undefined;
  let piBoltVersion: string | undefined;
  let piBoltChecked = false;
  let piBoltAbort: AbortController | undefined;
  let extensionNames: string[] | undefined;
  let extensionsChecked = false;
  const reportedContextPaths = new Map<string, string[]>();

  pi.events.on(CONTEXT_FILES_EVENT, (data) => {
    const { source, paths } = data as ContextFilesEvent;
    reportedContextPaths.set(source, paths);
    requestRender?.();
  });

  pi.on("session_start", (_event, ctx) => {
    contextPaths = [];
    promptOptions = undefined;
    requestRender = undefined;
    if (ctx.mode !== "tui") return;

    if (!packageVersionChecked) {
      packageVersionChecked = true;
      packageVersionAbort = new AbortController();
      const { signal } = packageVersionAbort;
      void (async () => {
        try {
          const options = { cwd: PACKAGE_DIR, timeout: 5000, signal };
          const repo = await pi.exec("git", ["rev-parse", "--show-toplevel", "--short", "HEAD"], options);
          if (repo.code !== 0 || repo.killed || signal.aborted) return;
          const [root, hash] = repo.stdout.trim().split("\n");
          if (!root || !hash || !/^[0-9a-f]+$/i.test(hash) || realpathSync(root) !== realpathSync(PACKAGE_DIR)) return;
          const tag = await pi.exec("git", ["tag", "--points-at", hash, "--list", `v${PACKAGE_VERSION}`], options);
          if (tag.code !== 0 || tag.killed || signal.aborted) return;
          return tag.stdout.trim().split("\n").includes(`v${PACKAGE_VERSION}`) ? PACKAGE_VERSION : `${PACKAGE_VERSION}-${hash}`;
        } catch {}
      })().then((version) => {
        if (!version || signal.aborted) return;
        packageVersion = version;
        requestRender?.();
      });
    }

    // Pi-Bolt is a Bun-compiled build that exposes its own version only through --version; extensions see Pi's VERSION.
    if (!piBoltChecked && process.versions.bun) {
      piBoltChecked = true;
      piBoltAbort = new AbortController();
      const { signal } = piBoltAbort;
      pi.exec(process.execPath, ["--version"], { timeout: 5000, signal }).then((result) => {
        if (result.code !== 0 || result.killed || signal.aborted) return;
        piBoltVersion = /\(Pi-Bolt ([^,)]+)/.exec(result.stdout)?.[1];
        requestRender?.();
      }, () => {});
    }

    const agentDir = getAgentDir();
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
          const title = `${theme.bold("  pi")}${theme.fg("dim", ` v${VERSION} · `)}${piBoltVersion ? `${theme.bold("pi-bolt")}${theme.fg("dim", ` v${piBoltVersion} · `)}` : ""}${theme.bold("pi-guy")}${theme.fg("dim", ` v${packageVersion}`)}`;
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

  pi.on("session_shutdown", () => {
    packageVersionAbort?.abort();
    piBoltAbort?.abort();
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
