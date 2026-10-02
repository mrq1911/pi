/**
 * A small VT420 emulator for tests.
 *
 * It interprets the control functions the VT420 frontend emits (and answers the probes it sends), so tests
 * can check that a byte stream produces the intended screen. It is intentionally strict about the features
 * the frontend relies on: DECAWM off, charset designations, locking and single shifts, line attributes,
 * DECSTBM margins with IND/RI, ECH, DCH, DECFRA, DECRARA with DECSACE, DECSCNM, and the host-writable status
 * line.
 */

import { cellCode, cellSet, type Line } from "../src/experimental/vt420/cells.ts";
import {
	cellToUnicode,
	DEC_SUPPLEMENTAL,
	LATIN1_SUPPLEMENTAL,
	SPECIAL_GRAPHICS,
	type SupplementalSet,
	TECHNICAL,
	TECHNICAL_SIGMA_PREVIEW,
} from "../src/experimental/vt420/charset.ts";

/** Unicode text of cells, for assertions on rendered lines. */
export function cellsText(cells: readonly number[], supplemental: SupplementalSet = "dec"): string {
	return cells.map((cell) => cellToUnicode(cellSet(cell), cellCode(cell), supplemental)).join("");
}

export function linesText(lines: readonly Line[], supplemental: SupplementalSet = "dec"): string[] {
	return lines.map((line) => cellsText(line.cells, supplemental).replace(/\s+$/u, ""));
}

type Designation = "ascii" | "graphics" | "technical" | "dec-supplemental" | "latin1";

export const EMU_BOLD = 1;
export const EMU_UNDERLINE = 2;
export const EMU_BLINK = 4;
export const EMU_REVERSE = 8;

interface EmuLine {
	chars: string[];
	attrs: number[];
	/** 0 single, 1 double width, 2 double-height top, 3 double-height bottom */
	lineAttr: number;
}

export interface EmulatorOptions {
	rows?: number;
	columns?: number;
	/** Reply to probes as a VT420 would. */
	onResponse?: (bytes: string) => void;
	/** Status line type at power-up: 0 none, 1 indicator, 2 host-writable. */
	statusType?: number;
	userPreferredSupplemental?: "dec" | "latin1";
	/** Which terminal to impersonate in reports. A VT220 answers DA and CPR only. */
	identity?: "vt420" | "vt220";
	/**
	 * Cursor state of the status line: "separate" keeps its own rendition and shifts, "inherit" continues with the
	 * main display's (xterm), "isolated" also keeps its own G0-G3 designations, starting from the power-up ones
	 * (a status line that is a separate one-row screen). All restore the main display's state when leaving.
	 */
	statusState?: "separate" | "inherit" | "isolated";
	/** Decode bytes from 0x80 as UTF-8, like a modern emulator, instead of C1 and GR. */
	utf8?: boolean;
	/** False ignores DECDWL and DECDHL, as most modern emulators do. */
	lineAttributes?: boolean;
}

export class Vt420Emulator {
	rows: number;
	columns: number;
	lines: EmuLine[] = [];
	status: EmuLine;
	statusType: number;
	statusActive = false;
	statusCol = 0;
	row = 0;
	col = 0;
	sgr = 0;
	designations: Designation[] = ["ascii", "ascii", "dec-supplemental", "dec-supplemental"];
	gl = 0;
	gr = 2;
	singleShift = 0;
	autowrap = true;
	pendingWrap = false;
	cursorVisible = true;
	/** DECSCNM: the whole screen shown in reverse. */
	screenReverse = false;
	/** DECSACE: 2 makes DECCARA and DECRARA work on rectangles, anything else on the stream of characters. */
	attributeExtent = 0;
	top = 0;
	bottom: number;
	lineFeedNewLine = false;
	/** Bytes written, for assertions about output size. */
	bytes = 0;
	private readonly onResponse?: (bytes: string) => void;
	private readonly userPreferred: "dec" | "latin1";
	private readonly identity: "vt420" | "vt220";
	private readonly statusStateMode: "separate" | "inherit" | "isolated";
	private readonly utf8: boolean;
	private readonly lineAttributes: boolean;
	private utf8Bytes: number[] = [];
	/**
	 * Rendition and shift state belong to the display being written. Like xterm (DEC STD 070), switching to the
	 * status line saves the main display's state and switching back restores it; the status line keeps its own.
	 */
	private statusState = {
		sgr: 0,
		gl: 0,
		gr: 2,
		col: 0,
		designations: ["ascii", "ascii", "dec-supplemental", "dec-supplemental"] as Designation[],
	};
	private mainState = { row: 0, col: 0, sgr: 0, gl: 0, gr: 2, designations: [] as Designation[] };
	private saved:
		| { row: number; col: number; sgr: number; gl: number; gr: number; designations: Designation[] }
		| undefined;
	private state: "ground" | "escape" | "csi" | "dcs" | "dcsEscape" | "osc" = "ground";
	private buffer = "";
	private dcsData = "";

