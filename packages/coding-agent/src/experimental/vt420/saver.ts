/**
 * The screen saver. A CRT left on one picture for hours keeps it in the phosphor, and a model can work that long, so
 * after a spell without keys the screen goes dark: "blank" leaves it so, "progress" shows one short line of how the
 * work goes, in another place every half minute, and "matrix" rains down what the model generates, a lone π falling
 * while it works without writing, and the π line once all is done. Any key brings the screen back and does nothing
 * else.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ATTR_BOLD, BLANK, isSpace, LINE_SINGLE, type Line } from "./cells.ts";
import type { Frame } from "./renderer.ts";

export type SaverMode = "off" | "blank" | "progress" | "matrix";

/** Minutes without a key before the screen saver starts. */
export const SAVER_MINUTES = 10;
/** How long the progress line stays in one place. */
export const SAVER_MOVE_MS = 30_000;

export function isSaverMode(value: string): value is SaverMode {
	return value === "off" || value === "blank" || value === "progress" || value === "matrix";
}

/** How often the rain may fall a line; the terminal's answers hold it back to the pace it can glide. */
export const RAIN_STEP_MS = 80;
/** Glints racing down the streams at once, at most; each rewrites two cells a line. */
const GLINTS_MAX = 3;
/** Chance a line that a glint starts on a stream. */
const GLINT_CHANCE = 0.2;
/** Characters waiting to fall, at most; a model faster than the rain loses its oldest. */
const RAIN_BACKLOG = 2000;
/** Longest word one drop carries. */
const DROP_MAX = 16;

/** What a model has written so far, its thinking and its text, in order. */
export function generatedText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	const parts: string[] = [];
	for (const content of message.content) {
		if (content.type === "thinking") parts.push(content.thinking);
		else if (content.type === "text") parts.push(content.text);
	}
	return parts.join(" ");
}

/**
 * Matrix rain from what the model generates. The whole screen moves down a line at a time, which a terminal can
 * smooth-scroll, and each word enters at the top of a column last letter first, that one bright, so once in it reads
 * top to bottom as it falls; only the new top row is ever written.
 */
export class MatrixRain {
	private readonly rows: number;
	private readonly columns: number;
	private readonly random: () => number;
	private readonly maxDrops: number;
	private readonly maxGlints: number;
	private readonly grid: number[][];
	private readonly drops: Array<{ cells: number[]; bright: boolean; solo: boolean } | undefined>;
	private readonly gaps: number[];
	private queue: number[] = [];
	/** Lines fallen since the lone drop started, and its length: it is off the screen once both pass the bottom. */
	private soloAge = Number.POSITIVE_INFINITY;
	private soloLength = 0;
	/** Bright cells running down their streams a row faster than the rain, so streams seem to overtake each other. */
	private glints: Array<{ row: number; col: number }> = [];
	/** Lines fallen since the screen was last drawn. */
	private fallen = 0;

	constructor(
		rows: number,
		columns: number,
		options: { random?: () => number; maxDrops?: number; glints?: number } = {},
	) {
		this.rows = rows;
		this.columns = columns;
		this.random = options.random ?? Math.random;
		this.maxDrops = options.maxDrops ?? Math.max(4, Math.floor(columns / 4));
		this.maxGlints = options.glints ?? GLINTS_MAX;
		this.grid = Array.from({ length: rows }, () => new Array<number>(columns).fill(BLANK));
		this.drops = new Array(columns).fill(undefined);
		this.gaps = new Array<number>(columns).fill(0);
	}

	/** Generated text to rain down; a run of whitespace falls as one gap. */
	feed(cells: readonly number[]): void {
		for (const cell of cells) {
			const space = isSpace(cell);
			if (space && (this.queue.length === 0 || this.queue.at(-1) === BLANK)) continue;
			this.queue.push(space ? BLANK : cell);
		}
		if (this.queue.length > RAIN_BACKLOG) this.queue.splice(0, this.queue.length - RAIN_BACKLOG);
	}

	/** Words waiting or falling into the screen. */
	get raining(): boolean {
		return this.queue.length > 0 || this.drops.some((drop) => drop !== undefined && !drop.solo);
	}

	/** Anything left on the screen or still to come. */
	get active(): boolean {
		return this.raining || this.drops.some(Boolean) || this.grid.some((row) => row.some((cell) => cell !== BLANK));
	}

