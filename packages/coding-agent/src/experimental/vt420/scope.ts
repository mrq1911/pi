/**
 * The separator's working indicator: a scope trace that says what goes on, a sine while the model thinks, its voice
 * while it writes, a square wave while a tool runs. A terminal that takes soft fonts draws the traces at dot
 * resolution, half a cell further each tick; the rest get the scan lines of DEC Special Graphics, a cell a tick.
 */

import { glyph, SET_SOFT } from "@mrq/vt420/cells.js";
import type { Charset } from "@mrq/vt420/charset.js";
import { softFont } from "@mrq/vt420/sequences.js";

export type Phase = "thinking" | "writing" | "tool";

/** Cells a trace takes. */
export const TRACE_CELLS = 4;

const WIDTH = 10;
const HEIGHT = 16;
const MIDDLE = 7.5;

/** A periodic trace, `period` dots long, cut into glyphs half a cell apart. */
function travelling(period: number, dots: (x: number) => number[]): string[][] {
	const glyphs: string[][] = [];
	for (let offset = 0; offset < period; offset += WIDTH / 2) {
		const rows = Array.from({ length: HEIGHT }, () => Array<string>(WIDTH).fill("."));
		for (let col = 0; col < WIDTH; col++) {
			for (const row of dots((offset + col) % period)) if (row >= 0 && row < HEIGHT) rows[row]![col] = "#";
		}
		glyphs.push(rows.map((row) => row.join("")));
	}
	return glyphs;
}

/** A curve's dots in column x: from its height there to its height in the next, so it has no gaps. */
function curve(height: (x: number) => number): (x: number) => number[] {
	return (x) => {
		const from = Math.round(height(x));
		const to = Math.round(height(x + 1));
		return Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => Math.min(from, to) + i);
	};
}

const sine = travelling(
	20,
	curve((x) => MIDDLE - 5.5 * Math.sin((2 * Math.PI * x) / 20)),
);
const square = travelling(
	20,
	curve((x) => (x % 20 < 10 ? 3 : 12)),
);
// the same loudness every run, bars in every other column
let seed = 11;
const loudness = Array.from({ length: 40 }, () => {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
});
const voice = travelling(80, (x) => {
	if (x % 2 === 1) return [];
	const envelope = 0.35 + 0.65 * Math.abs(Math.sin((Math.PI * x) / 40));
	const height = Math.round(6.5 * envelope * loudness[x / 2]!);
	return Array.from({ length: 2 * height }, (_, i) => 8 - height + i);
});

const SOFT: Record<Phase, { first: number; count: number }> = {
	thinking: { first: 0x21, count: sine.length },
	writing: { first: 0x21 + sine.length, count: voice.length },
	tool: { first: 0x21 + sine.length + voice.length, count: square.length },
};

/** The font as DECDLD strings of two glyphs, each short enough to go out as one paced piece. */
export const SCOPE_FONT: string[] = (() => {
	const glyphs = [...sine, ...voice, ...square];
	const pieces: string[] = [];
	for (let index = 0; index < glyphs.length; index += 2)
		pieces.push(softFont(glyphs.slice(index, index + 2), 0x21 + index));
	return pieces;
})();

const SCAN_LINES = ["⎽", "⎼", "─", "⎻", "⎺"];
const SINE_LINES = [..."⎺⎻─⎼⎽⎼─⎻"];
const SQUARE_LINES = [..."⎺⎺│⎽⎽│"];
const VOICE_LINES = loudness.map((level) => SCAN_LINES[Math.floor(level * SCAN_LINES.length)]!);

/** The trace for `phase` at `tick`, in soft glyphs where the font is loaded, scan lines otherwise. */
export function traceCells(phase: Phase, tick: number, charset: Charset, soft: boolean): number[] {
	if (soft) {
		const { first, count } = SOFT[phase];
		return Array.from({ length: TRACE_CELLS }, (_, i) => glyph(SET_SOFT, first + ((2 * i + tick) % count)));
	}
	const lines = phase === "thinking" ? SINE_LINES : phase === "tool" ? SQUARE_LINES : VOICE_LINES;
	return charset.cells(Array.from({ length: TRACE_CELLS }, (_, i) => lines[(i + tick) % lines.length]).join(""));
}
