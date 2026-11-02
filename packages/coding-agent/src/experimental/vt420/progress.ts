/**
 * Keeps the model telling the user what it is doing: left to themselves, local models narrate only in thinking,
 * which pi-vt420 rolls by and folds away. A rule in the system prompt says so, and since small models forget a rule
 * that far back, notes at the end of the request repeat it where they decide what to do next: a note on the prompt
 * until the first reply, and one on the latest tool result once replies have gone without a word for a while. Only
 * that request carries a note; the session and the transcript never see it.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "../../core/extensions/index.ts";

export const PROGRESS_RULE =
	"During multi-step work, write one short plain-text sentence to the user when you start something new, find something, or change plan. Don't go more than a few tool calls without one.";

export const START_NOTE = "Before any tool call, tell the user in a sentence or two what you are going to do.";

/** Replies with tool calls and no text in a row, after which each request carries the quiet note. */
export const QUIET_REPLIES = 3;

export function quietNote(replies: number): string {
	return `The user has seen nothing from you for ${replies} replies. Before your next tool call, tell them in one sentence what you found and what you are doing next.`;
}

export default function progressExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.promptGuidelines.push(PROGRESS_RULE);
	});
	pi.on("context", (event) => {
		const note = noteFor(event.messages);
		if (!note) return undefined;
		const last = event.messages.at(-1);
		if (last?.role !== "user" && last?.role !== "custom" && last?.role !== "toolResult") return undefined;
		const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
		const noted = { ...last, content: [...content, { type: "text" as const, text: `<reminder>${note}</reminder>` }] };
		return { messages: [...event.messages.slice(0, -1), noted] };
	});
}

function noteFor(messages: readonly AgentMessage[]): string | undefined {
	let quiet = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "user") {
			// nothing said or called since the prompt: the run's first request
			if (quiet === 0) return START_NOTE;
			break;
		}
		if (message.role !== "assistant") continue;
		if (message.content.some((part) => part.type === "text" && part.text.trim())) break;
		if (message.content.some((part) => part.type === "toolCall")) quiet++;
	}
	return quiet >= QUIET_REPLIES ? quietNote(quiet) : undefined;
}
