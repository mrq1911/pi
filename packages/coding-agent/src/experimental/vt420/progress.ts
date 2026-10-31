/**
 * A rule in every run's system prompt that keeps the model saying what it is doing between tool calls: left to
 * themselves, local models narrate only in thinking, which pi-vt420 rolls by and folds away.
 */

import type { ExtensionAPI } from "../../core/extensions/index.ts";

export const PROGRESS_RULE =
	"During multi-step work, write one short plain-text sentence to the user when you start something new, find something, or change plan. Don't go more than a few tool calls without one.";

export default function progressExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.promptGuidelines.push(PROGRESS_RULE);
	});
}
