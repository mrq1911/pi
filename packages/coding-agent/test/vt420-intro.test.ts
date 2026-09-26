import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTR_REVERSE, cellSet, lineWidth } from "../src/experimental/vt420/cells.ts";
import { Charset } from "../src/experimental/vt420/charset.ts";
import { IntroPlayer, type IntroStep, introSteps } from "../src/experimental/vt420/intro.ts";
import { type Frame, rendererFor } from "../src/experimental/vt420/renderer.ts";
import { charsetDesignations, SESSION_MODES, statusLineType } from "../src/experimental/vt420/sequences.ts";
import type { TerminalCapabilities } from "../src/experimental/vt420/terminal.ts";
import { cellsText, EMU_REVERSE, Vt420Emulator } from "./vt420-emulator.ts";

const VT420: TerminalCapabilities = {
	rows: 24,
	columns: 80,
	level: 4,
	name: "VT420",
	technical: true,
	statusLine: true,
	rectangularOps: true,
	eraseCharacters: true,
	supplemental: "dec",
	eightBit: false,
	unicode: false,
	bytesPerSecond: 1920,
	screenReverse: false,
	attributeExtent: 1,
};
const VT220: TerminalCapabilities = {
	...VT420,
	level: 2,
	name: "VT220",
	technical: false,
	statusLine: false,
	rectangularOps: false,
	screenReverse: undefined,
	attributeExtent: undefined,
};
const UTF8: TerminalCapabilities = { ...VT420, name: "xterm", unicode: true, supplemental: "latin1" };
/** Most emulators: UTF-8, no status line or rectangle operations, and no double-size lines. */
const MODERN: TerminalCapabilities = {
	...UTF8,
	name: "VT400-class terminal",
	statusLine: false,
	rectangularOps: false,
	doubleSize: false,
};