	constructor(options: EmulatorOptions = {}) {
		this.rows = options.rows ?? 24;
		this.columns = options.columns ?? 80;
		this.bottom = this.rows - 1;
		this.onResponse = options.onResponse;
		this.statusType = options.statusType ?? 1;
		this.userPreferred = options.userPreferredSupplemental ?? "dec";
		this.identity = options.identity ?? "vt420";
		this.statusStateMode = options.statusState ?? "separate";
		this.utf8 = options.utf8 ?? false;
		this.lineAttributes = options.lineAttributes ?? true;
		this.status = this.blankLine();
		for (let row = 0; row < this.rows; row++) this.lines.push(this.blankLine());
	}

	/** Feed bytes; a string is taken as bytes (one per character, as written with latin1). */
	feed(data: string | Uint8Array): void {
		const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
		this.bytes += bytes.length;
		for (const byte of bytes) this.byte(byte);
	}

	/** Visible text of a row, right-trimmed. Double-width rows contain only their visible half. */
	text(row: number): string {
		const line = this.lines[row]!;
		return line.chars.slice(0, this.width(line)).join("").replace(/\s+$/u, "");
	}

	statusText(): string {
		return this.status.chars.join("").replace(/\s+$/u, "");
	}

	screen(): string[] {
		return this.lines.map((_, row) => this.text(row));
	}

	attrsAt(row: number, col: number): number {
		return this.lines[row]!.attrs[col]!;
	}

	lineAttr(row: number): number {
		return this.lines[row]!.lineAttr;
	}

	private blankLine(): EmuLine {
		return {
			chars: new Array(this.columns).fill(" "),
			attrs: new Array(this.columns).fill(0),
			lineAttr: 0,
		};
	}

	private width(line: EmuLine): number {
		return line.lineAttr === 0 ? this.columns : Math.floor(this.columns / 2);
	}

	private current(): EmuLine {
		return this.statusActive ? this.status : this.lines[this.row]!;
	}

	private byte(code: number): void {
		switch (this.state) {
			case "ground":
				this.ground(code);
				return;
			case "escape":
				this.escape(code);
				return;
			case "csi":
				this.buffer += String.fromCharCode(code);
				if (code >= 0x40 && code <= 0x7e) {
					const sequence = this.buffer;
					this.state = "ground";
					this.buffer = "";
					this.csi(sequence);
				}
				return;
			case "dcs":
				if (code === 0x1b) this.state = "dcsEscape";
				else if (code === 0x9c) this.finishDcs();
				else this.dcsData += String.fromCharCode(code);
				return;
			case "dcsEscape":
				if (code === 0x5c) this.finishDcs();
				else {
					this.dcsData += `\x1b${String.fromCharCode(code)}`;
					this.state = "dcs";
				}
				return;
			case "osc":
				if (code === 0x07 || code === 0x9c) this.state = "ground";
				return;
		}
	}

