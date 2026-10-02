/**
 * Differential renderer for a VT420.
 *
 * The renderer keeps a model of what the terminal displays and turns each desired frame into the fewest
 * bytes it can find: relative cursor moves, one-byte locking shifts, single shifts for isolated glyphs,
 * hardware scrolling (IND/RI inside DECSTBM margins) when the transcript moves, a smooth scroll (DECSCLM) when
 * rolling text like live thinking moves on a line, DCH when text moves left within a line, EL/ECH for blank runs,
 * and DECFRA for long runs of one glyph. At 19200 baud a full 80x24 repaint costs about a second, so these
 * matter more than CPU time.
 */

import {
	ATTR_BLINK,
	ATTR_BOLD,
	ATTR_MASK,
	ATTR_REVERSE,
	ATTR_UNDERLINE,
	BLANK,
	cellCode,
	cellSet,
	LINE_DOUBLE_BOTTOM,
	LINE_DOUBLE_TOP,
	LINE_DOUBLE_WIDTH,
	LINE_SINGLE,
	type Line,
	type LineAttr,
	lineWidth,
	SET_ASCII,
	SET_GRAPHICS,
	SET_SUPPLEMENTAL,
	SET_TECHNICAL,
} from "./cells.ts";
import { cellToUnicode, type SupplementalSet } from "./charset.ts";
import { charsetDesignations } from "./sequences.ts";

export interface RendererOptions {
	rows: number;
	columns: number;
	/** Host-writable status line (DECSSDT 2) is active. */
	statusLine: boolean;
	/** DECFRA is available (VT400 rectangular area operations). */
	rectangularOps: boolean;
	/** ECH and DCH are available (VT220 and later). */
	eraseCharacters: boolean;
	/** G3 is invoked into GR, so supplemental glyphs go out as single 8-bit bytes. */
	eightBit: boolean;
	/** The terminal decodes UTF-8: every glyph goes out as its Unicode character, without shifts. */
	unicode?: boolean;
	/** False for a terminal that ignores DECDWL and DECDHL: double-size lines go out letter-spaced. */
	doubleSize?: boolean;
	/** The terminal is set to smooth scroll anyway (DECSCLM), so rolling text needs no mode switch. */
	smoothScroll?: boolean;
	/**
	 * SCS sequences for G0-G3, ending with G0 in GL. Some terminals give the status line its own designations,
	 * starting from the power-up sets, so they are repeated on every entry.
	 */
	designations?: string;
}

export interface Frame {
	/** Exactly `rows` lines. Missing cells are blank. */
	lines: Line[];
	/** Status line cells, used when the host-writable status line is active. */
	status?: number[];
	/** Cursor position; undefined hides the cursor. */
	cursor?: { row: number; col: number };
	/** Scrolling region used for hardware scrolling, 0-based and inclusive. */
	scroll: { top: number; bottom: number };
	/** A hardware scroll of a line or two glides (DECSCLM), even on a terminal set to jump scroll. */
	smooth?: boolean;
}

/** A renderer for what the terminal reported. */
export function rendererFor(caps: {
	rows: number;
	columns: number;
	statusLine: boolean;
	rectangularOps: boolean;
	eraseCharacters: boolean;
	eightBit: boolean;
	unicode: boolean;
	technical: boolean;
	supplemental: SupplementalSet;
	doubleSize?: boolean;
	smoothScroll?: boolean;
}): Renderer {
	return new Renderer({
		rows: caps.rows,
		columns: caps.columns,
		statusLine: caps.statusLine,
		rectangularOps: caps.rectangularOps,
		eraseCharacters: caps.eraseCharacters,
		eightBit: caps.eightBit,
		unicode: caps.unicode,
		doubleSize: caps.doubleSize !== false,
		smoothScroll: caps.smoothScroll === true,
		designations: charsetDesignations(caps),
	});
}

const LOCKING_SHIFT = ["\x0f", "\x0e", "\x1bn", "\x1bo"];
const SINGLE_SHIFT = ["", "", "\x1bN", "\x1bO"];
const LINE_ATTR_SEQUENCE: Record<LineAttr, string> = {
	[LINE_SINGLE]: "\x1b#5",
	[LINE_DOUBLE_WIDTH]: "\x1b#6",
	[LINE_DOUBLE_TOP]: "\x1b#3",
	[LINE_DOUBLE_BOTTOM]: "\x1b#4",
};
const STATUS_ROW = -2;
/** Unchanged cells shorter than this between two changes are rewritten instead of skipped. */
const BRIDGE_GAP = 3;
const ERASE_MIN = 8;
/** Longer hardware scrolls jump on a terminal set to smooth scroll, which would take seconds over a page. */
const SMOOTH_SCROLL_MAX = 2;
/** A DCH shift has to spare at least this many rewritten cells. */
const SHIFT_MIN = 8;
const FILL_MIN = 20;
/** Frames longer than this hide the cursor while drawing. */
const HIDE_CURSOR_OVER = 40;

