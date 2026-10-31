import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export function captureTools(feature: (pi: ExtensionAPI) => unknown): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  feature({
    registerTool: (definition: ToolDefinition) => {
      tools.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI);
  return tools;
}

export function captureHandlers() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const on = (event: string, handler: (event: any, ctx: any) => any) => {
    const registered = handlers.get(event) ?? [];
    registered.push(handler);
    handlers.set(event, registered);
  };
  return { handlers, on };
}

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

export function captureCommands() {
  const commands = new Map<string, Command>();
  const registerCommand = (name: string, command: Command) => {
    commands.set(name, command);
  };
  return { commands, registerCommand };
}
