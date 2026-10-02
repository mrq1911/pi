import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { LINE_SINGLE } from "../src/experimental/vt420/cells.ts";
import { Charset } from "../src/experimental/vt420/charset.ts";
import { type Frame, Renderer } from "../src/experimental/vt420/renderer.ts";
import { charsetDesignations, SESSION_MODES } from "../src/experimental/vt420/sequences.ts";
import { type RenderContext, TranscriptBlock } from "../src/experimental/vt420/transcript.ts";
import { linesText, Vt420Emulator } from "./vt420-emulator.ts";

const WIDTH = 40;
const THINKING =
	"**Reading the footer**\n\nThe user wants the footer on the right.\nI will check footerCells, then the tests";

const charset = new Charset({ technical: true, supplemental: "dec", eightBit: false });

function context(showThinking = false): RenderContext {
	return {
		width: WIDTH,
		charset,
		cwd: "/work",
		home: "/home/user",
		showThinking,
		expandTools: false,
		largeHeadings: true,
		tick: 0,
		now: 0,
		key: () => "PF2",
	};
}

function reply(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function thinkingBlock(thinking: string, streaming: boolean): TranscriptBlock {
	return new TranscriptBlock(1, {
		kind: "assistant",
		message: reply([{ type: "thinking", thinking }]),
		streaming,
	});
}

describe("vt420 transcript thinking", () => {
	it("streams the latest thinking tokens on one line", () => {
		expect(linesText(thinkingBlock("", true).render(context()))).toEqual(["∴ thinking"]);
		expect(linesText(thinkingBlock(THINKING.slice(0, 30), true).render(context()))).toEqual([
			"∴ Reading the footer · The us",
		]);
		const lines = linesText(thinkingBlock(THINKING, true).render(context()));
		expect(lines).toEqual(["∴ ...l check footerCells, then the tests"]);
		expect(lines[0]).toHaveLength(WIDTH);
		const more = linesText(thinkingBlock(`${THINKING} pass`, true).render(context()));
		expect(more).toEqual(["∴ ...ck footerCells, then the tests pass"]);
	});

	it("settles on the start of the thinking once it is done", () => {
		const done = ["∴ Reading the footer · The user wants..."];
		expect(linesText(thinkingBlock(THINKING, false).render(context()))).toEqual(done);
		const answering = new TranscriptBlock(1, {
			kind: "assistant",
			message: reply([
				{ type: "thinking", thinking: THINKING },
				{ type: "text", text: "Done." },
			]),
			streaming: true,
		});
		expect(linesText(answering.render(context()))).toEqual([...done, "", "Done."]);
		const expanded = linesText(thinkingBlock(THINKING, false).render(context(true)));
		expect(expanded[0]).toBe("∴ **Reading the footer**");
		expect(expanded.length).toBeGreaterThan(3);
	});

	it("rolls live thinking up two rows on a DEC terminal, a smooth scroll for each line it fills", () => {
		const rolling = { ...context(), rollThinking: true };
		expect(linesText(thinkingBlock("", true).render(rolling))).toEqual(["∴ thinking", ""]);
		const renderer = new Renderer({
			rows: 4,
			columns: WIDTH,
			statusLine: false,
			rectangularOps: true,
			eraseCharacters: true,
			eightBit: false,
		});
		const emulator = new Vt420Emulator({ rows: 4, columns: WIDTH });
		emulator.feed(SESSION_MODES + charsetDesignations({ technical: true, supplemental: "dec", eightBit: false }));
		const words = `${THINKING} and then the renderer, and the emulator after it`.split(" ");
		let rolls = 0;
		for (let count = 1; count <= words.length; count++) {
			const lines = thinkingBlock(words.slice(0, count).join(" "), true).render(rolling);
			expect(lines).toHaveLength(2);
			const above = { cells: charset.cells("above"), attr: LINE_SINGLE } as const;
			const frame: Frame = {
				lines: [above, ...lines, { cells: [], attr: LINE_SINGLE }],
				scroll: { top: 0, bottom: 3 },
			};
			const bytes = renderer.render(frame);
			if (bytes.includes("\x1b[?4h\x1bD\x1b[?4l")) rolls++;
			emulator.feed(Buffer.from(bytes, "latin1"));
			expect([emulator.text(0), emulator.text(1), emulator.text(2)]).toEqual(["above", ...linesText(lines)]);
		}
		expect(rolls).toBeGreaterThan(1);
		// once done it settles on one line, as on emulators
		expect(linesText(thinkingBlock(THINKING, false).render(rolling))).toEqual(
			linesText(thinkingBlock(THINKING, false).render(context())),
		);
	});

	it("scrolls the ticker in the terminal with a few bytes per update", () => {
		const words = THINKING.split(" ");
		const send = (eraseCharacters: boolean): number => {
			const renderer = new Renderer({
				rows: 4,
				columns: WIDTH,
				statusLine: false,
				rectangularOps: true,
				eraseCharacters,
				eightBit: false,
			});
			const emulator = new Vt420Emulator({ rows: 4, columns: WIDTH });
			emulator.feed(SESSION_MODES + charsetDesignations({ technical: true, supplemental: "dec", eightBit: false }));
			let sent = 0;
			for (let count = 1; count <= words.length; count++) {
				const lines = thinkingBlock(words.slice(0, count).join(" "), true).render(context());
				const frame: Frame = { lines: [...lines, { cells: [], attr: LINE_SINGLE }], scroll: { top: 0, bottom: 3 } };
				const bytes = renderer.render(frame);
				emulator.feed(Buffer.from(bytes, "latin1"));
				expect(emulator.text(0)).toBe(linesText(lines)[0]);
				// once the line is full, every word scrolls it
				if (count > words.length - 4) sent += bytes.length;
			}
			return sent;
		};
		const shifted = send(true);
		expect(shifted).toBeLessThan(90);
		expect(shifted * 1.5).toBeLessThan(send(false));
	});
});
