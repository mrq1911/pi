import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SpeedMeter } from "../src/experimental/vt420/speed.ts";
import { formatAge, formatDuration } from "../src/experimental/vt420/text.ts";

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

describe("vt420 durations", () => {
	it("counts seconds, then minutes and seconds, then hours and minutes", () => {
		expect([0, 45, 59.9, 60, 187, 3599, 3600, 6000, 90_061].map(formatDuration)).toEqual([
			"0s",
			"45s",
			"59s",
			"1m 00s",
			"3m 07s",
			"59m 59s",
			"1h 00m",
			"1h 40m",
			"25h 01m",
		]);
	});
});

describe("vt420 ages", () => {
	it("says how long ago in words, by the calendar from yesterday on", () => {
		const now = new Date(2026, 9, 6, 10, 30);
		const ago = (minutes: number): string => formatAge(new Date(now.getTime() - minutes * 60_000), now);
		expect([0.5, 5, 59, 60, 150, 10 * 60].map(ago)).toEqual([
			"just now",
			"5 min ago",
			"59 min ago",
			"an hour ago",
			"2 hours ago",
			"10 hours ago",
		]);
		// under a day counts in hours, across midnight too; then days by the calendar
		expect(formatAge(new Date(2026, 9, 5, 23, 50), new Date(2026, 9, 6, 23, 0))).toBe("23 hours ago");
		expect(formatAge(new Date(2026, 9, 5, 9, 0), now)).toBe("yesterday");
		expect(formatAge(new Date(2026, 9, 3, 9, 0), now)).toBe("3 days ago");
		expect(formatAge(new Date(2026, 8, 28, 9, 0), now)).toBe("a week ago");
		expect(formatAge(new Date(2026, 6, 1), now)).toBe("3 months ago");
		expect(formatAge(new Date(2024, 9, 1), now)).toBe("2 years ago");
	});
});