	private ground(code: number): void {
		if (this.utf8 && code >= 0x80) {
			this.utf8Bytes.push(code);
			const lead = this.utf8Bytes[0]!;
			const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
			if (this.utf8Bytes.length >= length) {
				const char = Buffer.from(this.utf8Bytes).toString("utf8");
				this.utf8Bytes = [];
				this.singleShift = 0;
				this.put(char);
			}
			return;
		}
		this.utf8Bytes = [];
		if (code === 0x1b) {
			this.state = "escape";
			this.buffer = "";
			return;
		}
		if (code < 0x20) {
			this.control(code);
			return;
		}
		if (code === 0x7f) return;
		if (code >= 0x80 && code < 0xa0) {
			if (code === 0x9b) {
				this.state = "csi";
				this.buffer = "";
			} else if (code === 0x90) {
				this.state = "dcs";
				this.dcsData = "";
			}
			return;
		}
		this.print(code);
	}

	private control(code: number): void {
		switch (code) {
			case 0x08:
				if (this.statusActive) this.statusCol = Math.max(0, this.statusCol - 1);
				else this.col = Math.max(0, this.col - 1);
				this.pendingWrap = false;
				return;
			case 0x09: {
				const width = this.width(this.current());
				const next = Math.min(width - 1, (Math.floor((this.statusActive ? this.statusCol : this.col) / 8) + 1) * 8);
				if (this.statusActive) this.statusCol = next;
				else this.col = next;
				return;
			}
			case 0x0a:
			case 0x0b:
			case 0x0c:
				if (this.statusActive) return;
				this.index();
				if (this.lineFeedNewLine) this.col = 0;
				return;
			case 0x0d:
				if (this.statusActive) this.statusCol = 0;
				else this.col = 0;
				this.pendingWrap = false;
				return;
			case 0x0e:
				this.gl = 1;
				return;
			case 0x0f:
				this.gl = 0;
				return;
		}
	}

	private escape(code: number): void {
		const char = String.fromCharCode(code);
		if (code >= 0x20 && code <= 0x2f) {
			this.buffer += char;
			return;
		}
		const intermediates = this.buffer;
		this.buffer = "";
		this.state = "ground";
		if (intermediates === "") {
			switch (char) {
				case "[":
					this.state = "csi";
					return;
				case "P":
					this.state = "dcs";
					this.dcsData = "";
					return;
				case "]":
					this.state = "osc";
					return;
				case "D":
					this.index();
					return;
				case "E":
					this.col = 0;
					this.index();
					return;
				case "M":
					this.reverseIndex();
					return;
				case "7":
					this.saved = {
						row: this.row,
						col: this.col,
						sgr: this.sgr,
						gl: this.gl,
						gr: this.gr,
						designations: [...this.designations],
					};
					return;
				case "8":
					if (this.saved) {
						this.row = this.saved.row;
						this.col = this.saved.col;
						this.sgr = this.saved.sgr;
						this.gl = this.saved.gl;
						this.gr = this.saved.gr;
						this.designations = [...this.saved.designations];
					}
					return;
				case "n":
					this.gl = 2;
					return;
				case "o":
					this.gl = 3;
					return;
				case "~":
					this.gr = 1;
					return;
				case "}":
					this.gr = 2;
					return;
				case "|":
					this.gr = 3;
					return;
				case "N":
					this.singleShift = 2;
					return;
				case "O":
					this.singleShift = 3;
					return;
				case "c":
					this.reset();
					return;
				default:
					return;
			}
		}
		if (intermediates === "#") {
			if (char === "8") {
				for (const line of this.lines) {
					line.chars.fill("E");
					line.attrs.fill(0);
					line.lineAttr = 0;
				}
				return;
			}
			const attr = { "5": 0, "6": 1, "3": 2, "4": 3 }[char];
			if (attr === undefined || this.statusActive || !this.lineAttributes) return;
			const line = this.lines[this.row]!;
			if (attr !== 0 && line.lineAttr === 0) {
				const half = Math.floor(this.columns / 2);
				line.chars.fill(" ", half);
				line.attrs.fill(0, half);
			}
			line.lineAttr = attr;
			this.col = Math.min(this.col, this.width(line) - 1);
			return;
		}
		const slot94 = "()*+".indexOf(intermediates[0] ?? "");
		const slot96 = "-./".indexOf(intermediates[0] ?? "") + 1;
		const final = intermediates.slice(1) + char;
		if (slot94 >= 0) {
			const designation: Designation | undefined =
				final === "B"
					? "ascii"
					: final === "0"
						? "graphics"
						: final === ">"
							? "technical"
							: final === "%5"
								? "dec-supplemental"
								: final === "<"
									? this.userPreferred === "latin1"
										? "latin1"
										: "dec-supplemental"
									: undefined;
			if (designation) this.designations[slot94] = designation;
		} else if (slot96 > 0 && final === "A") {
			this.designations[slot96] = "latin1";
		}
	}