export class Renderer {
	private options: RendererOptions;
	private screen: Line[] = [];
	private status: number[] = [];
	private valid = false;
	private out: string[] = [];
	private cursorRow = -1;
	private cursorCol = -1;
	private attrs = -1;
	private gl = -1;
	private region: { top: number; bottom: number } | undefined;
	private cursorVisible: boolean | undefined;

	constructor(options: RendererOptions) {
		this.options = options;
	}

	get rows(): number {
		return this.options.rows;
	}

	get columns(): number {
		return this.options.columns;
	}

	/** Forget the terminal's contents; the next frame starts with a full clear. */
	invalidate(): void {
		this.valid = false;
	}

	/** Forget cursor, rendition and shift state after something else wrote to the terminal. */
	forgetState(): void {
		this.cursorRow = -1;
		this.cursorCol = -1;
		this.attrs = -1;
		this.gl = -1;
		this.region = undefined;
		this.cursorVisible = undefined;
	}

	resize(rows: number, columns: number): void {
		this.options = { ...this.options, rows, columns };
		this.valid = false;
	}

	render(desired: Frame): string {
		return this.renderParts(desired).join("");
	}

	/** The frame in the pieces it is made of, each a whole sequence or character, so a line can pause between any two. */
	renderParts(desired: Frame): string[] {
		const frame = this.options.doubleSize === false ? { ...desired, lines: singleSize(desired.lines) } : desired;
		this.out = [];
		if (!this.valid) this.clearAll();
		this.setRegion(frame.scroll);
		// before the transcript scroll, which would otherwise take a rolled line for the whole region moving
		this.roll(frame);
		this.hardwareScroll(frame);
		for (let row = 0; row < this.options.rows; row++) {
			this.diffLine(row, frame.lines[row] ?? { cells: [], attr: LINE_SINGLE });
		}
		if (this.options.statusLine && frame.status) this.diffStatus(frame.status);
		const body = this.out;
		this.out = [];
		if (body.reduce((length, part) => length + part.length, 0) > HIDE_CURSOR_OVER && this.cursorVisible !== false) {
			body.unshift("\x1b[?25l");
			this.cursorVisible = false;
		}
		if (frame.cursor) {
			this.moveTo(frame.cursor.row, frame.cursor.col);
			if (this.cursorVisible !== true) {
				this.emit("\x1b[?25h");
				this.cursorVisible = true;
			}
		} else if (this.cursorVisible !== false) {
			this.emit("\x1b[?25l");
			this.cursorVisible = false;
		}
		return [...body, ...this.out];
	}

	private emit(sequence: string): void {
		this.out.push(sequence);
	}

	private clearAll(): void {
		this.emit("\x1b[m\x1b[H\x1b[2J");
		this.attrs = 0;
		this.cursorRow = 0;
		this.cursorCol = 0;
		this.screen = [];
		for (let row = 0; row < this.options.rows; row++) {
			this.screen.push({ cells: new Array(this.options.columns).fill(BLANK), attr: LINE_SINGLE });
		}
		this.status = new Array(this.options.columns).fill(BLANK);
		if (this.options.statusLine) {
			this.switchDisplay(true);
			this.emit("\x1b[2K");
			this.switchDisplay(false);
		}
		this.valid = true;
	}

	/**
	 * Enter or leave the status line. Each display keeps its own cursor state, and leaving restores the main one
	 * (DEC STD 070, as xterm does), so position, rendition and shift state are unknown after every switch.
	 * Entering also repeats the designations for terminals whose status line keeps its own.
	 */
	private switchDisplay(status: boolean): void {
		this.emit(status ? "\x1b[1$}" : "\x1b[0$}");
		this.cursorRow = status ? STATUS_ROW : -1;
		this.cursorCol = -1;
		this.attrs = -1;
		this.gl = -1;
		if (status && this.options.designations) {
			this.emit(this.options.designations);
			this.gl = SET_ASCII;
		}
	}

