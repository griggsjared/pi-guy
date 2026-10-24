import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentsLocal from "../agents-local.ts";
import askUser from "../ask-user.ts";
import btw from "../btw.ts";
import githubPr from "../github-pr.ts";
import header from "../header.ts";
import statusline from "../statusline/index.ts";
import subagents from "../subagents/index.ts";
import webSearch from "../web-search.ts";
import workingIndicator from "../working-indicator/index.ts";

// Handlers for the same event run in this order.
const features = [agentsLocal, askUser, btw, githubPr, header, webSearch, statusline, subagents, workingIndicator];

export default async function (pi: ExtensionAPI) {
	for (const feature of features) await feature(pi);
}