	/**
	 * The screen moves down a line and the drops write the new top row. With no words to rain, `solo`, read top to
	 * bottom, falls on its own, one at a time, led by its last cell.
	 */
	step(solo?: readonly number[]): void {
		const top = new Array<number>(this.columns).fill(BLANK);
		this.soloAge++;
		if (solo && solo.length > 0 && !this.raining && this.soloAge > this.rows + this.soloLength) {
			const col = Math.floor(this.random() * this.columns);
			if (!this.drops[col]) {
				this.drops[col] = { cells: [...solo].reverse(), bright: true, solo: true };
				this.soloAge = 0;
				this.soloLength = solo.length;
			}
		}
		let falling = this.drops.filter((drop) => drop !== undefined).length;
		// heavier as the backlog grows
		const chance = Math.min(0.5, 0.04 + this.queue.length / 400);
		for (let col = 0; col < this.columns; col++) {
			let drop = this.drops[col];
			if (!drop) {
				if (this.gaps[col]! > 0) {
					this.gaps[col]!--;
					continue;
				}
				if (falling >= this.maxDrops || this.queue.length === 0 || this.random() >= chance) continue;
				const word = this.nextWord();
				if (word.length === 0) continue;
				drop = { cells: word.reverse(), bright: true, solo: false };
				this.drops[col] = drop;
				falling++;
			}
			const cell = drop.cells.shift()!;
			top[col] = drop.bright ? cell | ATTR_BOLD : cell;
			drop.bright = false;
			if (drop.cells.length === 0) {
				this.drops[col] = undefined;
				this.gaps[col] = 1 + Math.floor(this.random() * 6);
				falling--;
			}
		}
		this.grid.pop();
		this.grid.unshift(top);
		this.fallen++;
		this.race();
	}

	/** Lines fallen since the last call, for the renderer to scroll in hardware. */
	takeFallen(): number {
		const fallen = this.fallen;
		this.fallen = 0;
		return fallen;
	}

	/** Every glint moved down with the screen; each takes one more row down its stream, or fades at its end. */
	private race(): void {
		const cell = (row: number, col: number): number => this.grid[row]?.[col] ?? BLANK;
		this.glints = this.glints.flatMap(({ row, col }) => {
			const here = row + 1;
			const next = here + 1;
			if (here >= this.rows) return [];
			const ahead = cell(next, col);
			this.grid[here]![col] = cell(here, col) & ~ATTR_BOLD;
			// at a gap, the bottom or a stream's own bright head, the glint is done
			if (next >= this.rows || isSpace(ahead) || ahead & ATTR_BOLD) return [];
			this.grid[next]![col] = ahead | ATTR_BOLD;
			return [{ row: next, col }];
		});
		if (this.glints.length >= this.maxGlints || this.random() >= GLINT_CHANCE) return;
		const col = Math.floor(this.random() * this.columns);
		const start = cell(1, col);
		if (isSpace(start) || start & ATTR_BOLD || this.glints.some((glint) => glint.col === col)) return;
		this.grid[1]![col] = start | ATTR_BOLD;
		this.glints.push({ row: 1, col });
	}

	lines(): Line[] {
		return this.grid.slice(0, this.rows).map((cells) => ({ cells: [...cells], attr: LINE_SINGLE }));
	}

	private nextWord(): number[] {
		while (this.queue[0] === BLANK) this.queue.shift();
		const word: number[] = [];
		while (this.queue.length > 0 && this.queue[0] !== BLANK && word.length < DROP_MAX) word.push(this.queue.shift()!);
		return word;
	}
}

/** A dark screen, with `line` at `place` when there is one. */
export function saverFrame(
	rows: number,
	columns: number,
	line: readonly number[] | undefined,
	place: { row: number; col: number },
	statusLine: boolean,
): Frame {
	const lines: Line[] = Array.from({ length: rows }, () => ({ cells: [], attr: LINE_SINGLE }));
	if (line && place.row < rows) {
		const col = Math.max(0, Math.min(place.col, columns - line.length));
		lines[place.row] = {
			cells: [...new Array<number>(col).fill(BLANK), ...line.slice(0, columns)],
			attr: LINE_SINGLE,
		};
	}
	return { lines, status: statusLine ? [] : undefined, scroll: { top: 0, bottom: rows - 1 } };
}

/** Anywhere a line of `length` cells fits. */
export function saverPlace(
	rows: number,
	columns: number,
	length: number,
	random: () => number = Math.random,
): { row: number; col: number } {
	return {
		row: Math.floor(random() * rows),
		col: Math.floor(random() * Math.max(1, columns - length + 1)),
	};
}
