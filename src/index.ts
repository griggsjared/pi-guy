import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import agentsLocal from "./agents-local/index.ts";
import askUser from "./ask-user/index.ts";
import btw from "./btw/index.ts";
import context from "./context/index.ts";
import githubPr from "./github-pr/index.ts";
import header from "./header/index.ts";
import { isFeatureEnabled } from "./lib/settings.ts";
import providerUsage from "./provider-usage/index.ts";
import statusline from "./statusline/index.ts";
import subagents from "./subagents/index.ts";
import webSearch from "./web-search/index.ts";
import workingIndicator from "./working-indicator/index.ts";

// Keys are pi-guy.json section names. Handlers for the same event run in this order.
const factories: Record<string, ExtensionFactory> = {
  statusline,
  "agents-local": agentsLocal,
  "ask-user": askUser,
  btw,
  context,
  "github-pr": githubPr,
  header,
  "web-search": webSearch,
  "provider-usage": providerUsage,
  subagents,
  "working-indicator": workingIndicator,
};

export default async function (pi: ExtensionAPI) {
  const entries = Object.entries(factories);
  const enabled = await Promise.all(entries.map(([key]) => isFeatureEnabled(key)));
  for (const [index, [, factory]] of entries.entries()) if (enabled[index]) await factory(pi);
}