	private setRegion(scroll: Frame["scroll"]): void {
		if (this.region && this.region.top === scroll.top && this.region.bottom === scroll.bottom) return;
		const full = scroll.top === 0 && scroll.bottom === this.options.rows - 1;
		this.emit(full ? "\x1b[r" : `\x1b[${scroll.top + 1};${scroll.bottom + 1}r`);
		this.region = { ...scroll };
		// DECSTBM homes the cursor.
		this.cursorRow = 0;
		this.cursorCol = 0;
	}

	/** Detect the transcript moving up or down and let the terminal scroll it instead of repainting it. */
	private hardwareScroll(frame: Frame): void {
		const { top, bottom } = frame.scroll;
		const height = bottom - top + 1;
		if (height < 3) return;
		const want: string[] = [];
		const have: string[] = [];
		const weight: number[] = [];
		for (let row = top; row <= bottom; row++) {
			const line = frame.lines[row] ?? { cells: [], attr: LINE_SINGLE };
			want.push(lineKey(line.cells, line.attr, this.options.columns));
			weight.push(contentLength(line.cells));
			const current = this.screen[row]!;
			have.push(lineKey(current.cells, current.attr, this.options.columns));
		}
		const score = (shift: number): number => {
			let total = 0;
			for (let i = 0; i < height; i++) {
				const source = i + shift;
				if (source < 0 || source >= height) continue;
				if (weight[i]! > 0 && want[i] === have[source]) total += weight[i]!;
			}
			return total;
		};
		const baseline = score(0);
		let best = 0;
		let bestScore = baseline;
		for (let shift = 1; shift < height; shift++) {
			const up = score(shift);
			if (up > bestScore) {
				best = shift;
				bestScore = up;
			}
			const down = score(-shift);
			if (down > bestScore) {
				best = -shift;
				bestScore = down;
			}
		}
		// Each scrolled line costs two bytes plus a cursor move; only scroll when it clearly saves output.
		if (best === 0 || bestScore - baseline <= Math.abs(best) * 2 + 8) return;
		// while a smooth-scrolling terminal glides through a page, what follows piles up and overflows its buffer
		const jump = this.options.smoothScroll === true && Math.abs(best) > SMOOTH_SCROLL_MAX;
		const glide = frame.smooth === true && this.options.smoothScroll !== true && Math.abs(best) <= SMOOTH_SCROLL_MAX;
		if (jump) this.emit("\x1b[?4l");
		if (glide) this.emit("\x1b[?4h");
		if (best > 0) {
			this.moveTo(bottom, 0);
			this.emit("\x1bD".repeat(best));
			for (let row = top; row <= bottom; row++) {
				this.screen[row] =
					row + best <= bottom
						? this.screen[row + best]!
						: { cells: new Array(this.options.columns).fill(BLANK), attr: LINE_SINGLE };
			}
		} else {
			this.moveTo(top, 0);
			this.emit("\x1bM".repeat(-best));
			for (let row = bottom; row >= top; row--) {
				this.screen[row] =
					row + best >= top
						? this.screen[row + best]!
						: { cells: new Array(this.options.columns).fill(BLANK), attr: LINE_SINGLE };
			}
		}
		if (glide) this.emit("\x1b[?4l");
		if (jump) this.emit("\x1b[?4h");
		this.clampCursor();
	}

	/**
	 * Two rows of rolling text that moved on a line: the lower row gets the rest of its line, then the terminal
	 * smooth-scrolls the pair up, and the new line starts on the lower row, so the text rolls on like paper.
	 */
	private roll(frame: Frame): void {
		for (let row = 1; row < this.options.rows; row++) {
			const lower = frame.lines[row];
			const upper = frame.lines[row - 1];
			const shown = this.screen[row]!.roll;
			if (!lower?.roll || upper?.roll?.id !== lower.roll.id || upper.roll.line !== lower.roll.line - 1) continue;
			if (shown?.id !== lower.roll.id || shown.line !== upper.roll.line) continue;
			this.diffLine(row, upper);
			this.setRegion({ top: row - 1, bottom: row });
			this.moveTo(row, 0);
			this.emit(this.options.smoothScroll ? "\x1bD" : "\x1b[?4h\x1bD\x1b[?4l");
			this.screen[row - 1] = this.screen[row]!;
			this.screen[row] = { cells: new Array(this.options.columns).fill(BLANK), attr: LINE_SINGLE };
			this.setRegion(frame.scroll);
		}
	}

