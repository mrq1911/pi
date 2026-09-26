import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SpeedMeter } from "../src/experimental/vt420/speed.ts";

function reply(text: string, output = 0, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

describe("vt420 speed meter", () => {
	it("estimates while streaming and measures from the first token to the end", () => {
		const meter = new SpeedMeter();
		meter.start();
		meter.update(reply(""), 0);
		meter.update(reply("x".repeat(40)), 1000);
		expect(meter.display).toBeUndefined();
		meter.update(reply("x".repeat(400)), 2000);
		expect(meter.display).toEqual({ rate: 100, approximate: true });
		meter.update(reply("x".repeat(800)), 2500);
		expect(meter.display?.rate).toBe(100);
		meter.finish(reply("x".repeat(800), 250), 3500);
		expect(meter.display).toEqual({ rate: 100, approximate: false });
		expect(meter.last).toBe(100);
	});

	it("keeps the last measurement over aborted and instant replies", () => {
		const meter = new SpeedMeter();
		meter.start();
		meter.update(reply("x".repeat(100)), 0);
		meter.finish(reply("x".repeat(100), 50), 2000);
		expect(meter.last).toBe(25);
		meter.start();
		meter.update(reply("x".repeat(100)), 5000);
		meter.finish(reply("x".repeat(100), 50, "aborted"), 6000);
		meter.start();
		meter.update(reply("x"), 7000);
		meter.finish(reply("x", 1), 7010);
		expect(meter.display).toEqual({ rate: 25, approximate: false });
	});
});