	private print(byte: number): void {
		const invoked = this.singleShift || (byte >= 0x80 ? this.gr : this.gl);
		this.singleShift = 0;
		const code = byte & 0x7f;
		const designation = this.designations[invoked]!;
		let char: string | undefined;
		if (byte === 0x20) char = " ";
		else {
			switch (designation) {
				case "ascii":
					char = String.fromCharCode(code);
					break;
				case "graphics":
					char = code < 0x5f ? String.fromCharCode(code) : SPECIAL_GRAPHICS.get(code);
					break;
				case "technical":
					char = TECHNICAL.get(code) ?? TECHNICAL_SIGMA_PREVIEW.get(code);
					break;
				case "dec-supplemental":
					char = DEC_SUPPLEMENTAL.get(code);
					break;
				case "latin1":
					char = LATIN1_SUPPLEMENTAL.get(code);
					break;
			}
		}
		this.put(char ?? "□");
	}

	private put(char: string): void {
		if (this.statusActive) {
			if (this.statusCol < this.columns) {
				this.status.chars[this.statusCol] = char;
				this.status.attrs[this.statusCol] = this.sgr;
			}
			this.statusCol = Math.min(this.statusCol + 1, this.columns - 1);
			return;
		}
		let line = this.lines[this.row]!;
		if (this.pendingWrap && this.autowrap) {
			this.col = 0;
			this.index();
			line = this.lines[this.row]!;
		}
		this.pendingWrap = false;
		const width = this.width(line);
		line.chars[this.col] = char;
		line.attrs[this.col] = this.sgr;
		if (this.col >= width - 1) {
			if (this.autowrap) this.pendingWrap = true;
		} else {
			this.col++;
		}
	}

	private index(): void {
		this.pendingWrap = false;
		if (this.row === this.bottom) this.scrollUp(1);
		else if (this.row < this.rows - 1) this.row++;
	}

	private reverseIndex(): void {
		this.pendingWrap = false;
		if (this.row === this.top) this.scrollDown(1);
		else if (this.row > 0) this.row--;
	}

	private scrollUp(count: number): void {
		for (let i = 0; i < count; i++) {
			this.lines.splice(this.top, 1);
			this.lines.splice(this.bottom, 0, this.blankLine());
		}
	}

	private scrollDown(count: number): void {
		for (let i = 0; i < count; i++) {
			this.lines.splice(this.bottom, 1);
			this.lines.splice(this.top, 0, this.blankLine());
		}
	}

