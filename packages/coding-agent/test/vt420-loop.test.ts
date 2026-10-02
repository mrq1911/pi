import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import loopExtension, { formatInterval, parseInterval } from "../src/experimental/vt420/extensions/loop.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("/loop", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reads intervals with a unit, so a prompt that starts with a number stays a prompt", () => {
		expect([parseInterval("30s"), parseInterval("5m"), parseInterval("1h30m"), parseInterval("2h")]).toEqual([
			30_000, 300_000, 5_400_000, 7_200_000,
		]);
		expect([parseInterval("5"), parseInterval("three"), parseInterval("0m")]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		expect([formatInterval(30_000), formatInterval(300_000), formatInterval(5_400_000)]).toEqual([
			"30s",
			"5m",
			"1h30m",
		]);
	});

	it("runs again as each run ends until the model ends it, with its tool only active meanwhile", async () => {
		const harness = await createHarness({ extensionFactories: [{ factory: loopExtension }] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("loop_next", { delaySeconds: 0 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("first pass"),
			fauxAssistantMessage([fauxToolCall("loop_next", { stop: true, reason: "all green" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("second pass"),
		]);
		await harness.session.prompt("/loop keep the tests green");
		expect(harness.session.getActiveToolNames()).toContain("loop_next");
		await settle(2500);
		expect(getUserTexts(harness)).toEqual(["keep the tests green", "keep the tests green"]);
		expect(harness.session.getActiveToolNames()).not.toContain("loop_next");
	});

	it("runs on an interval until /loop stop", async () => {
		const harness = await createHarness({ extensionFactories: [{ factory: loopExtension }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("pong"), fauxAssistantMessage("pong"), fauxAssistantMessage("pong")]);
		await harness.session.prompt("/loop 1s ping");
		await settle(1500);
		expect(getUserTexts(harness)).toEqual(["ping", "ping"]);
		await harness.session.prompt("/loop stop");
		await settle(1200);
		expect(getUserTexts(harness)).toEqual(["ping", "ping"]);
	});
});
