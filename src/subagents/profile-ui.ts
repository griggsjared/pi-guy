import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { OFF_PROFILE_NAME, resolveAgentSettings, SESSION_PROFILE_NAME } from "./agents.ts";
import type { AgentConfig, SubagentSettings } from "./agents.ts";
import { PROFILE_ENTRY_TYPE } from "./constants.ts";

export interface ProfileCommandDeps {
  settings: SubagentSettings;
  discover: () => Promise<AgentConfig[]>;
  getActiveProfile: () => string | undefined;
  setActiveProfile: (name: string) => void;
  /** True while the session still needs a profile choice before subagents run. */
  needsConfirmation?: () => boolean;
  /** Themed usage text for a provider; undefined when the provider isn't tracked. */
  requestUsage?: (provider: string, theme: Theme) => Promise<string | undefined>;
}

export async function chooseProfile(
  pi: ExtensionAPI,
  profiles: ProfileCommandDeps,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const names = [OFF_PROFILE_NAME, ...Object.keys(profiles.settings.profiles).sort((left, right) =>
    Number(right === SESSION_PROFILE_NAME) - Number(left === SESSION_PROFILE_NAME))];
  const current = profiles.getActiveProfile();
  const agents = await profiles.discover();
  const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const name = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(`Subagent profile (active: ${current ?? "none"})`)), 0, 0));
    const input = new Input();
    container.addChild(input);
    const items = names.map((name) => {
      const label = name === SESSION_PROFILE_NAME ? `${name} (built-in)` : name === OFF_PROFILE_NAME ? `${name} (no subagents)` : name;
      return { value: name, label: name === current ? `${label} (active)` : label };
    });
    let previewName: string | undefined;
    let highlightedName: string | undefined;
    // null marks a pending request; each provider is requested once per picker open.
    const usage = new Map<string, string | undefined | null>();
    const providersFor = (profile: string) => profile === OFF_PROFILE_NAME ? [] : [...new Set(agents.flatMap((agent) => {
      const model = resolveAgentSettings(agent, profiles.settings, profile).model ?? parentModel;
      return model ? [model.split("/")[0]!] : [];
    }))];
    const details: Component = {
      render(width: number) {
        if (!previewName) return [];
        if (previewName === OFF_PROFILE_NAME) {
          return ["", theme.fg("dim", "Subagents are off. New launches are blocked."), ""].map((line) => truncateToWidth(line, width, "…"));
        }
        const rows = [
          ["Agent", "Model", "Thinking"],
          ...agents.map((agent) => {
            const resolved = resolveAgentSettings(agent, profiles.settings, previewName);
            return [
              agent.name,
              resolved.model ?? parentModel ?? "child default",
              resolved.thinkingLevel ?? ctx.thinkingLevel ?? "child default",
            ];
          }),
        ];
        const gap = width >= 25 ? "  " : " ";
        const available = Math.max(0, width - 2 * visibleWidth(gap));
        const thinkingWidth = Math.min(
          Math.max(...rows.map((row) => visibleWidth(row[2]!))),
          available >= 21 ? Math.max(8, Math.floor(available / 3)) : Math.floor(available / 3),
        );
        const agentWidth = Math.min(
          Math.max(...rows.map((row) => visibleWidth(row[0]!))),
          available >= 21 ? Math.max(8, Math.floor((available - thinkingWidth) / 3)) : Math.floor(available / 3),
        );
        const columnWidths = [
          agentWidth,
          Math.min(Math.max(...rows.map((row) => visibleWidth(row[1]!))), Math.max(0, available - agentWidth - thinkingWidth)),
          thinkingWidth,
        ];
        const usageRows = providersFor(previewName).flatMap((provider) => {
          const text = usage.get(provider);
          return text === undefined ? [] : [[provider, text ?? theme.fg("dim", "…")] as const];
        });
        const providerWidth = Math.max(0, ...usageRows.map(([provider]) => visibleWidth(provider)));
        return [
          "",
          theme.fg("accent", theme.bold(`Resolved settings: ${previewName}`)),
          ...rows.map((row, index) => {
            const line = row.map((cell, column) => {
              const cellWidth = columnWidths[column]!;
              const text = truncateToWidth(cell, cellWidth, "…");
              return text + " ".repeat(Math.max(0, cellWidth - visibleWidth(text)));
            }).join(gap).trimEnd();
            return index === 0
              ? theme.fg("muted", theme.bold(line))
              : theme.fg("dim", line);
          }),
          ...(agents.length === 0 ? [theme.fg("dim", "No agents discovered")] : []),
          ...(usageRows.length === 0 ? [] : [
            theme.fg("muted", theme.bold("Provider usage")),
            ...usageRows.map(([provider, text]) =>
              theme.fg("dim", provider + " ".repeat(providerWidth - visibleWidth(provider))) + gap + text),
          ]),
          "",
        ].map((line) => truncateToWidth(line, width, "…"));
      },
      invalidate() {},
    };
    let list: SelectList;
    const refilter = () => {
      const query = input.getValue();
      const filtered = fuzzyFilter(items, query, (item) => item.value);
      list = new SelectList(filtered, Math.min(names.length, 5), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelectionChange = (item) => {
        previewName = highlightedName = item.value;
        if (!profiles.requestUsage) return;
        for (const provider of providersFor(item.value)) {
          if (usage.has(provider)) continue;
          usage.set(provider, null);
          void profiles.requestUsage(provider, theme).catch(() => undefined).then((text) => {
            usage.set(provider, text);
            tui.requestRender();
          });
        }
      };
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      const index = filtered.findIndex((item) => item.value === (highlightedName ?? current ?? SESSION_PROFILE_NAME));
      list.setSelectedIndex(query ? 0 : index >= 0 ? index : names.indexOf(SESSION_PROFILE_NAME));
      const selected = list.getSelectedItem();
      if (selected) list.onSelectionChange(selected);
      else previewName = undefined;
    };
    refilter();
    container.addChild({
      render: (width: number) => list.getSelectedItem()
        ? list.render(width)
        : [truncateToWidth(theme.fg("warning", "  No matching profiles"), width, "…")],
      invalidate: () => list.invalidate(),
    });
    container.addChild(details);
    container.addChild(new Text(theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc cancel"), 0, 0));
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        const kb = getKeybindings();
        if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") ||
          kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
          list.handleInput(data);
        } else {
          const query = input.getValue();
          input.handleInput(data);
          if (query !== input.getValue()) refilter();
        }
        tui.requestRender();
      },
    };
  });
  if (!name) return undefined;
  if (name !== OFF_PROFILE_NAME && !Object.hasOwn(profiles.settings.profiles, name)) {
    if (ctx.hasUI) ctx.ui.notify(`Unknown subagent profile "${name}". Available: ${names.join(", ")}`, "error");
    return undefined;
  }
  profiles.setActiveProfile(name);
  pi.appendEntry(PROFILE_ENTRY_TYPE, { name });
  if (ctx.hasUI) ctx.ui.notify(name === OFF_PROFILE_NAME
    ? "Subagents turned off. New launches are blocked."
    : `Subagent profile switched to ${name}. New jobs will use it.`, "info");
  return name;
}

/**
 * Pauses a subagent launch for a profile choice when more than one profile is
 * configured and the session still needs one, such as on its first launch or
 * after the main model changes without a --subagent-profile flag. Returns false
 * when the user cancels.
 */
export async function confirmSubagentProfile(
  pi: ExtensionAPI,
  profiles: ProfileCommandDeps,
  ctx: ExtensionContext,
  onPause?: (message: string) => void,
): Promise<boolean> {
  const names = Object.keys(profiles.settings.profiles);
  if (names.length <= 1 || !profiles.needsConfirmation?.()) return true;
  if (ctx.mode !== "tui" || !ctx.hasUI) return true;
  onPause?.("Paused: waiting for subagent profile selection");
  return (await chooseProfile(pi, profiles, ctx)) !== undefined;
}
