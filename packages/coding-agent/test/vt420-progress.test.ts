import { type FauxResponseFactory, fauxAssistantMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import progressExtension, { PROGRESS_RULE } from "../src/experimental/vt420/progress.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("vt420 progress rule", () => {
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
});
