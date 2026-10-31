import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import agentsLocal from "./agents-local/index.ts";
import askUser from "./ask-user/index.ts";
import btw from "./btw/index.ts";
import context from "./context/index.ts";
import githubPr from "./github-pr/index.ts";
import header from "./header/index.ts";
import statusline from "./statusline/index.ts";
import subagents from "./subagents/index.ts";
import webSearch from "./web-search/index.ts";
import workingIndicator from "./working-indicator/index.ts";

// Handlers for the same event run in this order.
const factories: ExtensionFactory[] = [agentsLocal, askUser, btw, context, githubPr, header, webSearch, statusline, subagents, workingIndicator];

export default async function (pi: ExtensionAPI) {
  for (const factory of factories) await factory(pi);
}