function terminal(caps: TerminalCapabilities) {
	const charset = new Charset({ technical: caps.technical, supplemental: caps.supplemental, eightBit: caps.eightBit });
	const hooks = { answered: () => {} };
	const emulator = new Vt420Emulator({
		rows: caps.rows,
		columns: caps.columns,
		statusType: 2,
		utf8: caps.unicode,
		lineAttributes: caps.doubleSize !== false,
		onResponse: (bytes) => {
			if (/^\x1b\[\?[\d;]*c$/.test(bytes)) hooks.answered();
		},
	});
	emulator.feed(SESSION_MODES + charsetDesignations(caps) + (caps.statusLine ? statusLineType(2) : ""));
	if (caps.screenReverse) emulator.feed("\x1b[?5h");
	if (caps.attributeExtent) emulator.feed(`\x1b[${caps.attributeExtent}*x`);
	const output: string[] = [];
	const io = {
		backlogMs: 0,
		write: (bytes: string) => {
			output.push(bytes);
			emulator.feed(Buffer.from(bytes, caps.unicode ? "utf8" : "latin1"));
		},
	};
	return { charset, emulator, output, io, hooks, renderer: rendererFor(caps) };
}

/** Every cell's glyph, reverse video and line attribute as the frame asks for them. */
function expectShown(emulator: Vt420Emulator, frame: Frame, supplemental: "dec" | "latin1"): void {
	frame.lines.forEach((line, row) => {
		expect(emulator.lineAttr(row), `line attribute of row ${row}`).toBe(line.attr);
		const width = lineWidth(line.attr, emulator.columns);
		const text = line.cells.map((cell) => cellsText([cell], supplemental)).join("");
		expect(emulator.text(row), `row ${row}`).toBe(text.slice(0, width).replace(/\s+$/u, ""));
		for (let col = 0; col < width; col++) {
			const reverse = ((line.cells[col] ?? 0x20) & ATTR_REVERSE) !== 0;
			expect((emulator.attrsAt(row, col) & EMU_REVERSE) !== 0, `reverse at ${row}:${col}`).toBe(reverse);
		}
	});
}

function playAll(steps: IntroStep[], t: ReturnType<typeof terminal>): string {
	for (const step of steps) t.io.write(t.renderer.render(step.frame) + (step.effect ?? ""));
	return t.output.join("");
}

afterEach(() => {
	vi.useRealTimers();
});

describe("vt420 intro", () => {
	it("rains π into the logo with VT420 features and ends on the picture", () => {
		const t = terminal(VT420);
		const steps = introSteps(VT420, t.charset, "1.2.3");
		const bytes = playAll(steps, t);
		expect(bytes).toContain("\x1bM");
		expect(bytes).toMatch(/\x1b\[1;\d+r/);
		expect(bytes).toMatch(/\x1b\[32;\d+;\d+;\d+;\d+\$x/);
		expect(bytes).toContain("\x1b[2*x");
		expect(bytes).toMatch(/\x1b\[\d+;\d+;\d+;\d+;7\$t/);
		expect(bytes).toContain("\x1b[?5h");
		expect(bytes).toContain("\x1b#6");
		expect(bytes).toContain("\x1b#3");
		expect(bytes).toContain("\x1b#4");
		expect(bytes.length).toBeLessThan(4000);
		const last = steps.at(-1)!.frame;
		expectShown(t.emulator, last, "dec");
		expect(t.emulator.screenReverse).toBe(false);
		expect(t.emulator.attributeExtent).toBe(1);
		expect(t.emulator.screen().some((line) => line.trim() === "pi 1.2.3")).toBe(true);
		expect(t.emulator.statusText()).toMatch(/VT420 · 80x24 · 19200 baud$/);
		// the rain already under way in the first frame reads as the digits of π from the bottom up
		const rain = steps[0]!.frame.lines.map((line) => cellsText(line.cells).replace(/[^0-9]/g, ""));
		expect(rain.slice(0, 10).reverse().join("")).toMatch(/^3141592653/);
		// the finished picture stays up the longest; the animation before it is brisk
		const dwell = steps.at(-1)!.ms;
		expect(dwell).toBe(Math.max(...steps.map((step) => step.ms)));
		expect(dwell).toBeGreaterThanOrEqual(1500);
		expect(steps.reduce((total, step) => total + step.ms, 0) - dwell).toBeLessThan(1400);
		// the shine is one quick DECRARA per step, sent without waiting for the terminal
		const shine = steps.filter((step) => step.effect?.includes("$t"));
		expect(shine.reduce((total, step) => total + step.ms, 0)).toBeLessThan(250);
		for (const step of shine) expect(step.effect!.match(/\$t/g)).toHaveLength(1);
		for (const step of shine.slice(0, -1)) expect(step.sync).toBe(false);
	});

	it("stops halfway without leaving the flash or the sweep behind", async () => {
		vi.useFakeTimers();
		for (const effect of ["\x1b[?5h", "$t"]) {
			const t = terminal(VT420);
			const steps = introSteps(VT420, t.charset, "1.2.3");
			const at = steps.findIndex((step) => step.effect?.includes(effect) && step.undo);
			const player = new IntroPlayer(t.io, t.renderer, steps);
			t.hooks.answered = () => player.answered();
			player.start();
			vi.advanceTimersByTime(steps.slice(0, at).reduce((total, step) => total + step.ms, 0));
			expect(t.output.join("")).toContain(effect);
			player.stop();
			expectShown(t.emulator, steps[at]!.frame, "dec");
			expect(t.emulator.screenReverse).toBe(false);
			expect(t.emulator.attributeExtent).toBe(1);
			const sent = t.output.length;
			vi.advanceTimersByTime(5000);
			expect(t.output.length).toBe(sent);
			await player.done;
		}
	});

	it("keeps the terminal no more than a frame behind", async () => {
		vi.useFakeTimers();
		const t = terminal(VT420);
		const steps = introSteps(VT420, t.charset, "1.2.3");
		const player = new IntroPlayer(t.io, t.renderer, steps);
		let answers = 0;
		t.hooks.answered = () => {
			answers++;
		};
		player.start();
		expect(t.output).toHaveLength(1);
		expect(t.output[0]!.endsWith("\x1b[c")).toBe(true);
		// one frame may wait for its answer while the next goes out, but not two
		vi.advanceTimersByTime(steps[0]!.ms);
		expect(t.output).toHaveLength(2);
		vi.advanceTimersByTime(steps[1]!.ms * 3);
		expect(t.output).toHaveLength(2);
		player.answered();
		expect(t.output).toHaveLength(3);
		// a terminal that stops answering gets a second to catch up, then the rest plays unsynced
		vi.advanceTimersByTime(steps[2]!.ms + 999);
		expect(t.output).toHaveLength(3);
		vi.advanceTimersByTime(1);
		expect(t.output).toHaveLength(4);
		expect(t.output[3]!.endsWith("\x1b[c")).toBe(false);
		vi.advanceTimersByTime(10_000);
		await player.done;
		expect(t.output).toHaveLength(steps.length);
		// only the first three frames asked
		expect(answers).toBe(3);
	});

	it("flashes the other way on a light screen", () => {
		const light = { ...VT420, screenReverse: true };
		const t = terminal(light);
		const bytes = playAll(introSteps(light, t.charset, "1.2.3"), t);
		expect(bytes.indexOf("\x1b[?5l")).toBeLessThan(bytes.indexOf("\x1b[?5h"));
		expect(t.emulator.screenReverse).toBe(true);
	});

	it("keeps to what a VT220 or an emulator has", () => {
		const vt220 = terminal(VT220);
		const steps = introSteps(VT220, vt220.charset, "1.2.3");
		const bytes = playAll(steps, vt220);
		expect(bytes).not.toContain("$t");
		expect(bytes).not.toContain("$x");
		expect(bytes).not.toContain("?5");
		for (const step of steps) {
			for (const line of step.frame.lines) for (const cell of line.cells) expect(cellSet(cell)).not.toBe(2);
		}
		expectShown(vt220.emulator, steps.at(-1)!.frame, "dec");

		const xterm = terminal(UTF8);
		const shown = introSteps(UTF8, xterm.charset, "1.2.3");
		const sent = playAll(shown, xterm);
		expect(sent).toContain("▒");
		expect(sent).not.toContain("\x0e");
		expect(sent).not.toMatch(/\x1b[NO]/);
		expectShown(xterm.emulator, shown.at(-1)!.frame, "latin1");
	});

	it("letter-spaces the tagline on an emulator without double-size lines", () => {
		const t = terminal(MODERN);
		const steps = introSteps(MODERN, t.charset, "1.2.3");
		const bytes = playAll(steps, t);
		expect(bytes).not.toContain("\x1b#");
		expect(bytes).not.toContain("$t");
		const screen = t.emulator.screen();
		const title = screen.findIndex((line) => line.trim() === "c o d i n g   a g e n t");
		expect(title).toBeGreaterThan(0);
		// still centred, like the double-width title it stands for
		expect(screen[title]!.indexOf("c")).toBe(28);
		expect(screen[title + 1]).toBe("");
		expect(screen.some((line) => line.trim() === "pi 1.2.3")).toBe(true);
	});

	it("stays out of screens too small for it", () => {
		const charset = new Charset({ technical: true, supplemental: "dec", eightBit: false });
		expect(introSteps({ ...VT420, rows: 18 }, charset, "1")).toEqual([]);
		expect(introSteps({ ...VT420, columns: 60 }, charset, "1")).toEqual([]);
		expect(introSteps({ ...VT420, rows: 48, columns: 132 }, charset, "1").length).toBeGreaterThan(30);
	});
});