	private diffLine(row: number, desired: Line): void {
		let current = this.screen[row]!;
		if (current.attr !== desired.attr) {
			this.moveTo(row, 0);
			if (current.cells.some((cell) => cell !== BLANK)) this.emit("\x1b[2K");
			this.emit(LINE_ATTR_SEQUENCE[desired.attr]);
			current = { cells: new Array(lineWidth(desired.attr, this.options.columns)).fill(BLANK), attr: desired.attr };
			this.screen[row] = current;
			this.clampCursor();
		}
		if (desired.attr === LINE_SINGLE && this.options.eraseCharacters)
			this.shiftLine(row, desired.cells, current.cells);
		this.diffCells(row, desired.cells, current.cells, desired.attr === LINE_SINGLE);
		current.roll = desired.roll;
	}

	/**
	 * Text that moved left, like the thinking ticker, moves in the terminal too: DCH at the first change pulls the
	 * rest of the line left, and only the blanks it leaves at the margin need writing.
	 */
	private shiftLine(row: number, desired: readonly number[], current: number[]): void {
		const width = current.length;
		const want = (col: number): number => (col < desired.length ? desired[col]! : BLANK);
		let start = 0;
		while (start < width && want(start) === current[start]) start++;
		if (start >= width || restBlank(current, start, width)) return;
		const changed = (shift: number): number => {
			let count = 0;
			for (let col = start; col < width; col++) {
				if (want(col) !== (col + shift < width ? current[col + shift] : BLANK)) count++;
			}
			return count;
		};
		let best = 0;
		let fewest = changed(0) - SHIFT_MIN;
		for (let shift = 1; start + shift < width; shift++) {
			if (current[start + shift] !== want(start)) continue;
			const count = changed(shift);
			if (count < fewest) {
				best = shift;
				fewest = count;
			}
		}
		if (best === 0) return;
		const shifted = current.slice();
		shifted.copyWithin(start, start + best);
		shifted.fill(BLANK, width - best);
		const shift = (): void => {
			this.moveTo(row, start);
			this.emit(best === 1 ? "\x1b[P" : `\x1b[${best}P`);
		};
		const plain = this.measure(() => this.diffCells(row, desired, current.slice(), true));
		const moved = this.measure(() => {
			shift();
			this.diffCells(row, desired, shifted.slice(), true);
		});
		if (moved >= plain) return;
		shift();
		for (let col = start; col < width; col++) current[col] = shifted[col]!;
	}

	/** Bytes a drawing step would emit, leaving the terminal state as it was. */
	private measure(draw: () => void): number {
		const { out, cursorRow, cursorCol, attrs, gl } = this;
		this.out = [];
		draw();
		const bytes = this.out.join("").length;
		this.out = out;
		this.cursorRow = cursorRow;
		this.cursorCol = cursorCol;
		this.attrs = attrs;
		this.gl = gl;
		return bytes;
	}

