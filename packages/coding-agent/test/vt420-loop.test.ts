import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import loopExtension, {
	formatElapsed,
	formatInterval,
	parseInterval,
} from "../src/experimental/vt420/extensions/loop.ts";
import renameExtension from "../src/experimental/vt420/extensions/rename.ts";
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

	it("takes days too, and says them", () => {
		expect([parseInterval("1d"), parseInterval("2d12h"), parseInterval("1d30m")]).toEqual([
			86_400_000, 216_000_000, 88_200_000,
		]);
		expect([formatInterval(86_400_000), formatInterval(216_000_000), formatInterval(88_200_000)]).toEqual([
			"1d",
			"2d12h",
			"1d",
		]);
		expect([formatElapsed(5_400_000), formatElapsed(86_400_000), formatElapsed(183_600_000)]).toEqual([
			"1h 30m",
			"1d",
			"2d 03h",
		]);
	});

	it("waits out intervals of days, beyond the 25 days setTimeout can wait", async () => {
		const harness = await createHarness({ extensionFactories: [{ factory: loopExtension }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("pong"), fauxAssistantMessage("pong")]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const started = harness.session.prompt("/loop 30d ping");
			await vi.advanceTimersByTimeAsync(1000);
			await started;
			expect(getUserTexts(harness)).toEqual(["ping"]);
			await vi.advanceTimersByTimeAsync(30 * 86_400_000 - 120_000);
			expect(getUserTexts(harness)).toEqual(["ping"]);
			await vi.advanceTimersByTimeAsync(180_000);
			expect(getUserTexts(harness)).toEqual(["ping", "ping"]);
			await harness.session.prompt("/loop stop");
		} finally {
			vi.useRealTimers();
		}
	});

	it("makes one run for the days a sleeping machine missed, and keeps its time of day", async () => {
		const harness = await createHarness({ extensionFactories: [{ factory: loopExtension }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("pong"), fauxAssistantMessage("pong"), fauxAssistantMessage("pong")]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const began = Date.now();
			const started = harness.session.prompt("/loop 1d ping");
			await vi.advanceTimersByTimeAsync(1000);
			await started;
			// asleep for three days and a bit: the wall clock moves on, timers do not
			vi.setSystemTime(began + 3 * 86_400_000 + 3_600_000);
			await vi.advanceTimersByTimeAsync(61_000);
			expect(getUserTexts(harness)).toEqual(["ping", "ping"]);
			// the next one on the old beat, four days after the start
			await vi.advanceTimersByTimeAsync(began + 4 * 86_400_000 - Date.now() - 120_000);
			expect(getUserTexts(harness)).toEqual(["ping", "ping"]);
			await vi.advanceTimersByTimeAsync(180_000);
			expect(getUserTexts(harness)).toEqual(["ping", "ping", "ping"]);
			await harness.session.prompt("/loop stop");
		} finally {
			vi.useRealTimers();
		}
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

	it("tells each run it is part of a self-paced loop, and ends the loop when a run does not pace it", async () => {
		const harness = await createHarness({ extensionFactories: [{ factory: loopExtension }] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("did it, said nothing about the next run"),
			fauxAssistantMessage("again"),
		]);
		await harness.session.prompt("/loop keep the tests green");
		await settle(2500);
		// one run only, rather than another every second
		expect(getUserTexts(harness)).toEqual(["keep the tests green"]);
		expect(harness.session.getActiveToolNames()).not.toContain("loop_next");
		const notes = harness.session.messages.filter(
			(message) => message.role === "custom" && "customType" in message && message.customType === "loop",
		);
		expect(notes).toHaveLength(1);
		expect(JSON.stringify(notes[0])).toContain("run 1 of a self-paced /loop");
		expect(JSON.stringify(notes[0])).toContain("loop_next");
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

	it("renames the session with /rename, as /name does", async () => {
		const harness = await createHarness({ extensionFactories: [{ factory: renameExtension }] });
		harnesses.push(harness);
		await harness.session.prompt("/rename vt420 work");
		expect(harness.session.sessionName).toBe("vt420 work");
	});
});
