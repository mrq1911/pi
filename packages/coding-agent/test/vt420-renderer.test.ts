import { describe, expect, it } from "vitest";
import {
	ATTR_BLINK,
	ATTR_BOLD,
	ATTR_REVERSE,
	ATTR_UNDERLINE,
	cellCode,
	cellSet,
	LINE_DOUBLE_BOTTOM,
	LINE_DOUBLE_TOP,
	LINE_DOUBLE_WIDTH,
	LINE_SINGLE,
	type Line,
	type LineAttr,
	lineWidth,
} from "../src/experimental/vt420/cells.ts";
import { Charset, cellToUnicode, type SupplementalSet } from "../src/experimental/vt420/charset.ts";
import { type Frame, Renderer, type RendererOptions } from "../src/experimental/vt420/renderer.ts";
import { charsetDesignations, SESSION_MODES, statusLineType } from "../src/experimental/vt420/sequences.ts";
import { EMU_BLINK, EMU_BOLD, EMU_REVERSE, EMU_UNDERLINE, Vt420Emulator } from "./vt420-emulator.ts";

const ROWS = 12;
const COLUMNS = 40;

interface Setup {
	charset: Charset;
	renderer: Renderer;
	emulator: Vt420Emulator;
	supplemental: SupplementalSet;
	draw(frame: Frame): string;
}

function setup(
	options: Partial<RendererOptions> & {
		supplemental?: SupplementalSet;
		statusState?: "separate" | "inherit" | "isolated";
	} = {},
): Setup {
	const unicode = options.unicode ?? false;
	const supplemental = unicode ? "latin1" : (options.supplemental ?? "dec");
	const eightBit = options.eightBit ?? false;
	const statusLine = options.statusLine ?? false;
	const charset = new Charset({ technical: true, supplemental, eightBit });
	const renderer = new Renderer({
		rows: ROWS,
		columns: COLUMNS,
		statusLine,
		rectangularOps: options.rectangularOps ?? true,
		eraseCharacters: options.eraseCharacters ?? true,
		eightBit,
		unicode,
		doubleSize: options.doubleSize,
		designations: charsetDesignations({ technical: true, supplemental, eightBit }),
	});
	const emulator = new Vt420Emulator({
		rows: ROWS,
		columns: COLUMNS,
		statusState: options.statusState,
		utf8: unicode,
		lineAttributes: options.doubleSize !== false,
	});
	emulator.feed(SESSION_MODES + charsetDesignations({ technical: true, supplemental, eightBit }));
	if (statusLine) emulator.feed(statusLineType(2));
	return {
		charset,
		renderer,
		emulator,
		supplemental,
		draw(frame) {
			const bytes = renderer.render(frame);
			emulator.feed(Buffer.from(bytes, unicode ? "utf8" : "latin1"));
			return bytes;
		},
	};
}

function frameOf(charset: Charset, rows: Array<string | Line>, extra: Partial<Frame> = {}): Frame {
	const lines: Line[] = [];
	for (let row = 0; row < ROWS; row++) {
		const value = rows[row];
		lines.push(
			typeof value === "string"
				? { cells: charset.cells(value), attr: LINE_SINGLE }
				: (value ?? { cells: [], attr: LINE_SINGLE }),
		);
	}
	return { lines, scroll: { top: 0, bottom: ROWS - 1 }, ...extra };
}

function expectedText(line: Line, supplemental: SupplementalSet): string {
	const width = lineWidth(line.attr, COLUMNS);
	return line.cells
		.slice(0, width)
		.map((cell) => cellToUnicode(cellSet(cell), cellCode(cell), supplemental))
		.join("")
		.replace(/\s+$/u, "");
}

function emulatorAttrs(cell: number): number {
	let attrs = 0;
	if (cell & ATTR_BOLD) attrs |= EMU_BOLD;
	if (cell & ATTR_UNDERLINE) attrs |= EMU_UNDERLINE;
	if (cell & ATTR_BLINK) attrs |= EMU_BLINK;
	if (cell & ATTR_REVERSE) attrs |= EMU_REVERSE;
	return attrs;
}

function expectScreen(s: Setup, frame: Frame): void {
	for (let row = 0; row < ROWS; row++) {
		const line = frame.lines[row]!;
		expect(s.emulator.lineAttr(row), `line attribute of row ${row}`).toBe(line.attr);
		expect(s.emulator.text(row), `text of row ${row}`).toBe(expectedText(line, s.supplemental));
		const width = lineWidth(line.attr, COLUMNS);
		for (let col = 0; col < Math.min(width, line.cells.length); col++) {
			expect(s.emulator.attrsAt(row, col), `attributes at ${row}:${col}`).toBe(emulatorAttrs(line.cells[col]!));
		}
	}
	if (frame.cursor) {
		expect({ row: s.emulator.row, col: s.emulator.col }).toEqual(frame.cursor);
		expect(s.emulator.cursorVisible).toBe(true);
	} else {
		expect(s.emulator.cursorVisible).toBe(false);
	}
}