	private diffStatus(desired: number[]): void {
		const width = this.options.columns;
		let changed = false;
		for (let col = 0; col < width; col++) {
			if ((desired[col] ?? BLANK) !== this.status[col]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		this.switchDisplay(true);
		this.diffCells(STATUS_ROW, desired, this.status, false);
		this.switchDisplay(false);
	}

	private diffCells(row: number, desired: readonly number[], current: number[], allowFill: boolean): void {
		const width = current.length;
		const want = (col: number): number => (col < desired.length ? desired[col]! : BLANK);
		let col = 0;
		while (col < width) {
			if (want(col) === current[col]) {
				col++;
				continue;
			}
			if (restBlank(desired, col, width)) {
				this.moveTo(row, col);
				this.emit("\x1b[K");
				current.fill(BLANK, col);
				return;
			}
			let end = col;
			let next = col + 1;
			while (next < width) {
				if (want(next) !== current[next]) {
					end = next++;
					continue;
				}
				let gap = next;
				while (gap < width && want(gap) === current[gap]) gap++;
				if (gap >= width || gap - next > BRIDGE_GAP) break;
				end = gap - 1;
				next = gap;
			}
			this.writeSpan(row, col, end, want, current, allowFill);
			col = end + 1;
		}
	}

	private writeSpan(
		row: number,
		from: number,
		to: number,
		want: (col: number) => number,
		current: number[],
		allowFill: boolean,
	): void {
		this.moveTo(row, from);
		let col = from;
		while (col <= to) {
			const cell = want(col);
			if (cell === BLANK && restBlankWant(want, col, current.length)) {
				this.moveTo(row, col);
				this.emit("\x1b[K");
				current.fill(BLANK, col);
				return;
			}
			let run = 1;
			while (col + run <= to && want(col + run) === cell) run++;
			if (cell === BLANK && this.options.eraseCharacters && run >= (col + run > to ? 5 : ERASE_MIN)) {
				this.moveTo(row, col);
				this.emit(`\x1b[${run}X`);
				current.fill(BLANK, col, col + run);
				col += run;
				continue;
			}
			// DECFRA takes its fill character from GL, which only holds ASCII in Unicode mode.
			const fillable = !this.options.unicode || cellSet(cell) === SET_ASCII;
			if (allowFill && fillable && this.options.rectangularOps && run >= FILL_MIN) {
				this.moveTo(row, col);
				this.fill(row, col, run, cell);
				current.fill(cell, col, col + run);
				col += run;
				continue;
			}
			this.moveTo(row, col);
			const nextSet = nextGlyphSet(want, col + 1, to);
			this.putCell(cell, nextSet);
			current[col] = cell;
			this.advance(row, current.length);
			col++;
		}
	}

	/** DECFRA fills with the current rendition and the character at Pch in the current GL table. */
	private fill(row: number, col: number, count: number, cell: number): void {
		this.setAttrs(cell & ATTR_MASK);
		const set = cellSet(cell);
		const code = cellCode(cell);
		let pch = code;
		if (code !== 0x20 && !(set === SET_ASCII && this.gl === SET_GRAPHICS && code < 0x5f) && set !== this.gl) {
			if (set === SET_SUPPLEMENTAL && this.options.eightBit) pch = code | 0x80;
			else {
				this.emit(LOCKING_SHIFT[set]!);
				this.gl = set;
			}
		}
		this.emit(`\x1b[${pch};${row + 1};${col + 1};${row + 1};${col + count}$x`);
	}

	private putCell(cell: number, nextSet: number | undefined): void {
		this.setAttrs(cell & ATTR_MASK);
		const set = cellSet(cell);
		const code = cellCode(cell);
		const char = String.fromCharCode(code);
		if (this.options.unicode) {
			if (this.gl !== SET_ASCII) {
				this.emit(LOCKING_SHIFT[SET_ASCII]!);
				this.gl = SET_ASCII;
			}
			this.emit(set === SET_ASCII ? char : cellToUnicode(set, code, "latin1"));
			return;
		}
		if (code === 0x20 || set === this.gl || (set === SET_ASCII && this.gl === SET_GRAPHICS && code < 0x5f)) {
			this.emit(char);
		} else if (set === SET_SUPPLEMENTAL && this.options.eightBit) {
			this.emit(String.fromCharCode(code | 0x80));
		} else if ((set === SET_TECHNICAL || set === SET_SUPPLEMENTAL) && nextSet !== set) {
			this.emit(SINGLE_SHIFT[set]! + char);
		} else {
			this.emit(LOCKING_SHIFT[set]! + char);
			this.gl = set;
		}
	}

	private advance(row: number, width: number): void {
		if (row === this.cursorRow && this.cursorCol >= 0) this.cursorCol = Math.min(this.cursorCol + 1, width - 1);
	}

	private setAttrs(target: number): void {
		if (this.attrs === target) return;
		if (target === 0) {
			this.emit("\x1b[m");
		} else if (this.attrs < 0) {
			this.emit(`\x1b[0;${attrParams(target, false).join(";")}m`);
		} else {
			const off = this.attrs & ~target;
			const on = target & ~this.attrs;
			const reset = `\x1b[0;${attrParams(target, false).join(";")}m`;
			const delta = `\x1b[${[...attrParams(off, true), ...attrParams(on, false)].join(";")}m`;
			this.emit(off !== 0 && reset.length <= delta.length ? reset : delta);
		}
		this.attrs = target;
	}

	private rowWidth(row: number): number {
		if (row === STATUS_ROW) return this.options.columns;
		return this.screen[row]?.cells.length ?? this.options.columns;
	}

	private clampCursor(): void {
		if (this.cursorRow >= 0 && this.cursorCol >= 0) {
			this.cursorCol = Math.min(this.cursorCol, this.rowWidth(this.cursorRow) - 1);
		}
	}

	private moveTo(row: number, col: number): void {
		if (row === this.cursorRow && col === this.cursorCol) return;
		let best = row === STATUS_ROW ? `\x1b[;${col + 1}H` : cup(row, col);
		if (this.cursorRow === row && this.cursorCol >= 0) {
			const horizontal = horizontalMove(this.cursorCol, col);
			if (horizontal.length < best.length) best = horizontal;
		} else if (this.cursorRow >= 0 && this.cursorCol >= 0 && row >= 0 && this.sameZone(this.cursorRow, row)) {
			const delta = row - this.cursorRow;
			const vertical =
				delta === 1 && this.lineFeedSafe(this.cursorRow)
					? "\n"
					: delta > 0
						? `\x1b[${delta === 1 ? "" : delta}B`
						: `\x1b[${delta === -1 ? "" : -delta}A`;
			const colAfter = Math.min(this.cursorCol, this.rowWidth(row) - 1);
			const candidate = vertical + horizontalMove(colAfter, col);
			if (candidate.length < best.length) best = candidate;
		}
		this.emit(best);
		this.cursorRow = row;
		this.cursorCol = col;
	}

	/** CUU/CUD and LF stop at scrolling margins, so relative vertical moves stay within one zone. */
	private sameZone(a: number, b: number): boolean {
		const region = this.region ?? { top: 0, bottom: this.options.rows - 1 };
		const zone = (row: number): number => (row < region.top ? 0 : row <= region.bottom ? 1 : 2);
		return zone(a) === zone(b);
	}

	private lineFeedSafe(row: number): boolean {
		const region = this.region ?? { top: 0, bottom: this.options.rows - 1 };
		return row !== region.bottom && row < this.options.rows - 1;
	}
}

/**
 * Double-size lines as a terminal without them can show: each character followed by a space in its rendition,
 * which keeps the layout of a double-width line, and a double-height pair on its top row only.
 */
function singleSize(lines: readonly Line[]): Line[] {
	return lines.map((line, index): Line => {
		if (line.attr === LINE_SINGLE) return line;
		if (line.attr === LINE_DOUBLE_BOTTOM && lines[index - 1]?.attr === LINE_DOUBLE_TOP) {
			return { cells: [], attr: LINE_SINGLE };
		}
		const cells: number[] = [];
		for (const cell of line.cells) cells.push(cell, BLANK | (cell & ATTR_MASK));
		return { cells, attr: LINE_SINGLE };
	});
}

function cup(row: number, col: number): string {
	if (row === 0 && col === 0) return "\x1b[H";
	if (col === 0) return `\x1b[${row + 1}H`;
	if (row === 0) return `\x1b[;${col + 1}H`;
	return `\x1b[${row + 1};${col + 1}H`;
}

function horizontalMove(from: number, to: number): string {
	if (from === to) return "";
	if (to === 0) return "\r";
	if (to > from) {
		const distance = to - from;
		return distance === 1 ? "\x1b[C" : `\x1b[${distance}C`;
	}
	const distance = from - to;
	const back = distance <= 3 ? "\b".repeat(distance) : `\x1b[${distance}D`;
	const fromStart = `\r${to === 1 ? "\x1b[C" : `\x1b[${to}C`}`;
	return fromStart.length < back.length ? fromStart : back;
}

function attrParams(attrs: number, off: boolean): number[] {
	const params: number[] = [];
	if (attrs & ATTR_BOLD) params.push(off ? 22 : 1);
	if (attrs & ATTR_UNDERLINE) params.push(off ? 24 : 4);
	if (attrs & ATTR_BLINK) params.push(off ? 25 : 5);
	if (attrs & ATTR_REVERSE) params.push(off ? 27 : 7);
	return params;
}

function restBlank(cells: readonly number[], from: number, width: number): boolean {
	const end = Math.min(cells.length, width);
	for (let col = from; col < end; col++) {
		if (cells[col] !== BLANK) return false;
	}
	return true;
}

function restBlankWant(want: (col: number) => number, from: number, width: number): boolean {
	for (let col = from; col < width; col++) {
		if (want(col) !== BLANK) return false;
	}
	return true;
}

function nextGlyphSet(want: (col: number) => number, from: number, to: number): number | undefined {
	for (let col = from; col <= to; col++) {
		const cell = want(col);
		if (cellCode(cell) !== 0x20) return cellSet(cell);
	}
	return undefined;
}

function lineKey(cells: readonly number[], attr: LineAttr, columns: number): string {
	const width = lineWidth(attr, columns);
	let end = Math.min(cells.length, width);
	while (end > 0 && cells[end - 1] === BLANK) end--;
	return `${attr}:${cells.slice(0, end).join(",")}`;
}

function contentLength(cells: readonly number[]): number {
	let length = 0;
	for (const cell of cells) if (cell !== BLANK) length++;
	return length;
}