	private csi(sequence: string): void {
		const final = sequence.at(-1)!;
		let body = sequence.slice(0, -1);
		let prefix = "";
		if (body.startsWith("?") || body.startsWith(">") || body.startsWith("=")) {
			prefix = body[0]!;
			body = body.slice(1);
		}
		const intermediateMatch = /[ -/]+$/.exec(body);
		const intermediates = intermediateMatch?.[0] ?? "";
		const paramText = intermediates ? body.slice(0, -intermediates.length) : body;
		const params = paramText === "" ? [] : paramText.split(";").map((part) => (part === "" ? 0 : Number(part)));
		const param = (index: number, fallback: number): number => {
			const value = params[index];
			return value === undefined || value === 0 ? fallback : value;
		};
		const key = `${prefix}${intermediates}${final}`;
		switch (key) {
			case "A":
				this.moveVertical(-param(0, 1));
				return;
			case "B":
				this.moveVertical(param(0, 1));
				return;
			case "C":
				if (this.statusActive) this.statusCol = Math.min(this.columns - 1, this.statusCol + param(0, 1));
				else this.col = Math.min(this.width(this.lines[this.row]!) - 1, this.col + param(0, 1));
				this.pendingWrap = false;
				return;
			case "D":
				if (this.statusActive) this.statusCol = Math.max(0, this.statusCol - param(0, 1));
				else this.col = Math.max(0, this.col - param(0, 1));
				this.pendingWrap = false;
				return;
			case "H":
			case "f":
				if (this.statusActive) {
					this.statusCol = Math.min(this.columns - 1, param(1, 1) - 1);
					return;
				}
				this.row = Math.min(this.rows - 1, param(0, 1) - 1);
				this.col = Math.min(this.width(this.lines[this.row]!) - 1, param(1, 1) - 1);
				this.pendingWrap = false;
				return;
			case "J":
				this.eraseDisplay(params[0] ?? 0);
				return;
			case "K":
				this.eraseLine(params[0] ?? 0);
				return;
			case "X": {
				const line = this.current();
				const start = this.statusActive ? this.statusCol : this.col;
				const end = Math.min(this.width(line), start + param(0, 1));
				line.chars.fill(" ", start, end);
				line.attrs.fill(0, start, end);
				return;
			}
			case "P": {
				// characters right of the cursor move left with their attributes; blanks enter at the margin
				const line = this.current();
				const start = this.statusActive ? this.statusCol : this.col;
				const width = this.width(line);
				const count = Math.min(width - start, param(0, 1));
				line.chars.copyWithin(start, start + count, width);
				line.attrs.copyWithin(start, start + count, width);
				line.chars.fill(" ", width - count, width);
				line.attrs.fill(0, width - count, width);
				this.pendingWrap = false;
				return;
			}
			case "m":
				this.setRendition(params);
				return;
			case "r":
				this.top = param(0, 1) - 1;
				this.bottom = Math.min(this.rows - 1, param(1, this.rows) - 1);
				this.row = 0;
				this.col = 0;
				return;
			case "?h":
			case "?l":
				for (const mode of params) this.privateMode(mode, final === "h");
				return;
			case "h":
			case "l":
				if (params.includes(20)) this.lineFeedNewLine = final === "h";
				return;
			case "$x":
				this.fillRectangle(params);
				return;
			case "$t":
				this.reverseAttributes(params);
				return;
			case "*x":
				this.attributeExtent = params[0] ?? 0;
				return;
			case "$z":
				this.eraseRectangle(param(0, 1) - 1, param(1, 1) - 1, param(2, this.rows) - 1, param(3, this.columns) - 1);
				return;
			case "$}": {
				const active = this.statusType === 2 && param(0, 0) === 1;
				if (active && !this.statusActive) {
					this.mainState = {
						row: this.row,
						col: this.col,
						sgr: this.sgr,
						gl: this.gl,
						gr: this.gr,
						designations: [...this.designations],
					};
					if (this.statusStateMode !== "inherit") {
						({ sgr: this.sgr, gl: this.gl, gr: this.gr, col: this.statusCol } = this.statusState);
					}
					if (this.statusStateMode === "isolated") this.designations = [...this.statusState.designations];
				} else if (!active && this.statusActive) {
					this.statusState = {
						sgr: this.sgr,
						gl: this.gl,
						gr: this.gr,
						col: this.statusCol,
						designations: [...this.designations],
					};
					({ row: this.row, col: this.col, sgr: this.sgr, gl: this.gl, gr: this.gr } = this.mainState);
					this.designations = [...this.mainState.designations];
				}
				this.singleShift = 0;
				this.statusActive = active;
				return;
			}
			case "$~": {
				const type = params[0] ?? 0;
				if (type === 2 && this.statusType !== 2) this.status = this.blankLine();
				this.statusType = type;
				if (type !== 2) this.statusActive = false;
				return;
			}
			case "c":
				this.respond(this.identity === "vt220" ? "\x1b[?62;1;2;6;7;8;9c" : "\x1b[?64;1;2;6;7;8;9;15;18;19;21c");
				return;
			case ">c":
				this.respond(this.identity === "vt220" ? "\x1b[>1;10;0c" : "\x1b[>41;10;0c");
				return;
			case "n":
				if (params[0] === 5) this.respond("\x1b[0n");
				if (params[0] === 6) this.respond(`\x1b[${this.row + 1};${this.col + 1}R`);
				return;
			case '"v':
				this.respond(`\x1b[${this.rows};${this.columns};1;1;1"w`);
				return;
			case "&u":
				this.respond(this.userPreferred === "latin1" ? "\x1bP1!uA\x1b\\" : "\x1bP0!u%5\x1b\\");
				return;
			case "?$p":
				this.respond(`\x1b[?${params[0] ?? 0};${this.privateModeValue(params[0] ?? 0)}$y`);
				return;
			case "$p":
				this.respond(`\x1b[${params[0] ?? 0};${params[0] === 20 ? (this.lineFeedNewLine ? 1 : 2) : 2}$y`);
				return;
			default:
				return;
		}
	}

