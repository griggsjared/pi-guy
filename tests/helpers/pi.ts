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
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const on = (event: string, handler: (event: any, ctx: any) => any) => {
    handlers.set(event, handler);
  };
  return { handlers, on };
}