describe("vt420 renderer", () => {
	it("draws ASCII, DEC Special Graphics, DEC Technical and supplemental glyphs", () => {
		const s = setup();
		const frame = frameOf(s.charset, [
			"┌──────┐ π ≤ ≥ ≠ £ · ◆ ▒",
			"│ café │ Straße Œuvre",
			"└──────┘ Σ ∫ √ → ← ↑ ↓ α β Δ",
			"",
			"plain text again",
		]);
		s.draw(frame);
		expectScreen(s, frame);
		expect(s.emulator.text(0)).toBe("┌──────┐ π ≤ ≥ ≠ £ · ◆ ▒");
		expect(s.emulator.text(2)).toBe("└──────┘ Σ ∫ √ → ← ↑ ↓ α β Δ");
	});

	it("never emits bytes outside 7-bit printable range and controls in 7-bit mode", () => {
		const s = setup();
		const bytes = s.draw(frameOf(s.charset, ["café Σ π ─── ümlaut ñ"]));
		for (const char of bytes) expect(char.charCodeAt(0)).toBeLessThan(0x80);
	});

	it("uses GR bytes for supplemental glyphs in 8-bit mode", () => {
		const s = setup({ eightBit: true, supplemental: "latin1" });
		const frame = frameOf(s.charset, ["naïve façade × ÷ ý"]);
		const bytes = s.draw(frame);
		expect(bytes).toContain("\xef");
		expectScreen(s, frame);
	});

	it("sends Unicode without shifts to a terminal that decodes UTF-8", () => {
		const s = setup({ unicode: true, statusLine: true });
		const frame = frameOf(s.charset, ["┌──┐ π → Σ café", "│ok│ ≤ ◆ ▒"], {
			status: s.charset.cells(" π · medium · ↑12k ↓1.2k · Σ$0.012", ATTR_REVERSE),
		});
		const bytes = s.draw(frame);
		expect(bytes).toContain("┌──┐ π → Σ café");
		expect(bytes).toContain("↑12k ↓1.2k · Σ$0.012");
		expect(bytes).not.toMatch(/\x0e|\x1b[NOno]/);
		expectScreen(s, frame);
		expect(s.emulator.statusText()).toBe(" π · medium · ↑12k ↓1.2k · Σ$0.012");
	});

	it("uses a single shift for an isolated technical glyph and a locking shift for runs", () => {
		const s = setup();
		const single = s.draw(frameOf(s.charset, ["a→b"]));
		expect(single).toContain("a\x1bN}b");
		const run = s.draw(frameOf(s.charset, ["αβγ"]));
		expect(run).toContain("\x1bnabg");
	});

	it("stays in DEC Special Graphics for ASCII codes it shares", () => {
		const s = setup();
		const bytes = s.draw(frameOf(s.charset, ["─ OK ─"]));
		expect(bytes).toContain("\x0eq OK q");
	});

	it("renders attributes and switches them with minimal SGR", () => {
		const s = setup();
		const cells = [
			...s.charset.cells("bold", ATTR_BOLD),
			...s.charset.cells(" "),
			...s.charset.cells("rev", ATTR_REVERSE | ATTR_UNDERLINE),
			...s.charset.cells("blink", ATTR_BLINK),
		];
		const frame = frameOf(s.charset, [{ cells, attr: LINE_SINGLE }]);
		s.draw(frame);
		expectScreen(s, frame);
	});

	it("updates a single changed cell with a few bytes", () => {
		const s = setup();
		s.draw(frameOf(s.charset, ["hello world", "second line"], { cursor: { row: 5, col: 0 } }));
		const update = frameOf(s.charset, ["hello World", "second line"], { cursor: { row: 5, col: 0 } });
		const bytes = s.draw(update);
		expect(bytes.length).toBeLessThanOrEqual(16);
		expectScreen(s, update);
	});

	it("moves text that scrolled left with DCH and writes only the new tail", () => {
		const text = "the model weighs the footer, then the ticker, then the terminal it runs on";
		const ticker = (end: number): string => `∴ ...${text.slice(end - 34, end)}`;
		const s = setup();
		s.draw(frameOf(s.charset, ["above", ticker(40)]));
		const next = frameOf(s.charset, ["above", ticker(46)]);
		const bytes = s.draw(next);
		expect(bytes).toContain("\x1b[6P");
		expect(bytes.length).toBeLessThan(24);
		expectScreen(s, next);
		const reverse = frameOf(s.charset, [
			"above",
			{ cells: s.charset.cells(ticker(52), ATTR_REVERSE), attr: LINE_SINGLE },
		]);
		s.draw(reverse);
		expectScreen(s, reverse);
		const plain = setup({ eraseCharacters: false });
		plain.draw(frameOf(plain.charset, ["above", ticker(40)]));
		const redrawn = plain.draw(next);
		expect(redrawn).not.toContain("P");
		expect(redrawn.length).toBeGreaterThan(30);
		expectScreen(plain, next);
	});

	it("scrolls the region in hardware when the transcript moves up", () => {
		const s = setup();
		const lines = Array.from({ length: 30 }, (_, index) => `transcript line ${index} with some text`);
		const region = { top: 0, bottom: 8 };
		s.draw(frameOf(s.charset, [...lines.slice(0, 9), "", "status", "editor"], { scroll: region }));
		const next = frameOf(s.charset, [...lines.slice(2, 11), "", "status", "editor"], { scroll: region });
		const bytes = s.draw(next);
		expect(bytes).toContain("\x1bD\x1bD");
		expect(bytes.length).toBeLessThan(120);
		expectScreen(s, next);
		const back = frameOf(s.charset, [...lines.slice(1, 10), "", "status", "editor"], { scroll: region });
		expect(s.draw(back)).toContain("\x1bM");
		expectScreen(s, back);
	});

	it("letter-spaces double-size lines for a terminal that ignores them", () => {
		const s = setup({ doubleSize: false, unicode: true });
		const pi = s.charset.cells(" π", ATTR_BOLD);
		const keys = [...s.charset.cells("        "), ...s.charset.cells("Keys", ATTR_BOLD | ATTR_UNDERLINE)];
		const bytes = s.draw(
			frameOf(s.charset, [
				{ cells: pi, attr: LINE_DOUBLE_TOP },
				{ cells: pi, attr: LINE_DOUBLE_BOTTOM },
				{ cells: keys, attr: LINE_DOUBLE_WIDTH },
				"plain text",
			]),
		);
		expect(bytes).not.toContain("\x1b#");
		expect(s.emulator.screen().slice(0, 4)).toEqual(["  π", "", `${" ".repeat(16)}K e y s`, "plain text"]);
		// the space after a character keeps its rendition, as the right half of a double-width cell would
		expect(s.emulator.attrsAt(2, 17)).toBe(EMU_BOLD | EMU_UNDERLINE);
		expect(s.emulator.attrsAt(0, 3)).toBe(EMU_BOLD);
		// a bottom half left at the top of a scrolled view carries the text itself
		s.draw(
			frameOf(s.charset, [
				{ cells: pi, attr: LINE_DOUBLE_BOTTOM },
				{ cells: keys, attr: LINE_SINGLE },
			]),
		);
		expect(s.emulator.screen().slice(0, 2)).toEqual(["  π", "        Keys"]);
	});

	it("draws double-width and double-height lines", () => {
		const s = setup();
		const title = s.charset.cells("π pi", ATTR_BOLD);
		const frame = frameOf(s.charset, [
			{ cells: title, attr: LINE_DOUBLE_TOP },
			{ cells: title, attr: LINE_DOUBLE_BOTTOM },
			{ cells: s.charset.cells("Heading"), attr: LINE_DOUBLE_WIDTH },
			"normal",
		]);
		s.draw(frame);
		expectScreen(s, frame);
		const back = frameOf(s.charset, ["single again", "x", "y", "normal"]);
		s.draw(back);
		expectScreen(s, back);
	});

	it("writes the host status line without disturbing the main display", () => {
		const s = setup({ statusLine: true });
		const status = s.charset.cells(" π model · ↑1.2k ↓300 · Σ$0.01", ATTR_REVERSE);
		const frame = frameOf(s.charset, ["main"], { status, cursor: { row: 3, col: 2 } });
		s.draw(frame);
		expectScreen(s, frame);
		expect(s.emulator.statusText()).toBe(" π model · ↑1.2k ↓300 · Σ$0.01");
		const next = frameOf(s.charset, ["main"], {
			status: s.charset.cells(" π model · ↑1.3k", ATTR_REVERSE),
			cursor: { row: 3, col: 2 },
		});
		s.draw(next);
		expect(s.emulator.statusText()).toBe(" π model · ↑1.3k");
		expectScreen(s, next);
	});

	it("restates rendition and shifts after every status line update", () => {
		// Leaving the status line restores the main display's saved SGR and GL, so tracked state is stale there.
		for (const statusState of ["separate", "inherit", "isolated"] as const) {
			const s = setup({ statusLine: true, statusState });
			const updates = [
				["hello", "↑968 ↓66", "0.000"],
				["hello world", "↑1.9k ↓134", "0.012"],
				["hello world, again", "↑2.4k ↓201 R12k", "0.031"],
			];
			for (const [text, tokens, cost] of updates) {
				const footer = ` π · medium · ${tokens} · Σ$${cost}`;
				const frame = frameOf(s.charset, ["── ◆ Working ⎻ 3s ──", text!, "π typed"], {
					status: s.charset.cells(footer, ATTR_REVERSE),
					cursor: { row: 2, col: 7 },
				});
				s.draw(frame);
				expect(s.emulator.statusText(), statusState).toBe(footer);
				expectScreen(s, frame);
			}
		}
	});

	it("fills long runs with DECFRA and erases blank runs with ECH", () => {
		const s = setup();
		const rule = "─".repeat(COLUMNS);
		const bytes = s.draw(frameOf(s.charset, [rule, `x${" ".repeat(20)}y`]));
		expect(bytes).toContain("$x");
		expect(s.emulator.text(0)).toBe(rule);
		const erase = frameOf(s.charset, [rule, `x${" ".repeat(20)}y`, "a long line of text that will be erased"]);
		s.draw(erase);
		const after = frameOf(s.charset, [rule, `x${" ".repeat(20)}y`, `a${" ".repeat(29)}be erased`]);
		expect(s.draw(after)).toMatch(/\x1b\[\d+X/);
		expectScreen(s, after);
	});

	it("keeps the screen exact across random frame sequences", () => {
		let seed = 42;
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const words = ["pi", "π", "─────", "│", "café", "Σ", "→", "  ", "code", "◆", "naïve", "≤≥", "Straße", "×"];
		const attrsPool = [0, 0, 0, ATTR_BOLD, ATTR_REVERSE, ATTR_UNDERLINE, ATTR_BOLD | ATTR_REVERSE];
		let shifts = 0;
		for (const options of [
			{},
			{ rectangularOps: false, eraseCharacters: false },
			{ statusLine: true },
			{ statusLine: true, statusState: "inherit" as const },
			{ statusLine: true, statusState: "isolated" as const },
			{ statusLine: true, unicode: true },
			{ eightBit: true, supplemental: "latin1" as const },
		]) {
			const s = setup(options);
			const region = { top: 0, bottom: ROWS - 4 };
			let transcript: Line[] = [];
			for (let step = 0; step < 60; step++) {
				const makeLine = (): Line => {
					const cells: number[] = [];
					const count = Math.floor(random() * 8);
					for (let i = 0; i < count; i++) {
						const word = words[Math.floor(random() * words.length)]!;
						const attrs = attrsPool[Math.floor(random() * attrsPool.length)]!;
						cells.push(...s.charset.cells(`${word} `, attrs));
					}
					const pick = random();
					const attr: LineAttr = pick < 0.85 ? LINE_SINGLE : pick < 0.93 ? LINE_DOUBLE_WIDTH : LINE_DOUBLE_TOP;
					return { cells, attr };
				};
				const action = random();
				if (action < 0.4 || transcript.length === 0) {
					const added = Math.ceil(random() * 3);
					for (let i = 0; i < added; i++) transcript.push(makeLine());
				} else if (action < 0.7) {
					transcript[transcript.length - 1] = makeLine();
				} else if (action < 0.75) {
					transcript = transcript.slice(0, Math.max(0, transcript.length - 2));
				} else if (action < 0.85) {
					// ticker: the last line's text moves left and new text enters at the end
					const last = transcript[transcript.length - 1]!;
					const from = Math.floor(random() * 4);
					const cut = 1 + Math.floor(random() * 12);
					last.cells = [...last.cells.slice(0, from), ...last.cells.slice(from + cut), ...makeLine().cells];
					transcript[transcript.length - 1] = { cells: last.cells, attr: last.attr };
				} else {
					transcript.splice(Math.floor(random() * transcript.length), 1, makeLine());
				}
				const visible = transcript.slice(-(region.bottom + 1));
				const lines: Line[] = [...visible];
				while (lines.length < region.bottom + 1) lines.push({ cells: [], attr: LINE_SINGLE });
				lines.push(makeLine(), { cells: s.charset.cells(`editor ${step}`), attr: LINE_SINGLE }, makeLine());
				const frame: Frame = {
					lines,
					scroll: region,
					cursor: random() < 0.8 ? { row: ROWS - 2, col: 7 } : undefined,
					status: s.charset.cells(`status ${step} ${words[step % words.length]}`),
				};
				if (/\x1b\[\d*P/.test(s.draw(frame))) shifts++;
				expectScreen(s, frame);
			}
		}
		expect(shifts).toBeGreaterThan(0);
	});
});