	private finishDcs(): void {
		this.state = "ground";
		const data = this.dcsData;
		this.dcsData = "";
		if (!data.startsWith("$q")) return;
		const request = data.slice(2);
		if (request === "$~") this.respond(`\x1bP0$r${this.statusType}$~\x1b\\`);
		else if (request === "*x") this.respond(`\x1bP0$r${this.attributeExtent}*x\x1b\\`);
		else if (request === "$|") this.respond(`\x1bP0$r${this.columns}$|\x1b\\`);
		else if (request === "*|") this.respond(`\x1bP0$r${this.rows}*|\x1b\\`);
		else this.respond("\x1bP1$r\x1b\\");
	}

	private respond(bytes: string): void {
		// A VT220 has no DECRQSS, DECRQM, DECRQDE or DECRQUPSS.
		if (this.identity === "vt220" && !/^\x1b\[(\?62;|>1;|\d+;\d+R)/.test(bytes)) return;
		this.onResponse?.(bytes);
	}

	private privateModeValue(mode: number): number {
		if (mode === 7) return this.autowrap ? 1 : 2;
		if (mode === 25) return this.cursorVisible ? 1 : 2;
		if (mode === 5) return this.screenReverse ? 1 : 2;
		if ([1, 6, 66, 67].includes(mode)) return 2;
		return 0;
	}

	private privateMode(mode: number, set: boolean): void {
		if (mode === 7) {
			this.autowrap = set;
			this.pendingWrap = false;
		} else if (mode === 25) this.cursorVisible = set;
		else if (mode === 5) this.screenReverse = set;
	}

	private moveVertical(delta: number): void {
		if (this.statusActive) return;
		const inRegion = this.row >= this.top && this.row <= this.bottom;
		const min = inRegion ? this.top : 0;
		const max = inRegion ? this.bottom : this.rows - 1;
		this.row = Math.max(min, Math.min(max, this.row + delta));
		this.col = Math.min(this.col, this.width(this.lines[this.row]!) - 1);
		this.pendingWrap = false;
	}

	private eraseDisplay(mode: number): void {
		if (this.statusActive) {
			this.status = this.blankLine();
			return;
		}
		const eraseRow = (row: number, from: number, to: number): void => {
			const line = this.lines[row]!;
			line.chars.fill(" ", from, to);
			line.attrs.fill(0, from, to);
		};
		if (mode === 2) {
			for (let row = 0; row < this.rows; row++) this.lines[row] = this.blankLine();
			return;
		}
		if (mode === 0) {
			eraseRow(this.row, this.col, this.columns);
			for (let row = this.row + 1; row < this.rows; row++) this.lines[row] = this.blankLine();
		} else if (mode === 1) {
			eraseRow(this.row, 0, this.col + 1);
			for (let row = 0; row < this.row; row++) this.lines[row] = this.blankLine();
		}
	}

	private eraseLine(mode: number): void {
		const line = this.current();
		const col = this.statusActive ? this.statusCol : this.col;
		const [from, to] = mode === 0 ? [col, this.columns] : mode === 1 ? [0, col + 1] : [0, this.columns];
		line.chars.fill(" ", from, to);
		line.attrs.fill(0, from, to);
	}

	private setRendition(params: number[]): void {
		if (params.length === 0) params = [0];
		for (const value of params) {
			if (value === 0) this.sgr = 0;
			else if (value === 1) this.sgr |= EMU_BOLD;
			else if (value === 4) this.sgr |= EMU_UNDERLINE;
			else if (value === 5) this.sgr |= EMU_BLINK;
			else if (value === 7) this.sgr |= EMU_REVERSE;
			else if (value === 22) this.sgr &= ~EMU_BOLD;
			else if (value === 24) this.sgr &= ~EMU_UNDERLINE;
			else if (value === 25) this.sgr &= ~EMU_BLINK;
			else if (value === 27) this.sgr &= ~EMU_REVERSE;
		}
	}

	private fillRectangle(params: number[]): void {
		const pch = params[0] ?? 0;
		if (!((pch >= 32 && pch <= 126) || (pch >= 160 && pch <= 255))) return;
		const top = (params[1] || 1) - 1;
		const left = (params[2] || 1) - 1;
		const bottom = Math.min(this.rows, params[3] || this.rows) - 1;
		const right = Math.min(this.columns, params[4] || this.columns) - 1;
		const savedShift = this.singleShift;
		for (let row = top; row <= bottom; row++) {
			const line = this.lines[row]!;
			for (let col = left; col <= right; col++) {
				this.singleShift = 0;
				const designation = this.designations[pch >= 0x80 ? this.gr : this.gl]!;
				const code = pch & 0x7f;
				let char: string | undefined;
				if (code === 0x20) char = " ";
				else if (designation === "ascii") char = String.fromCharCode(code);
				else if (designation === "graphics")
					char = code < 0x5f ? String.fromCharCode(code) : SPECIAL_GRAPHICS.get(code);
				else if (designation === "technical") char = TECHNICAL.get(code);
				else if (designation === "dec-supplemental") char = DEC_SUPPLEMENTAL.get(code);
				else char = LATIN1_SUPPLEMENTAL.get(code);
				line.chars[col] = char ?? "□";
				line.attrs[col] = this.sgr;
			}
		}
		this.singleShift = savedShift;
	}

	/** DECRARA: toggle attributes in a rectangle, or from the first position to the last across lines. */
	private reverseAttributes(params: number[]): void {
		const top = Math.max(0, (params[0] || 1) - 1);
		const left = Math.max(0, (params[1] || 1) - 1);
		const bottom = Math.min(this.rows - 1, (params[2] || this.rows) - 1);
		const right = Math.min(this.columns - 1, (params[3] || this.columns) - 1);
		let mask = 0;
		for (const value of params.slice(4).length > 0 ? params.slice(4) : [0]) {
			if (value === 0) mask |= EMU_BOLD | EMU_UNDERLINE | EMU_BLINK | EMU_REVERSE;
			else if (value === 1) mask |= EMU_BOLD;
			else if (value === 4) mask |= EMU_UNDERLINE;
			else if (value === 5) mask |= EMU_BLINK;
			else if (value === 7) mask |= EMU_REVERSE;
		}
		const rectangle = this.attributeExtent === 2;
		for (let row = top; row <= bottom; row++) {
			const line = this.lines[row]!;
			const from = rectangle || row === top ? left : 0;
			const to = Math.min(this.width(line) - 1, rectangle || row === bottom ? right : this.columns - 1);
			for (let col = from; col <= to; col++) line.attrs[col] = line.attrs[col]! ^ mask;
		}
	}

	private eraseRectangle(top: number, left: number, bottom: number, right: number): void {
		for (let row = top; row <= bottom; row++) {
			const line = this.lines[row]!;
			line.chars.fill(" ", left, right + 1);
			line.attrs.fill(0, left, right + 1);
		}
	}

	private reset(): void {
		for (let row = 0; row < this.rows; row++) this.lines[row] = this.blankLine();
		this.row = 0;
		this.col = 0;
		this.sgr = 0;
		this.designations = ["ascii", "ascii", "dec-supplemental", "dec-supplemental"];
		this.gl = 0;
		this.gr = 2;
		this.top = 0;
		this.bottom = this.rows - 1;
		this.autowrap = true;
		this.statusActive = false;
	}
}
