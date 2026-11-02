import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type FauxContentBlock,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import progressExtension, {
	PROGRESS_RULE,
	QUIET_REPLIES,
	quietNote,
	START_NOTE,
} from "../src/experimental/vt420/progress.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const look: AgentTool = {
	name: "look",
	label: "look",
	description: "Look at something",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "seen" }], details: {} }),
};

describe("vt420 progress notes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("puts the rule among the prompt's rules, once however many runs", async () => {
		const harness = await createHarness({ extensionFactories: [progressExtension] });
		harnesses.push(harness);
		const prompts: string[] = [];
		const respond: FauxResponseFactory = (context) => {
			prompts.push(
				context.messages
					.flatMap((message) => (message.role === "system" ? [getSystemMessageText(message)] : []))
					.join("\n"),
			);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([respond, respond]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		expect(prompts[0].match(/<rules>\n([\s\S]*?)\n<\/rules>/)?.[1]).toContain(`- ${PROGRESS_RULE}`);
		expect(prompts[1].split(PROGRESS_RULE)).toHaveLength(2);
	});

	it("notes the prompt until the first reply, and the latest result once replies go quiet", async () => {
		const harness = await createHarness({ extensionFactories: [progressExtension], tools: [look] });
		harnesses.push(harness);
		const notes: (string | undefined)[] = [];
		const reply =
			(content: FauxContentBlock[]): FauxResponseFactory =>
			(context) => {
				const last = context.messages.at(-1);
				const sent = last && "content" in last && Array.isArray(last.content) ? last.content : [];
				const text = sent.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
				notes.push(text.match(/<reminder>(.*)<\/reminder>$/)?.[1]);
				return fauxAssistantMessage(content, {
					stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
				});
			};
		const call = fauxToolCall("look", {});
		harness.setResponses([
			reply([call]),
			reply([call]),
			reply([call]),
			reply([call]),
			reply([fauxText("found it, checking one more"), call]),
			reply([call]),
			reply([fauxText("done")]),
		]);
		await harness.session.prompt("go");
		expect(notes).toEqual([
			START_NOTE,
			undefined,
			undefined,
			quietNote(QUIET_REPLIES),
			quietNote(QUIET_REPLIES + 1),
			undefined,
			undefined,
		]);
		// the request alone carries them
		expect(JSON.stringify(harness.session.messages)).not.toContain("<reminder>");
	});
});
