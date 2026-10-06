// vt420-term's src/emu/vt420.ts (github.com/mrq1911/vt420-term), copied for these tests: change it there, then copy it here.
/**
 * A VT420 in memory: page memory, the status line, and every control function of the VT420 programmer reference
 * (EK-VT420-RM) that concerns one session, answered as the terminal answers.
 *
 * Bytes go in through `write`, answers come out through `onResponse`, and the screen is read from `pages`,
 * `displayPage`, `windowTop` and `status`. A scroll the terminal would glide (smooth scroll) stops `write` so a
 * display can animate it before the rest follows, as on the terminal, whose input waits while it glides.
 */

import {
	type CharsetId,
	charsetFor,
	DRCS_BASE,
	ERROR_CHAR,
	ERROR_CODE,
	finalFor,
	glyphIn,
	is96,
	isNational,
	storedCode,
} from "./charsets.ts";
import { Parser, type ParserHandler } from "./parser.ts";
import { loadSoftFont, type SoftFont } from "./softfont.ts";

export const ATTR_BOLD = 1;
export const ATTR_UNDERLINE = 2;
export const ATTR_BLINK = 4;
export const ATTR_REVERSE = 8;
export const ATTR_INVISIBLE = 16;
/** Not a visual attribute: DECSCA's protection from selective erase. */
export const ATTR_PROTECTED = 32;
const VISUAL = ATTR_BOLD | ATTR_UNDERLINE | ATTR_BLINK | ATTR_REVERSE | ATTR_INVISIBLE;
/** A cell's attributes keep the code the terminal stores its character as above these bits; an erased cell has 0. */
export const CODE_SHIFT = 8;
export const ATTR_FLAGS = (1 << CODE_SHIFT) - 1;

export const LINE_SINGLE = 0;
export const LINE_DOUBLE_WIDTH = 1;
export const LINE_DOUBLE_TOP = 2;
export const LINE_DOUBLE_BOTTOM = 3;

export interface EmuLine {
	chars: string[];
	attrs: number[];
	/** 0 single, 1 double width, 2 double-height top, 3 double-height bottom */
	lineAttr: number;
}

/** What Set-Up holds: the state at power-up and after a reset. */
export interface Vt420Setup {
	/** 80 or 132; others for tests of a smaller screen. */
	columns: number;
	/** Lines on the screen: 24, 36 or 48. */
	lines: number;
	/** Lines a page has (24, 25, 36, 48, 72 or 144), so many pages of them as page memory holds. */
	pageLines: number;
	/** 0 none, 1 indicator, 2 host-writable. */
	statusDisplay: number;
	autowrap: boolean;
	smoothScroll: boolean;
	newLine: boolean;
	userPreferred: "dec" | "latin1";
	/** 1 VT100 mode, 4 VT400 mode. */
	level: number;
	eightBitControls: boolean;
	answerback: string;
	udkLocked: boolean;
	/** The <X key sends BS rather than DEL. */
	backarrowBS: boolean;
	keypadApplication: boolean;
	cursorKeysApplication: boolean;
	/** National replacement character set mode, with the keyboard's set. */
	national: boolean;
	nationalSet: CharsetId;
	/** SRM reset: what is typed shows on the screen as well. */
	localEcho: boolean;
	transmitLimited: boolean;
	/** Characters in the input buffer that make the terminal send XOFF (64 or 128), or 0 for no XOFF. */
	xoff: number;
	/** The DA1 answer: the terminal itself or one it poses as. */
	alias: "vt420" | "vt320" | "vt220" | "vt100";
	/** The worldwide model, with the national replacement sets; the North American one has none. */
	worldwide: boolean;
}

/** The VT420 as it leaves the factory: the defaults of the programmer reference. */
export const FACTORY_SETUP: Vt420Setup = {
	columns: 80,
	lines: 24,
	pageLines: 24,
	statusDisplay: 1,
	autowrap: false,
	smoothScroll: true,
	newLine: false,
	userPreferred: "dec",
	level: 4,
	eightBitControls: false,
	answerback: "",
	udkLocked: false,
	backarrowBS: false,
	keypadApplication: false,
	cursorKeysApplication: false,
	national: false,
	nationalSet: "british",
	localEcho: false,
	transmitLimited: false,
	xoff: 64,
	alias: "vt420",
	worldwide: false,
};

/** The Set-Up pi-vt420 and vt420-term are made for, which their READMEs list: jump scroll, XOFF at 128, keys locked. */
export const RECOMMENDED_SETUP: Vt420Setup = {
	...FACTORY_SETUP,
	smoothScroll: false,
	udkLocked: true,
	xoff: 128,
};

export interface Vt420Options {
	setup?: Partial<Vt420Setup>;
	/** Answers to the host, as bytes in a latin1 string. */
	onResponse?: (bytes: string) => void;
	onBell?: () => void;
	/** The screen changed size: columns, and lines shown. */
	onResize?: (columns: number, lines: number) => void;
	/** Decode bytes from 0x80 as UTF-8, as a modern emulator does, rather than as C1 and GR. */
	utf8?: boolean;
	/** False ignores DECDWL and DECDHL, as most modern emulators do. */
	lineAttributes?: boolean;
	/**
	 * How the status line keeps the cursor state: "separate" keeps its own rendition and shifts, "inherit"
	 * continues with the main display's (xterm), "isolated" also keeps its own character set designations.
	 */
	statusState?: "separate" | "inherit" | "isolated";
	/** Pose as a VT220 in what is answered: DA and cursor position only. */
	identity?: "vt420" | "vt220";
	/** DEC private modes to pose as not knowing, as an earlier terminal or an emulator would. */
	unknownModes?: readonly number[];
}

/** A scroll to glide: lines `top` to `bottom` of the displayed page moved by a line; `lost` is the one pushed out. */
export interface SmoothScroll {
	top: number;
	bottom: number;
	/** 1 up (a line enters at the bottom), -1 down. */
	direction: 1 | -1;
	lost: EmuLine;
}

interface SavedCursor {
	row: number;
	col: number;
	page: number;
	sgr: number;
	protect: boolean;
	designations: CharsetId[];
	gl: number;
	gr: number;
	singleShift: number;
	pendingWrap: boolean;
	originMode: boolean;
}

/** Pages of page memory for each page length, one session (DECSLPP). */
const PAGE_ARRANGEMENTS: Readonly<Record<number, number>> = { 24: 6, 25: 5, 36: 4, 48: 3, 72: 2, 144: 1 };

/** ASCII in G0 and G1, the user-preferred supplemental set (`<`) in G2 and G3, as DECCIR reports them. */
const DEFAULT_DESIGNATIONS: readonly CharsetId[] = ["ascii", "ascii", "user-preferred", "user-preferred"];

/** Local functions on, F1 (Hold) and F3 (Set-Up) local, F2 and F4 sending their codes, Alt not reported. */
const DEFAULT_LOCAL_FUNCTIONS: ReadonlyMap<number, number> = new Map([
	[1, 1],
	[2, 1],
	[3, 1],
]);
const DEFAULT_LOCAL_FUNCTION_KEYS: ReadonlyMap<number, number> = new Map([
	[1, 1],
	[2, 2],
	[3, 1],
	[4, 2],
]);
const DEFAULT_MODIFIER_KEYS: ReadonlyMap<number, number> = new Map([
	[1, 1],
	[2, 1],
	[3, 1],
	[4, 1],
	[5, 3],
	[6, 3],
	[7, 1],
	[8, 1],
]);

/**
 * How long a VT420 (firmware 1.4) takes over its work, as vt420-probe measured it at 38400 baud: it takes in plain
 * text at about 2200 characters a second, slower than the line brings it, and a scroll without gliding waits for a
 * refresh of the screen. A serial line (line.ts) holds input back while the terminal works.
 */
export const TIMING = {
	byteMs: 0.45,
	jumpScrollMs: 13,
	glideMs: 94,
	eraseCellMs: 0.018,
	fillCellMs: 0.045,
};

/** UDK and macro memory, in bytes. */
const UDK_SPACE = 768;
const MACRO_SPACE = 6144;

/** ANSI modes the VT420 knows but keeps reset for good (Table 12-2). */
const PERMANENTLY_RESET = new Set([1, 5, 7, 10, 11, 13, 14, 15, 16, 17, 18, 19]);

export class Vt420 implements ParserHandler {
	setup: Vt420Setup;
	columns = 80;
	/** Lines the screen shows (DECSNLS) and lines a page has (DECSLPP). */
	screenLines = 24;
	pageLines = 24;
	pages: EmuLine[][] = [];
	/** The page with the cursor, and the one shown. */
	page = 0;
	displayPage = 0;
	/** The page line at the top of the screen, when a page is longer than the screen. */
	windowTop = 0;
	row = 0;
	col = 0;
	pendingWrap = false;
	status: EmuLine;
	statusType = 1;
	statusActive = false;
	statusCol = 0;
	sgr = 0;
	protect = false;
	designations: CharsetId[] = [...DEFAULT_DESIGNATIONS];
	gl = 0;
	gr = 2;
	singleShift = 0;
	top = 0;
	bottom = 23;
	left = 0;
	right = 79;
	tabs: boolean[] = [];
	attributeExtent = 0;
	/** 1 VT100 mode, 4 VT400 mode. */
	level = 4;
	/** C1 controls sent as 8-bit codes (S8C1T). */
	eightBitControls = false;
	vt52 = false;
	vt52Graphics = false;
	// modes
	keyboardLocked = false;
	insertMode = false;
	localEcho = false;
	newLine = false;
	cursorKeysApplication = false;
	smoothScroll = false;
	screenReverse = false;
	originMode = false;
	autowrap = true;
	autorepeat = true;
	printFormFeed = false;
	printExtent = false;
	cursorVisible = true;
	national = false;
	horizontalCoupling = true;
	verticalCoupling = true;
	pageCoupling = true;
	keypadApplication = false;
	backarrowBS = false;
	dataProcessingKeys = false;
	leftRightMarginMode = false;
	transmitLimited = true;
	keyPositionMode = false;
	userPreferred: "dec" | "latin1" = "dec";
	udkShifted = new Map<number, string>();
	udkUnshifted = new Map<number, string>();
	udkLocked = false;
	macros = new Map<number, string>();
	softFonts: SoftFont[] = [];
	/** Data goes to the printer, which is not there, until CSI 4 i. */
	printerController = false;
	/** Set when a scroll is to glide; `write` stops after it until the display clears it. */
	smoothScrollEvent: SmoothScroll | undefined;
	/** Bytes taken in, for tests. */
	bytes = 0;
	/** Milliseconds of work the bytes taken in since this was last cleared would take the terminal (see TIMING). */
	busyMs = 0;
	readonly parser: Parser;
	private readonly options: Vt420Options;
	private saved: SavedCursor | undefined;
	private statusSaved: SavedCursor | undefined;
	private mainState: SavedCursor | undefined;
	private statusState = { sgr: 0, protect: false, gl: 0, gr: 2, designations: [...DEFAULT_DESIGNATIONS] };
	private vt52Args: number[] | undefined;
	private printerMatch = 0;
	private macroDepth = 0;
	/** DECELF, DECLFKC and DECSMKR: function or key number to its setting, as a VT420 had them after power-up. */
	localFunctions = new Map(DEFAULT_LOCAL_FUNCTIONS);
	localFunctionKeys = new Map(DEFAULT_LOCAL_FUNCTION_KEYS);
	modifierKeys = new Map(DEFAULT_MODIFIER_KEYS);
	/** Data integrity (DSR 75): not reported since power-up, an error on the line since the last report, or none. */
	integrity: "unreported" | "ok" | "error" = "unreported";
	private glide = false;

	constructor(options: Vt420Options = {}) {
		this.options = options;
		this.setup = { ...FACTORY_SETUP, ...options.setup };
		this.parser = new Parser(this, options.utf8 ?? false);
		this.status = this.blankLine();
		this.powerUp();
	}

	/** Lines of the page shown on the screen. */
	get visibleLines(): number {
		return Math.min(this.screenLines + (this.statusType === 0 ? 1 : 0), this.pageLines);
	}

	get pageCount(): number {
		return this.pages.length;
	}

	/** The lines of the page with the cursor. */
	get lines(): EmuLine[] {
		return this.pages[this.page]!;
	}

	/** Take bytes in; a string is taken as bytes, one per character. */
	feed(data: string | Uint8Array): void {
		const bytes = typeof data === "string" ? latin1Bytes(data) : data;
		this.write(bytes, 0, bytes.length, false);
		this.smoothScrollEvent = undefined;
	}

	/**
	 * Take bytes in until a scroll is to glide, if `glide`; the index after the last byte taken. The display
	 * animates `smoothScrollEvent`, clears it and calls again with the rest.
	 */
	write(bytes: Uint8Array, start = 0, end = bytes.length, glide = true): number {
		this.glide = glide;
		for (let i = start; i < end; i++) {
			const code = bytes[i]!;
			this.bytes++;
			this.busyMs += TIMING.byteMs;
			if (this.printerController) {
				this.printerByte(code);
				continue;
			}
			this.parser.byte(code);
			if (this.smoothScrollEvent && glide) return i + 1;
		}
		return end;
	}

	// ---- what a display reads

	/** The line of the displayed page on screen row `row`. */
	screenLine(row: number): EmuLine | undefined {
		return this.pages[this.displayPage]?.[this.windowTop + row];
	}

	/** Visible text of a row of the page with the cursor, right-trimmed; a double-width row has half the columns. */
	text(row: number): string {
		const line = this.lines[row]!;
		return line.chars.slice(0, this.lineWidth(line)).join("").replace(/\s+$/u, "");
	}

	statusText(): string {
		return this.status.chars.join("").replace(/\s+$/u, "");
	}

	screen(): string[] {
		return this.lines.map((_, row) => this.text(row));
	}

	attrsAt(row: number, col: number): number {
		return this.lines[row]!.attrs[col]! & ATTR_FLAGS;
	}

	lineAttr(row: number): number {
		return this.lines[row]!.lineAttr;
	}

	/** Where the cursor shows, if anywhere: a screen row (the status line is `visibleLines`) and a column. */
	cursorOnScreen(): { row: number; col: number } | undefined {
		if (!this.cursorVisible) return undefined;
		if (this.statusActive) return { row: this.visibleLines, col: this.statusCol };
		if (this.page !== this.displayPage) return undefined;
		const row = this.row - this.windowTop;
		if (row < 0 || row >= this.visibleLines) return undefined;
		return { row, col: this.col };
	}

	/** The soft font for a character drawn with DRCS_BASE, the one for this screen size first. */
	softGlyph(char: string): { font: SoftFont; rows: number[] } | undefined {
		const code = (char.codePointAt(0) ?? 0) - DRCS_BASE;
		if (code < 0x20 || code > 0x7f) return undefined;
		const fonts = [...this.softFonts].sort(
			(a, b) =>
				Number(b.columns === this.columns && b.lines === this.screenLines) -
				Number(a.columns === this.columns && a.lines === this.screenLines),
		);
		for (const font of fonts) {
			const glyph = font.glyphs.get(code);
			if (glyph) return { font, rows: glyph.rows };
		}
		return undefined;
	}

	// ---- resets

	/** Power-up, or RIS: Set-Up's settings, and nothing else kept. */
	powerUp(): void {
		const setup = this.setup;
		this.level = setup.level;
		this.eightBitControls = setup.eightBitControls && setup.level > 1;
		this.columns = setup.columns;
		this.screenLines = setup.lines;
		this.pageLines = setup.pageLines;
		this.allocatePages();
		this.statusType = setup.statusDisplay;
		this.status = this.blankLine();
		this.statusActive = false;
		this.statusCol = 0;
		this.statusState = { sgr: 0, protect: false, gl: 0, gr: 2, designations: [...DEFAULT_DESIGNATIONS] };
		this.statusSaved = undefined;
		this.page = 0;
		this.displayPage = 0;
		this.windowTop = 0;
		this.row = 0;
		this.col = 0;
		this.vt52 = false;
		this.vt52Graphics = false;
		this.vt52Args = undefined;
		this.userPreferred = setup.userPreferred;
		this.udkShifted.clear();
		this.udkUnshifted.clear();
		this.udkLocked = setup.udkLocked;
		this.macros.clear();
		this.softFonts = [];
		this.localFunctions = new Map(DEFAULT_LOCAL_FUNCTIONS);
		this.localFunctionKeys = new Map(DEFAULT_LOCAL_FUNCTION_KEYS);
		this.integrity = "unreported";
		this.printerController = false;
		this.screenReverse = false;
		this.smoothScroll = setup.smoothScroll;
		this.autowrap = setup.autowrap;
		this.newLine = setup.newLine;
		this.localEcho = setup.localEcho;
		this.cursorKeysApplication = setup.cursorKeysApplication;
		this.keypadApplication = setup.keypadApplication;
		this.backarrowBS = setup.backarrowBS;
		this.transmitLimited = setup.transmitLimited;
		this.autorepeat = true;
		this.horizontalCoupling = true;
		this.verticalCoupling = true;
		this.pageCoupling = true;
		this.dataProcessingKeys = false;
		this.printFormFeed = false;
		this.printExtent = false;
		this.national = setup.national;
		this.resetTabs();
		this.softReset();
		this.autowrap = setup.autowrap;
		this.saved = undefined;
		this.parser.reset();
		this.options.onResize?.(this.columns, this.visibleLines);
	}

	/** A change made in Set-Up: kept for the next reset, and in effect at once, as on the terminal. */
	changeSetup(change: Partial<Vt420Setup>): void {
		this.setup = { ...this.setup, ...change };
		if (change.level !== undefined && change.level !== this.level) {
			this.powerUp();
			return;
		}
		if (change.columns !== undefined) this.setColumns(change.columns === 132 ? 132 : 80, false);
		if (change.lines !== undefined) this.setScreenLines(change.lines);
		if (change.pageLines !== undefined) this.setPageLength(change.pageLines);
		if (change.statusDisplay !== undefined && change.statusDisplay !== this.statusType) {
			if (change.statusDisplay === 2) this.status = this.blankLine();
			if (this.statusActive) this.leaveStatusLine();
			this.statusType = change.statusDisplay;
			this.options.onResize?.(this.columns, this.visibleLines);
		}
		if (change.national !== undefined) this.privateMode(42, change.national);
		if (change.nationalSet !== undefined && this.national) this.designations = this.defaultDesignations();
		this.autowrap = change.autowrap ?? this.autowrap;
		this.smoothScroll = change.smoothScroll ?? this.smoothScroll;
		this.newLine = change.newLine ?? this.newLine;
		this.userPreferred = change.userPreferred ?? this.userPreferred;
		this.eightBitControls = (change.eightBitControls ?? this.eightBitControls) && this.level > 1;
		this.udkLocked = change.udkLocked ?? this.udkLocked;
		this.backarrowBS = change.backarrowBS ?? this.backarrowBS;
		this.keypadApplication = change.keypadApplication ?? this.keypadApplication;
		this.cursorKeysApplication = change.cursorKeysApplication ?? this.cursorKeysApplication;
		this.localEcho = change.localEcho ?? this.localEcho;
		this.transmitLimited = change.transmitLimited ?? this.transmitLimited;
	}

	/** DECSTR (Table 13-1). */
	softReset(): void {
		this.cursorVisible = true;
		this.insertMode = false;
		this.originMode = false;
		// Table 13-1: no autowrap, whatever Set-Up has
		this.autowrap = false;
		this.keyboardLocked = false;
		this.keypadApplication = false;
		this.cursorKeysApplication = false;
		this.keyPositionMode = false;
		this.modifierKeys = new Map(DEFAULT_MODIFIER_KEYS);
		this.leftRightMarginMode = false;
		this.top = 0;
		this.bottom = this.pageLines - 1;
		this.left = 0;
		this.right = this.columns - 1;
		this.designations = this.defaultDesignations();
		this.gl = 0;
		this.gr = 2;
		this.singleShift = 0;
		this.sgr = 0;
		this.protect = false;
		this.pendingWrap = false;
		this.saved = undefined;
		this.userPreferred = this.setup.userPreferred;
		if (this.statusActive) this.leaveStatusLine();
	}

	// ---- parser callbacks

	print(code: number): void {
		if (this.vt52Args) {
			this.vt52Argument(code);
			return;
		}
		let char: string | undefined;
		let stored = code;
		if (code >= 0x80 && this.options.utf8) {
			char = String.fromCodePoint(code);
			this.singleShift = 0;
		} else {
			const set = this.singleShift || (code >= 0x80 ? this.gr : this.gl);
			this.singleShift = 0;
			const id = this.vt52 ? (this.vt52Graphics && code >= 0x5f ? "graphics" : "ascii") : this.designations[set]!;
			const seven = code & 0x7f;
			const wide = is96(id, this.softFontFor(id)?.size96 ?? false, this.userPreferred);
			if (seven === 0x7f && !wide) return;
			// a space in GL is a space whatever the set; 0xA0 in a 94-character set is not a character
			const glyph =
				code === 0x20
					? " "
					: seven === 0x20 && !wide
						? undefined
						: id === "drcs" && !this.softFontFor(id)
							? undefined
							: glyphIn(id, seven, this.userPreferred);
			char = glyph ?? ERROR_CHAR;
			stored = glyph === undefined ? ERROR_CODE : storedCode(id, seven, this.userPreferred);
		}
		this.put(char, stored);
		this.couple();
	}

	execute(code: number): void {
		switch (code) {
			case 0x05:
				this.respond(this.setup.answerback);
				break;
			case 0x07:
				this.options.onBell?.();
				break;
			case 0x08:
				this.backspace();
				break;
			case 0x09:
				this.tab();
				break;
			case 0x0a:
			case 0x0b:
			case 0x0c:
				this.lineFeed();
				break;
			case 0x0d:
				this.carriageReturn();
				break;
			case 0x0e:
				if (!this.vt52) this.gl = 1;
				break;
			case 0x0f:
				if (!this.vt52) this.gl = 0;
				break;
			case 0x84:
				this.index();
				break;
			case 0x85:
				this.carriageReturn();
				this.index();
				break;
			case 0x88:
				this.setTab();
				break;
			case 0x8d:
				this.reverseIndex();
				break;
			case 0x8e:
				this.singleShift = 2;
				break;
			case 0x8f:
				this.singleShift = 3;
				break;
			case 0x9a:
				this.identify();
				break;
		}
		this.couple();
	}

	substitute(): void {
		this.vt52Args = undefined;
		this.put(ERROR_CHAR, ERROR_CODE);
		this.couple();
	}

	esc(intermediates: string, final: number): void {
		if (this.vt52) this.vt52Escape(intermediates, final);
		else this.escape(intermediates, final);
		this.couple();
	}

	csi(prefix: string, params: number[], intermediates: string, final: number): void {
		if (this.vt52) return;
		this.control(prefix, params, intermediates, String.fromCharCode(final));
		this.couple();
	}

	dcs(prefix: string, params: number[], intermediates: string, final: number, data: string): void {
		if (this.vt52 || prefix !== "") return;
		this.deviceControl(params, intermediates + String.fromCharCode(final), data);
		this.couple();
	}

	// ---- escape sequences

	private escape(intermediates: string, final: number): void {
		const char = String.fromCharCode(final);
		if (intermediates === "") {
			switch (char) {
				case "7":
					this.saveCursor();
					return;
				case "8":
					this.restoreCursor();
					return;
				case "=":
					this.keypadApplication = true;
					return;
				case ">":
					this.keypadApplication = false;
					return;
				case "D":
					this.index();
					return;
				case "E":
					this.carriageReturn();
					this.index();
					return;
				case "H":
					this.setTab();
					return;
				case "M":
					this.reverseIndex();
					return;
				case "N":
					this.singleShift = 2;
					return;
				case "O":
					this.singleShift = 3;
					return;
				case "Z":
					this.identify();
					return;
				case "c":
					this.powerUp();
					return;
				case "6":
					this.backIndex();
					return;
				case "9":
					this.forwardIndex();
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
			}
			return;
		}
		if (intermediates === "#") {
			this.lineAttributeOrAlignment(char);
			return;
		}
		if (intermediates === " ") {
			if (char === "F" && this.level > 1) this.eightBitControls = false;
			if (char === "G" && this.level > 1) this.eightBitControls = true;
			return;
		}
		const slot94 = "()*+".indexOf(intermediates[0]!);
		const slot96 = "-./".indexOf(intermediates[0]!) + 1;
		if (slot94 < 0 && slot96 <= 0) return;
		const name = intermediates.slice(1) + char;
		const size96 = slot96 > 0;
		const slot = size96 ? slot96 : slot94;
		const font = this.softFonts.find((candidate) => candidate.name === name && candidate.size96 === size96);
		const id: CharsetId | undefined = font ? "drcs" : charsetFor(name, size96);
		if (id === undefined) return;
		// national sets on the worldwide model, in national mode (the British one is a VT100's too)
		if (isNational(id) && (!this.setup.worldwide || (id !== "british" && !this.national))) return;
		if (this.level === 1 && !["ascii", "graphics"].includes(id) && !isNational(id)) return;
		if (id === "drcs") this.drcsName = name;
		this.designations[slot] = id;
	}

	/** G0-G3 at power-up and reset: in national mode the keyboard's set takes ASCII's place. */
	private defaultDesignations(): CharsetId[] {
		if (!this.national) return [...DEFAULT_DESIGNATIONS];
		const set = this.setup.nationalSet;
		return [set, set, "dec-supplemental", "dec-supplemental"];
	}

	/** The name of the soft set in the designations, for DECCIR. */
	private drcsName = "";

	private softFontFor(id: CharsetId): SoftFont | undefined {
		if (id !== "drcs") return undefined;
		return this.softFonts.find((font) => font.name === this.drcsName);
	}

	private lineAttributeOrAlignment(char: string): void {
		if (char === "8") {
			// DECALN: the page filled with E, margins to the page, the cursor home
			for (const line of this.lines) {
				line.chars.fill("E");
				line.attrs.fill(0x45 << CODE_SHIFT);
				line.lineAttr = LINE_SINGLE;
			}
			this.top = 0;
			this.bottom = this.pageLines - 1;
			this.left = 0;
			this.right = this.columns - 1;
			this.row = 0;
			this.col = 0;
			this.pendingWrap = false;
			return;
		}
		const attr = { "5": LINE_SINGLE, "6": LINE_DOUBLE_WIDTH, "3": LINE_DOUBLE_TOP, "4": LINE_DOUBLE_BOTTOM }[char];
		if (attr === undefined || this.statusActive) return;
		if (attr !== LINE_SINGLE && (this.leftRightMarginMode || this.options.lineAttributes === false)) return;
		const line = this.lines[this.row]!;
		if (attr !== LINE_SINGLE && line.lineAttr === LINE_SINGLE) {
			const half = this.columns >> 1;
			line.chars.fill(" ", half);
			line.attrs.fill(0, half);
		}
		line.lineAttr = attr;
		this.col = Math.min(this.col, this.lineWidth(line) - 1);
		this.pendingWrap = false;
	}

	// ---- VT52 mode

	private vt52Escape(intermediates: string, final: number): void {
		if (intermediates !== "") return;
		switch (String.fromCharCode(final)) {
			case "A":
				this.moveVertical(-1);
				return;
			case "B":
				this.moveVertical(1);
				return;
			case "C":
				this.col = Math.min(this.lineWidth(this.lines[this.row]!) - 1, this.col + 1);
				this.pendingWrap = false;
				return;
			case "D":
				this.col = Math.max(0, this.col - 1);
				this.pendingWrap = false;
				return;
			case "F":
				this.vt52Graphics = true;
				return;
			case "G":
				this.vt52Graphics = false;
				return;
			case "H":
				this.row = 0;
				this.col = 0;
				this.pendingWrap = false;
				return;
			case "I":
				this.reverseIndex();
				return;
			case "J":
				this.eraseDisplay(0, false);
				return;
			case "K":
				this.eraseLine(0, false);
				return;
			case "Y":
				this.vt52Args = [];
				return;
			case "Z":
				this.respond("\x1b/Z");
				return;
			case "=":
				this.keypadApplication = true;
				return;
			case ">":
				this.keypadApplication = false;
				return;
			case "<":
				this.vt52 = false;
				this.vt52Graphics = false;
				return;
		}
	}

	private vt52Argument(code: number): void {
		const args = this.vt52Args!;
		args.push((code & 0x7f) - 0x20);
		if (args.length < 2) return;
		this.vt52Args = undefined;
		this.row = Math.max(0, Math.min(this.pageLines - 1, args[0]!));
		this.col = Math.max(0, Math.min(this.lineWidth(this.lines[this.row]!) - 1, args[1]!));
		this.pendingWrap = false;
		this.couple();
	}

	// ---- control sequences

	private control(prefix: string, params: number[], intermediates: string, final: string): void {
		const p = (index: number, fallback: number): number => {
			const value = params[index];
			return value === undefined || value === 0 ? fallback : value;
		};
		const key = `${prefix}${intermediates}${final}`;
		switch (key) {
			case "A":
				this.moveVertical(-p(0, 1));
				return;
			case "B":
				this.moveVertical(p(0, 1));
				return;
			case "C":
				this.moveHorizontal(p(0, 1));
				return;
			case "D":
				this.moveHorizontal(-p(0, 1));
				return;
			case "H":
			case "f":
				this.cursorPosition(p(0, 1), p(1, 1));
				return;
			case "J":
				this.eraseDisplay(params[0] ?? 0, false);
				return;
			case "?J":
				if (this.level > 1) this.eraseDisplay(params[0] ?? 0, true);
				return;
			case "K":
				this.eraseLine(params[0] ?? 0, false);
				return;
			case "?K":
				if (this.level > 1) this.eraseLine(params[0] ?? 0, true);
				return;
			case "X":
				this.eraseCharacters(p(0, 1));
				return;
			case "@":
				this.insertCharacters(p(0, 1));
				return;
			case "P":
				this.deleteCharacters(p(0, 1));
				return;
			case "L":
				this.insertLines(p(0, 1));
				return;
			case "M":
				this.deleteLines(p(0, 1));
				return;
			case "'}":
				this.insertColumns(p(0, 1));
				return;
			case "'~":
				this.deleteColumns(p(0, 1));
				return;
			case "S":
				this.pan(p(0, 1));
				return;
			case "T":
				this.pan(-p(0, 1));
				return;
			case "U":
				this.toPage(this.page + p(0, 1), true);
				return;
			case "V":
				this.toPage(this.page - p(0, 1), true);
				return;
			case " P":
				this.toPage(p(0, 1) - 1, false);
				return;
			case " Q":
				this.toPage(this.page + p(0, 1), false);
				return;
			case " R":
				this.toPage(this.page - p(0, 1), false);
				return;
			case "g":
				if ((params[0] ?? 0) === 0) this.tabs[this.col] = false;
				else if (params[0] === 3) this.tabs.fill(false);
				return;
			case "m":
				this.sgr = applyRendition(this.sgr, params.length === 0 ? [0] : params, false);
				return;
			case "r":
				this.setTopBottom(p(0, 1), p(1, this.pageLines));
				return;
			case "s":
				if (this.leftRightMarginMode && !this.statusActive) this.setLeftRight(p(0, 1), p(1, this.columns));
				return;
			case "t":
				this.setPageLength(params[0] ?? 24);
				return;
			case "$|":
				this.setColumns(params[0] === 132 ? 132 : 80, false);
				return;
			case "*|":
				this.setScreenLines(params[0] ?? 24);
				return;
			case "h":
			case "l":
				for (const mode of params) this.ansiMode(mode, final === "h");
				return;
			case "?h":
			case "?l":
				for (const mode of params) this.privateMode(mode, final === "h");
				return;
			// the terminal keeps the mode asked about in a byte: 999 comes back as 255
			case "$p":
				this.respond(`${this.CSI}${Math.min(255, params[0] ?? 0)};${this.ansiModeValue(params[0] ?? 0)}$y`);
				return;
			case "?$p":
				this.respond(`${this.CSI}?${Math.min(255, params[0] ?? 0)};${this.privateModeValue(params[0] ?? 0)}$y`);
				return;
			case "c":
				if ((params[0] ?? 0) === 0) this.identify(true);
				return;
			case ">c":
				if ((params[0] ?? 0) !== 0 || this.level < 2) return;
				// firmware 1.4, as the VT420 this was measured on says
				this.respond(this.options.identity === "vt220" ? "\x1b[>1;10;0c" : `${this.CSI}>41;14;0c`);
				return;
			case "=c":
				if ((params[0] ?? 0) === 0 && this.level > 1) this.respond(`${this.DCS}!|00000000${this.ST}`);
				return;
			case "n":
				this.deviceStatus(params[0] ?? 0);
				return;
			case "?n":
				this.privateDeviceStatus(params);
				return;
			case "i":
				if (params[0] === 5) {
					this.printerController = true;
					this.printerMatch = 0;
				}
				return;
			case '"p':
				this.setConformance(params[0] ?? 0, params[1] ?? 0);
				return;
			case '"q':
				this.protect = params[0] === 1;
				return;
			case '"v':
				this.respond(
					`${this.CSI}${this.visibleLines};${this.columns};1;${this.windowTop + 1};${this.displayPage + 1}"w`,
				);
				return;
			case "!p":
				if (this.level > 1) this.softReset();
				return;
			case "+p":
				this.powerUp();
				if (params.length > 0) this.respond(`${this.CSI}${params[0]}*q`);
				return;
			case "$}":
				this.selectActiveDisplay(params[0] ?? 0);
				return;
			case "$~":
				this.selectStatusLineType(params[0] ?? 0);
				return;
			case "*x":
				this.attributeExtent = params[0] ?? 0;
				return;
			case "+q":
				setPairs(this.localFunctions, DEFAULT_LOCAL_FUNCTIONS, params);
				return;
			case "*}":
				setPairs(this.localFunctionKeys, DEFAULT_LOCAL_FUNCTION_KEYS, params);
				return;
			case "+r":
				setPairs(this.modifierKeys, DEFAULT_MODIFIER_KEYS, params);
				return;
			case "$v":
				this.copyRectangle(params);
				return;
			case "$x":
				this.fillRectangle(params);
				return;
			case "$z":
				this.eraseRectangle(params, false);
				return;
			case "${":
				this.eraseRectangle(params, true);
				return;
			case "$r":
				this.changeAttributes(params, false);
				return;
			case "$t":
				this.changeAttributes(params, true);
				return;
			case "*y":
				this.checksumRectangle(params);
				return;
			case "*z":
				this.invokeMacro(params[0] ?? 0);
				return;
			case "$u":
				if (params[0] === 1) this.respond(`${this.DCS}1$s${encodeState(this.terminalState())}${this.ST}`);
				return;
			case "$w":
				if (params[0] === 1) this.respond(`${this.DCS}1$u${this.cursorInformation()}${this.ST}`);
				else if (params[0] === 2) this.respond(`${this.DCS}2$u${this.tabReport()}${this.ST}`);
				return;
			case "&u":
				this.respond(this.userPreferred === "latin1" ? `${this.DCS}1!uA${this.ST}` : `${this.DCS}0!u%5${this.ST}`);
				return;
		}
	}

	private deviceControl(params: number[], key: string, data: string): void {
		switch (key) {
			case "$q":
				this.reportSetting(data);
				return;
			case "$p":
				if (params[0] === 1) this.restoreState(data);
				return;
			case "$t":
				if (params[0] === 1) this.restoreCursorInformation(data);
				else if (params[0] === 2) this.restoreTabs(data);
				return;
			case "!u":
				if (data === "%5") this.userPreferred = "dec";
				else if (data === "A") this.userPreferred = "latin1";
				return;
			case "|":
				this.defineKeys(params, data);
				return;
			case "!z":
				this.defineMacro(params, data);
				return;
			case "{": {
				if (this.level < 2) return;
				const font = loadSoftFont(params, data, this.softFonts);
				if (!font) return;
				// a set of another name replaces the soft set; the same set for another screen size stays beside it
				const eraseAll = params[2] === 2;
				this.softFonts = this.softFonts.filter(
					(other) =>
						other !== font &&
						other.name === font.name &&
						!eraseAll &&
						(other.columns !== font.columns || other.lines !== font.lines),
				);
				this.softFonts.push(font);
				return;
			}
		}
	}

	// ---- writing

	private blankLine(): EmuLine {
		return { chars: new Array(this.columns).fill(" "), attrs: new Array(this.columns).fill(0), lineAttr: 0 };
	}

	private lineWidth(line: EmuLine): number {
		return line.lineAttr === LINE_SINGLE ? this.columns : this.columns >> 1;
	}

	/** Whether the cursor is between the left and right margins. */
	private inLeftRight(): boolean {
		return this.col >= this.left && this.col <= this.right;
	}

	/** A character, kept with the code it has in the terminal (see storedCode). */
	private put(char: string, code: number): void {
		if (this.statusActive) {
			// the status line does not wrap: its last column takes whatever comes
			const line = this.status;
			if (this.insertMode) {
				line.chars.copyWithin(this.statusCol + 1, this.statusCol, this.columns - 1);
				line.attrs.copyWithin(this.statusCol + 1, this.statusCol, this.columns - 1);
			}
			line.chars[this.statusCol] = char;
			line.attrs[this.statusCol] = this.cellAttrs(code);
			if (this.statusCol < this.columns - 1) this.statusCol++;
			return;
		}
		if (this.pendingWrap && this.autowrap) {
			this.col = this.leftRightMarginMode && this.col <= this.right ? this.left : 0;
			this.index();
		}
		this.pendingWrap = false;
		const line = this.lines[this.row]!;
		const limit = this.leftRightMarginMode && this.col <= this.right ? this.right : this.lineWidth(line) - 1;
		if (this.col > limit) this.col = limit;
		if (this.insertMode && this.col < limit) {
			line.chars.copyWithin(this.col + 1, this.col, limit);
			line.attrs.copyWithin(this.col + 1, this.col, limit);
		}
		line.chars[this.col] = char;
		line.attrs[this.col] = this.cellAttrs(code);
		if (this.col < limit) this.col++;
		else if (this.autowrap) this.pendingWrap = true;
	}

	private cellAttrs(code: number): number {
		return this.sgr | (this.protect ? ATTR_PROTECTED : 0) | (code << CODE_SHIFT);
	}

	private backspace(): void {
		if (this.statusActive) {
			this.statusCol = Math.max(0, this.statusCol - 1);
		} else if (this.col !== this.left || !this.leftRightMarginMode) {
			this.col = Math.max(0, this.col - 1);
		}
		this.pendingWrap = false;
	}

	private tab(): void {
		const width = this.statusActive ? this.columns : this.lineWidth(this.lines[this.row]!);
		const from = this.statusActive ? this.statusCol : this.col;
		const limit = !this.statusActive && this.leftRightMarginMode && from <= this.right ? this.right : width - 1;
		let next = from + 1;
		while (next < limit && !this.tabs[next]) next++;
		next = Math.min(next, limit);
		if (this.statusActive) this.statusCol = next;
		else this.col = next;
	}

	private setTab(): void {
		if (!this.statusActive) this.tabs[this.col] = true;
	}

	private resetTabs(): void {
		this.tabs = Array.from({ length: this.columns }, (_, col) => col > 0 && col % 8 === 0);
	}

	private carriageReturn(): void {
		if (this.statusActive) this.statusCol = 0;
		else this.col = this.leftRightMarginMode && this.col >= this.left ? this.left : 0;
		this.pendingWrap = false;
	}

	private lineFeed(): void {
		this.index();
		if (this.newLine) this.carriageReturn();
	}

	index(): void {
		if (this.statusActive) return;
		this.pendingWrap = false;
		if (this.row === this.bottom) {
			if (this.inLeftRight()) this.scrollRegion(1, 1, true);
		} else if (this.row < this.pageLines - 1) this.row++;
	}

	reverseIndex(): void {
		if (this.statusActive) return;
		this.pendingWrap = false;
		if (this.row === this.top) {
			if (this.inLeftRight()) this.scrollRegion(-1, 1, true);
		} else if (this.row > 0) this.row--;
	}

	/** DECBI: left a column, or the margins' contents right when at the left margin. */
	private backIndex(): void {
		if (this.statusActive) return;
		this.pendingWrap = false;
		if (this.col === this.left && this.row >= this.top && this.row <= this.bottom) {
			this.shiftColumns(this.left, -1);
		} else if (this.col > 0) this.col--;
	}

	private forwardIndex(): void {
		if (this.statusActive) return;
		this.pendingWrap = false;
		if (this.col === this.right && this.row >= this.top && this.row <= this.bottom) {
			this.shiftColumns(this.left, 1);
		} else if (this.col < this.columns - 1) this.col++;
	}

	/**
	 * Scroll the scrolling region `count` lines up (1) or down (-1): the lines between the margins, and only the
	 * columns between the left and right ones. A single line that the terminal would glide is offered to the display.
	 */
	private scrollRegion(direction: 1 | -1, count: number, glide: boolean): void {
		const lines = this.lines;
		const full = this.left === 0 && this.right === this.columns - 1;
		const height = this.bottom - this.top + 1;
		count = Math.min(count, height);
		if (
			glide &&
			count === 1 &&
			full &&
			this.smoothScroll &&
			this.glide &&
			this.page === this.displayPage &&
			!this.smoothScrollEvent
		) {
			const lost = direction === 1 ? lines[this.top]! : lines[this.bottom]!;
			this.smoothScrollEvent = { top: this.top, bottom: this.bottom, direction, lost: copyLine(lost) };
		} else this.busyMs += TIMING.jumpScrollMs * count;
		for (let i = 0; i < count; i++) {
			if (full) {
				if (direction === 1) {
					lines.splice(this.top, 1);
					lines.splice(this.bottom, 0, this.blankLine());
				} else {
					lines.splice(this.bottom, 1);
					lines.splice(this.top, 0, this.blankLine());
				}
				continue;
			}
			const [from, to] = direction === 1 ? [this.top, this.bottom] : [this.bottom, this.top];
			for (let row = from; row !== to; row += direction) {
				copyCells(lines[row + direction]!, lines[row]!, this.left, this.right + 1);
			}
			clearCells(lines[to]!, this.left, this.right + 1);
		}
	}

	/** Move the columns between the margins, in the scrolling region, `by` columns (-1 right, 1 left). */
	private shiftColumns(at: number, by: 1 | -1): void {
		for (let row = this.top; row <= this.bottom; row++) {
			const line = this.lines[row]!;
			if (by === 1) {
				line.chars.copyWithin(at, at + 1, this.right + 1);
				line.attrs.copyWithin(at, at + 1, this.right + 1);
				line.chars[this.right] = " ";
				line.attrs[this.right] = 0;
			} else {
				line.chars.copyWithin(at + 1, at, this.right);
				line.attrs.copyWithin(at + 1, at, this.right);
				line.chars[at] = " ";
				line.attrs[at] = 0;
			}
		}
	}

	// ---- cursor

	private moveVertical(delta: number): void {
		if (this.statusActive) return;
		// up stops at the top margin, down at the bottom one, unless the cursor was already past it
		const min = delta < 0 && this.row >= this.top ? this.top : 0;
		const max = delta > 0 && this.row <= this.bottom ? this.bottom : this.pageLines - 1;
		this.row = Math.max(min, Math.min(max, this.row + delta));
		this.col = Math.min(this.col, this.lineWidth(this.lines[this.row]!) - 1);
		this.pendingWrap = false;
	}

	private moveHorizontal(delta: number): void {
		if (this.statusActive) {
			this.statusCol = Math.max(0, Math.min(this.columns - 1, this.statusCol + delta));
			this.pendingWrap = false;
			return;
		}
		const width = this.lineWidth(this.lines[this.row]!);
		const inside = this.leftRightMarginMode && this.inLeftRight();
		const min = inside ? this.left : 0;
		const max = inside ? this.right : width - 1;
		this.col = Math.max(min, Math.min(max, this.col + delta));
		this.pendingWrap = false;
	}

	private cursorPosition(row: number, col: number): void {
		this.pendingWrap = false;
		if (this.statusActive) {
			this.statusCol = Math.min(this.columns - 1, col - 1);
			return;
		}
		if (this.originMode) {
			this.row = Math.min(this.bottom, this.top + row - 1);
			this.col = Math.min(this.leftRightMarginMode ? this.right : this.columns - 1, this.left + col - 1);
		} else {
			this.row = Math.min(this.pageLines - 1, row - 1);
			this.col = col - 1;
		}
		this.col = Math.min(this.col, this.lineWidth(this.lines[this.row]!) - 1);
	}

	private home(): void {
		this.row = this.originMode ? this.top : 0;
		this.col = this.originMode ? this.left : 0;
		this.pendingWrap = false;
	}

	/** Where the cursor was when the display last followed it. */
	private coupledRow = 0;
	private coupledPage = 0;

	/** When the cursor has moved, take the display with it where the coupling modes say so; a pan stays put. */
	private couple(): void {
		if (this.statusActive || (this.row === this.coupledRow && this.page === this.coupledPage)) return;
		this.coupledRow = this.row;
		this.coupledPage = this.page;
		if (this.pageCoupling) this.displayPage = this.page;
		if (!this.verticalCoupling || this.page !== this.displayPage) return;
		const visible = this.visibleLines;
		if (this.row < this.windowTop) this.windowTop = this.row;
		else if (this.row >= this.windowTop + visible) this.windowTop = this.row - visible + 1;
	}

	private pan(lines: number): void {
		const max = Math.max(0, this.pageLines - this.visibleLines);
		this.windowTop = Math.max(0, Math.min(max, this.windowTop + lines));
	}

	private toPage(page: number, home: boolean): void {
		if (this.pages.length < 2 || this.statusActive) return;
		this.page = Math.max(0, Math.min(this.pages.length - 1, page));
		this.pendingWrap = false;
		if (home) this.home();
	}

	private saveCursor(): void {
		const state: SavedCursor = {
			row: this.row,
			col: this.statusActive ? this.statusCol : this.col,
			page: this.page,
			sgr: this.sgr,
			protect: this.protect,
			designations: [...this.designations],
			gl: this.gl,
			gr: this.gr,
			singleShift: this.singleShift,
			pendingWrap: this.pendingWrap,
			originMode: this.originMode,
		};
		if (this.statusActive) this.statusSaved = state;
		else this.saved = state;
	}

	private restoreCursor(): void {
		const state = this.statusActive ? this.statusSaved : this.saved;
		if (!state) {
			// nothing saved: home, origin mode off, normal rendition, ASCII in GL and the supplemental set in GR
			this.originMode = false;
			this.sgr = 0;
			this.protect = false;
			this.designations = this.defaultDesignations();
			this.gl = 0;
			this.gr = 2;
			this.singleShift = 0;
			if (this.statusActive) this.statusCol = 0;
			else this.home();
			return;
		}
		this.sgr = state.sgr;
		this.protect = state.protect;
		this.designations = [...state.designations];
		this.gl = state.gl;
		this.gr = state.gr;
		this.singleShift = state.singleShift;
		this.originMode = state.originMode;
		if (this.statusActive) {
			this.statusCol = Math.min(this.columns - 1, state.col);
			return;
		}
		this.row = Math.min(this.pageLines - 1, state.row);
		this.col = Math.min(this.lineWidth(this.lines[this.row]!) - 1, state.col);
		this.pendingWrap = state.pendingWrap && this.autowrap;
	}

	// ---- editing

	/** The current line and the cursor's column on it. */
	private cursorLine(): [EmuLine, number] {
		return this.statusActive ? [this.status, this.statusCol] : [this.lines[this.row]!, this.col];
	}

	private eraseDisplay(mode: number, selective: boolean): void {
		if (this.statusActive) {
			this.eraseCells(this.status, 0, this.columns, selective);
			return;
		}
		const lines = this.lines;
		const whole = (row: number): void => {
			if (selective) this.eraseCells(lines[row]!, 0, this.columns, true);
			else {
				lines[row] = this.blankLine();
				this.busyMs += this.columns * TIMING.eraseCellMs;
			}
		};
		if (mode === 0) {
			this.eraseCells(lines[this.row]!, this.col, this.columns, selective);
			if (this.col === 0 && !selective) lines[this.row]!.lineAttr = LINE_SINGLE;
			for (let row = this.row + 1; row < this.pageLines; row++) whole(row);
		} else if (mode === 1) {
			this.eraseCells(lines[this.row]!, 0, this.col + 1, selective);
			for (let row = 0; row < this.row; row++) whole(row);
		} else if (mode === 2) {
			for (let row = 0; row < this.pageLines; row++) whole(row);
		}
		this.pendingWrap = false;
	}

	private eraseLine(mode: number, selective: boolean): void {
		const [line, col] = this.cursorLine();
		if (mode === 0) this.eraseCells(line, col, this.columns, selective);
		else if (mode === 1) this.eraseCells(line, 0, col + 1, selective);
		else if (mode === 2) this.eraseCells(line, 0, this.columns, selective);
		this.pendingWrap = false;
	}

	/** Erase cells to blanks without attributes, or with `selective` only the unprotected ones, keeping attributes. */
	private eraseCells(line: EmuLine, from: number, to: number, selective: boolean): void {
		to = Math.min(to, this.columns);
		this.busyMs += Math.max(0, to - from) * TIMING.eraseCellMs;
		for (let col = Math.max(0, from); col < to; col++) {
			if (!selective) {
				line.chars[col] = " ";
				line.attrs[col] = 0;
			} else if (!(line.attrs[col]! & ATTR_PROTECTED)) {
				// erased, the rendition left as it was
				line.chars[col] = " ";
				line.attrs[col] = line.attrs[col]! & VISUAL;
			}
		}
	}

	private eraseCharacters(count: number): void {
		const [line, col] = this.cursorLine();
		this.eraseCells(line, col, Math.min(this.lineWidth(line), col + count), false);
		this.pendingWrap = false;
	}

	private insertCharacters(count: number): void {
		const [line, col] = this.cursorLine();
		const right = this.statusActive || !this.leftRightMarginMode ? this.lineWidth(line) - 1 : this.right;
		if (!this.statusActive && this.leftRightMarginMode && !this.inLeftRight()) return;
		count = Math.min(count, right - col + 1);
		line.chars.copyWithin(col + count, col, right + 1 - count);
		line.attrs.copyWithin(col + count, col, right + 1 - count);
		clearCells(line, col, col + count);
		this.pendingWrap = false;
	}

	private deleteCharacters(count: number): void {
		const [line, col] = this.cursorLine();
		const right = this.statusActive || !this.leftRightMarginMode ? this.lineWidth(line) - 1 : this.right;
		if (!this.statusActive && this.leftRightMarginMode && !this.inLeftRight()) return;
		count = Math.min(count, right - col + 1);
		line.chars.copyWithin(col, col + count, right + 1);
		line.attrs.copyWithin(col, col + count, right + 1);
		clearCells(line, right + 1 - count, right + 1);
		this.pendingWrap = false;
	}

	private insertLines(count: number): void {
		if (this.statusActive || this.row < this.top || this.row > this.bottom || !this.inLeftRight()) return;
		const top = this.top;
		this.top = this.row;
		this.scrollRegion(-1, count, false);
		this.top = top;
		this.col = this.left;
		this.pendingWrap = false;
	}

	private deleteLines(count: number): void {
		if (this.statusActive || this.row < this.top || this.row > this.bottom || !this.inLeftRight()) return;
		const top = this.top;
		this.top = this.row;
		this.scrollRegion(1, count, false);
		this.top = top;
		this.col = this.left;
		this.pendingWrap = false;
	}

	private insertColumns(count: number): void {
		if (this.statusActive || !this.inLeftRight() || this.row < this.top || this.row > this.bottom) return;
		for (let i = 0; i < Math.min(count, this.right - this.col + 1); i++) this.shiftColumns(this.col, -1);
	}

	private deleteColumns(count: number): void {
		if (this.statusActive || !this.inLeftRight() || this.row < this.top || this.row > this.bottom) return;
		for (let i = 0; i < Math.min(count, this.right - this.col + 1); i++) this.shiftColumns(this.col, 1);
	}

	// ---- margins, pages and the screen's size

	private setTopBottom(top: number, bottom: number): void {
		if (this.statusActive) return;
		bottom = Math.min(bottom, this.pageLines);
		if (top >= bottom) return;
		this.top = top - 1;
		this.bottom = bottom - 1;
		this.home();
	}

	private setLeftRight(left: number, right: number): void {
		right = Math.min(right, this.columns);
		if (left >= right) return;
		this.left = left - 1;
		this.right = right - 1;
		this.home();
	}

	private allocatePages(): void {
		const count = PAGE_ARRANGEMENTS[this.pageLines] ?? 1;
		this.pages = Array.from({ length: count }, () => Array.from({ length: this.pageLines }, () => this.blankLine()));
	}

	/** DECSLPP: lines per page, and as many pages as page memory holds; what was there is kept where it fits. */
	private setPageLength(lines: number): void {
		if (PAGE_ARRANGEMENTS[lines] === undefined || lines === this.pageLines) return;
		const old = this.pages;
		this.pageLines = lines;
		this.allocatePages();
		for (let page = 0; page < Math.min(old.length, this.pages.length); page++) {
			for (let row = 0; row < Math.min(lines, old[page]!.length); row++) this.pages[page]![row] = old[page]![row]!;
		}
		this.page = Math.min(this.page, this.pages.length - 1);
		this.displayPage = Math.min(this.displayPage, this.pages.length - 1);
		this.row = Math.min(this.row, lines - 1);
		if (this.bottom >= lines || this.top >= lines) {
			this.top = 0;
			this.bottom = lines - 1;
		} else if (this.bottom === old[0]!.length - 1) this.bottom = lines - 1;
		this.windowTop = Math.min(this.windowTop, Math.max(0, lines - this.visibleLines));
		this.couple();
		this.options.onResize?.(this.columns, this.visibleLines);
	}

	/**
	 * DECSNLS: lines on the screen, the supported number at or above the one asked for. The pages stay as long as
	 * they were, so a screen taller than a page shows blank lines under it.
	 */
	private setScreenLines(lines: number): void {
		const screen = lines <= 24 ? 24 : lines <= 36 ? 36 : 48;
		if (screen === this.screenLines) return;
		this.screenLines = screen;
		this.windowTop = Math.min(this.windowTop, Math.max(0, this.pageLines - this.visibleLines));
		this.couple();
		this.options.onResize?.(this.columns, this.visibleLines);
	}

	/** DECSCPP keeps page memory, cut to the new width; DECCOLM erases it and resets the margins. */
	private setColumns(columns: 80 | 132, erase: boolean): void {
		if (columns === this.columns && !erase) return;
		const old = this.columns;
		this.columns = columns;
		const resize = (line: EmuLine): void => {
			if (columns < old) {
				line.chars.length = columns;
				line.attrs.length = columns;
			} else {
				for (let col = old; col < columns; col++) {
					line.chars.push(" ");
					line.attrs.push(0);
				}
			}
		};
		if (erase) {
			this.allocatePages();
			this.status = this.statusType === 2 ? this.blankLine() : this.status;
			this.top = 0;
			this.bottom = this.pageLines - 1;
			this.leftRightMarginMode = false;
			this.row = 0;
			this.col = 0;
		} else {
			for (const page of this.pages) for (const line of page) resize(line);
			this.col = Math.min(this.col, columns - 1);
		}
		resize(this.status);
		this.left = 0;
		this.right = columns - 1;
		this.statusCol = Math.min(this.statusCol, columns - 1);
		const tabs = this.tabs;
		this.resetTabs();
		for (let col = 0; col < Math.min(old, columns); col++) this.tabs[col] = tabs[col] ?? false;
		this.pendingWrap = false;
		this.options.onResize?.(this.columns, this.visibleLines);
	}

	// ---- modes

	private ansiMode(mode: number, set: boolean): void {
		switch (mode) {
			case 2:
				this.keyboardLocked = set;
				return;
			case 4:
				this.insertMode = set;
				return;
			case 12:
				this.localEcho = !set;
				return;
			case 20:
				this.newLine = set;
				return;
		}
	}

	private privateMode(mode: number, set: boolean): void {
		if (this.options.unknownModes?.includes(mode)) return;
		switch (mode) {
			case 1:
				this.cursorKeysApplication = set;
				return;
			case 2:
				if (!set) {
					this.vt52 = true;
					this.vt52Graphics = false;
				}
				return;
			case 3:
				this.setColumns(set ? 132 : 80, true);
				return;
			case 4:
				this.smoothScroll = set;
				return;
			case 5:
				this.screenReverse = set;
				return;
			case 6:
				this.originMode = set;
				this.home();
				return;
			case 7:
				this.autowrap = set;
				if (!set) this.pendingWrap = false;
				return;
			case 8:
				this.autorepeat = set;
				return;
			case 18:
				this.printFormFeed = set;
				return;
			case 19:
				this.printExtent = set;
				return;
			case 25:
				this.cursorVisible = set;
				return;
			case 42:
				if (this.level < 2 || set === this.national || !this.setup.worldwide) return;
				this.national = set;
				this.designations = this.defaultDesignations();
				this.gl = 0;
				this.gr = 2;
				return;
			case 60:
				this.horizontalCoupling = set;
				return;
			case 61:
				this.verticalCoupling = set;
				return;
			case 64:
				this.pageCoupling = set;
				return;
			case 66:
				this.keypadApplication = set;
				return;
			case 67:
				this.backarrowBS = set;
				return;
			case 68:
				this.dataProcessingKeys = set;
				return;
			case 69:
				this.leftRightMarginMode = set;
				if (set) {
					for (const page of this.pages) for (const line of page) this.singleWidth(line);
				} else {
					this.left = 0;
					this.right = this.columns - 1;
				}
				return;
			case 73:
				this.transmitLimited = set;
				return;
			case 81:
				this.keyPositionMode = set;
				return;
		}
	}

	private singleWidth(line: EmuLine): void {
		line.lineAttr = LINE_SINGLE;
	}

	private ansiModeValue(mode: number): number {
		if (mode === 3) return 4;
		const values: Record<number, boolean> = {
			2: this.keyboardLocked,
			4: this.insertMode,
			12: !this.localEcho,
			20: this.newLine,
		};
		if (mode in values) return values[mode] ? 1 : 2;
		return PERMANENTLY_RESET.has(mode) ? 4 : 0;
	}

	private privateModeValue(mode: number): number {
		const values: Record<number, boolean> = {
			1: this.cursorKeysApplication,
			2: !this.vt52,
			3: this.columns === 132,
			4: this.smoothScroll,
			5: this.screenReverse,
			6: this.originMode,
			7: this.autowrap,
			8: this.autorepeat,
			18: this.printFormFeed,
			19: this.printExtent,
			25: this.cursorVisible,
			42: this.national,
			61: this.verticalCoupling,
			64: this.pageCoupling,
			66: this.keypadApplication,
			67: this.backarrowBS,
			68: this.dataProcessingKeys,
			69: this.leftRightMarginMode,
			73: this.transmitLimited,
			81: this.keyPositionMode,
		};
		if (this.options.unknownModes?.includes(mode)) return 0;
		if (mode === 60 || (mode === 42 && !this.setup.worldwide)) return 4;
		return mode in values ? (values[mode] ? 1 : 2) : 0;
	}

	/** DECSCL: a change of level resets the terminal, as Set-Up would. */
	private setConformance(level: number, controls: number): void {
		const vt100 = level === 61;
		if (!vt100 && !(level >= 62 && level <= 64)) return;
		const newLevel = vt100 ? 1 : 4;
		if (newLevel !== this.level) {
			const setup = this.setup;
			this.setup = { ...setup, level: newLevel };
			this.powerUp();
			this.setup = setup;
		}
		this.eightBitControls = !vt100 && controls !== 1;
	}

	// ---- the status line

	private selectStatusLineType(type: number): void {
		if (type > 2 || this.level < 2) return;
		const lines = this.visibleLines;
		if (type === 2 && this.statusType !== 2) this.status = this.blankLine();
		if (type !== 2 && this.statusActive) this.leaveStatusLine();
		this.statusType = type;
		if (this.visibleLines !== lines) this.options.onResize?.(this.columns, this.visibleLines);
	}

	private selectActiveDisplay(display: number): void {
		const active = display === 1 && this.statusType === 2;
		if (active && !this.statusActive) this.enterStatusLine();
		else if (!active && this.statusActive) this.leaveStatusLine();
	}

	private enterStatusLine(): void {
		this.mainState = this.cursorState();
		const mode = this.options.statusState ?? "separate";
		if (mode !== "inherit") {
			({ sgr: this.sgr, protect: this.protect, gl: this.gl, gr: this.gr } = this.statusState);
		}
		if (mode === "isolated") this.designations = [...this.statusState.designations];
		this.singleShift = 0;
		this.pendingWrap = false;
		this.statusActive = true;
	}

	private leaveStatusLine(): void {
		this.statusState = {
			sgr: this.sgr,
			protect: this.protect,
			gl: this.gl,
			gr: this.gr,
			designations: [...this.designations],
		};
		const main = this.mainState;
		this.statusActive = false;
		if (main) {
			this.row = Math.min(this.pageLines - 1, main.row);
			this.col = Math.min(this.columns - 1, main.col);
			this.sgr = main.sgr;
			this.protect = main.protect;
			this.gl = main.gl;
			this.gr = main.gr;
			this.designations = [...main.designations];
			this.pendingWrap = main.pendingWrap;
		}
		this.singleShift = 0;
	}

	private cursorState(): SavedCursor {
		return {
			row: this.row,
			col: this.col,
			page: this.page,
			sgr: this.sgr,
			protect: this.protect,
			designations: [...this.designations],
			gl: this.gl,
			gr: this.gr,
			singleShift: this.singleShift,
			pendingWrap: this.pendingWrap,
			originMode: this.originMode,
		};
	}

	// ---- rectangles

	/** A rectangle's corners from parameters, origin mode and the page applied; undefined when empty. */
	private rectangle(params: number[], at: number, stream = false): [number, number, number, number] | undefined {
		const value = (index: number, fallback: number): number => {
			const v = params[at + index];
			return v === undefined || v === 0 ? fallback : v;
		};
		const rowOffset = this.originMode ? this.top : 0;
		const colOffset = this.originMode ? this.left : 0;
		const top = Math.min(this.pageLines, value(0, 1) + rowOffset) - 1;
		const left = Math.min(this.columns, value(1, 1) + colOffset) - 1;
		const bottom = Math.min(this.pageLines, value(2, this.pageLines - rowOffset) + rowOffset) - 1;
		const right = Math.min(this.columns, value(3, this.columns - colOffset) + colOffset) - 1;
		// a stream of positions may end left of where it starts, on a later line
		if (top > bottom || (left > right && !(stream && top < bottom))) return undefined;
		return [top, left, bottom, right];
	}

	private copyRectangle(params: number[]): void {
		if (this.level < 2) return;
		const area = this.rectangle(params, 0);
		if (!area) return;
		const [top, left, bottom, right] = area;
		const pageOf = (value: number | undefined): number =>
			Math.max(0, Math.min(this.pages.length - 1, (value || 1) - 1));
		const source = this.pages[pageOf(params[4])]!;
		const target = this.pages[pageOf(params[7])]!;
		const rowOffset = this.originMode ? this.top : 0;
		const colOffset = this.originMode ? this.left : 0;
		const toTop = Math.min(this.pageLines, (params[5] || 1) + rowOffset) - 1;
		const toLeft = Math.min(this.columns, (params[6] || 1) + colOffset) - 1;
		const rows: Array<{ chars: string[]; attrs: number[] }> = [];
		for (let row = top; row <= bottom; row++) {
			rows.push({
				chars: source[row]!.chars.slice(left, right + 1),
				attrs: source[row]!.attrs.slice(left, right + 1),
			});
		}
		rows.forEach((copy, index) => {
			const line = target[toTop + index];
			if (!line) return;
			for (let col = 0; col < copy.chars.length && toLeft + col < this.columns; col++) {
				line.chars[toLeft + col] = copy.chars[col]!;
				line.attrs[toLeft + col] = copy.attrs[col]!;
			}
		});
	}

	private fillRectangle(params: number[]): void {
		if (this.level < 2) return;
		const code = params[0] ?? 0;
		if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) return;
		const area = this.rectangle(params, 1);
		if (!area) return;
		const id = this.designations[code >= 0x80 ? this.gr : this.gl]!;
		const seven = code & 0x7f;
		const glyph =
			code === 0x20
				? " "
				: seven === 0x20 && !is96(id, false, this.userPreferred)
					? undefined
					: glyphIn(id, seven, this.userPreferred);
		const char = glyph ?? ERROR_CHAR;
		const attrs = this.cellAttrs(glyph === undefined ? ERROR_CODE : storedCode(id, seven, this.userPreferred));
		const [top, left, bottom, right] = area;
		this.busyMs += (bottom - top + 1) * (right - left + 1) * TIMING.fillCellMs;
		for (let row = top; row <= bottom; row++) {
			const line = this.lines[row]!;
			line.chars.fill(char, left, right + 1);
			line.attrs.fill(attrs, left, right + 1);
		}
	}

	private eraseRectangle(params: number[], selective: boolean): void {
		if (this.level < 2) return;
		const area = this.rectangle(params, 0);
		if (!area) return;
		const [top, left, bottom, right] = area;
		for (let row = top; row <= bottom; row++) this.eraseCells(this.lines[row]!, left, right + 1, selective);
	}

	/** DECCARA, or DECRARA with `reverse`, on a rectangle or the stream of positions between its corners. */
	private changeAttributes(params: number[], reverse: boolean): void {
		if (this.level < 2) return;
		const area = this.rectangle(params, 0, this.attributeExtent !== 2);
		if (!area) return;
		// bold, underline, blink and negative image only: invisible is not among them
		const values = (params.length > 4 ? params.slice(4) : [0]).filter((value) => value !== 8 && value !== 28);
		const [top, left, bottom, right] = area;
		this.busyMs += (bottom - top + 1) * (right - left + 1) * TIMING.fillCellMs;
		const rectangle = this.attributeExtent === 2;
		for (let row = top; row <= bottom; row++) {
			const line = this.lines[row]!;
			const from = rectangle || row === top ? left : 0;
			const to = rectangle || row === bottom ? right : this.columns - 1;
			for (let col = from; col <= to; col++) {
				const attrs = line.attrs[col]!;
				line.attrs[col] = (attrs & ~VISUAL) | applyRendition(attrs & VISUAL, values, reverse);
			}
		}
	}

	private checksumRectangle(params: number[]): void {
		if (this.level < 2) return;
		const id = params[0] ?? 0;
		const page = params[1] ?? 0;
		let sum = 0;
		// as a VT420 sums them: the stored code (0 for an erased cell) and a weight for each attribute but invisible
		const add = (line: EmuLine, from: number, to: number): void => {
			for (let col = from; col <= to; col++) {
				const attrs = line.attrs[col]!;
				sum += attrs >> CODE_SHIFT;
				if (attrs & ATTR_UNDERLINE) sum += 0x400;
				if (attrs & ATTR_PROTECTED) sum += 0x800;
				if (attrs & ATTR_BOLD) sum += 0x2000;
				if (attrs & ATTR_REVERSE) sum += 0x4000;
				if (attrs & ATTR_BLINK) sum += 0x8000;
			}
		};
		if (page === 0) {
			for (const lines of this.pages) for (const line of lines) add(line, 0, this.columns - 1);
		} else {
			const lines = this.pages[Math.min(this.pages.length, page) - 1]!;
			const area = this.rectangle(params, 2);
			if (area) {
				const [top, left, bottom, right] = area;
				for (let row = top; row <= bottom; row++) add(lines[row]!, left, right);
			}
		}
		this.respond(`${this.DCS}${id}!~${hex4(-sum & 0xffff)}${this.ST}`);
	}

	// ---- reports

	private get CSI(): string {
		return this.eightBitControls ? "\x9b" : "\x1b[";
	}

	private get DCS(): string {
		return this.eightBitControls ? "\x90" : "\x1bP";
	}

	private get ST(): string {
		return this.eightBitControls ? "\x9c" : "\x1b\\";
	}

	private respond(bytes: string): void {
		if (bytes === "") return;
		// a VT220 answers DA and the cursor position, and knows none of the VT400's requests
		if (this.options.identity === "vt220" && !/^(\x1b\[|\x9b)(\?62;|>1;|\d+;\d+R)/.test(bytes)) return;
		this.options.onResponse?.(bytes);
	}

	/** DA1, or DECID (in VT100 mode only). */
	private identify(request = false): void {
		if (this.vt52) {
			this.respond("\x1b/Z");
			return;
		}
		if (!request && this.level > 1) return;
		if (this.options.identity === "vt220") {
			this.respond("\x1b[?62;1;2;6;7;8;9c");
			return;
		}
		if (this.level === 1) {
			this.respond("\x1b[?1;2c");
			return;
		}
		const answers: Record<Vt420Setup["alias"], string> = {
			// 9, the national replacement sets, on the worldwide model only
			vt420: this.setup.worldwide ? "?64;1;2;6;7;8;9;15;18;19;21c" : "?64;1;2;6;7;8;15;18;19;21c",
			vt320: "?63;1;2;6;7;8;9c",
			vt220: "?62;1;2;6;7;8;9c",
			vt100: "?1;2c",
		};
		this.respond(`${this.CSI}${answers[this.setup.alias]}`);
	}

	private deviceStatus(request: number): void {
		if (request === 5) this.respond(`${this.CSI}0n`);
		else if (request === 6) {
			const [row, col] = this.reportedPosition();
			this.respond(`${this.CSI}${row};${col}R`);
		}
	}

	private reportedPosition(): [number, number] {
		if (this.statusActive) return [(this.mainState?.row ?? 0) + 1, this.statusCol + 1];
		const row = this.row - (this.originMode ? this.top : 0) + 1;
		const col = this.col - (this.originMode ? this.left : 0) + 1;
		return [row, col];
	}

	private privateDeviceStatus(params: number[]): void {
		switch (params[0]) {
			case 6: {
				const [row, col] = this.reportedPosition();
				this.respond(`${this.CSI}?${row};${col};${this.page + 1}R`);
				return;
			}
			case 15:
				this.respond(`${this.CSI}?13n`);
				return;
			case 25:
				if (this.level > 1) this.respond(`${this.CSI}?${this.udkLocked ? 21 : 20}n`);
				return;
			case 26:
				this.respond(`${this.CSI}?27;1${this.level > 1 ? ";0;1" : ""}n`);
				return;
			case 62:
				this.respond(`${this.CSI}${Math.floor((MACRO_SPACE - this.macroBytes()) / 16)}*{`);
				return;
			case 63: {
				let sum = 0;
				for (const macro of this.macros.values()) for (const char of macro) sum += char.charCodeAt(0);
				this.respond(`${this.DCS}${params[1] ?? 0}!~${hex4(-sum & 0xffff)}${this.ST}`);
				return;
			}
			case 75:
				// not reported since power-up, an error on the line since the last report, or all well
				this.respond(`${this.CSI}?${this.integrity === "unreported" ? 73 : this.integrity === "error" ? 71 : 70}n`);
				this.integrity = "ok";
				return;
			case 85:
				this.respond(`${this.CSI}?83n`);
				return;
		}
	}

	/** DECRQSS. A VT420 answers 1 for a request it knows and 0 for one it does not, the other way round from the
	 * programmer reference. */
	private reportSetting(request: string): void {
		const ok = (value: string): void => this.respond(`${this.DCS}1$r${value}${this.ST}`);
		switch (request) {
			case "m":
				ok(`${renditionParams(this.sgr)}m`);
				return;
			case "r":
				ok(`${this.top + 1};${this.bottom + 1}r`);
				return;
			case "s":
				ok(`${this.left + 1};${this.right + 1}s`);
				return;
			case "t":
				ok(`${this.pageLines}t`);
				return;
			case "$|":
				ok(`${this.columns}$|`);
				return;
			case "*|":
				ok(`${this.screenLines}*|`);
				return;
			case '"p':
				ok(this.level === 1 ? '61"p' : `64;${this.eightBitControls ? 0 : 1}"p`);
				return;
			case '"q':
				ok(`${this.protect ? 1 : 0}"q`);
				return;
			case "$}":
				ok(`${this.statusActive ? 1 : 0}$}`);
				return;
			case "$~":
				ok(`${this.statusType}$~`);
				return;
			case "*x":
				ok(`${this.attributeExtent}*x`);
				return;
			case "+q":
				ok(`${pairs(this.localFunctions)}+q`);
				return;
			case "*}":
				ok(`${pairs(this.localFunctionKeys)}*}`);
				return;
			case "+r":
				ok(`${pairs(this.modifierKeys)}+r`);
				return;
		}
		this.respond(`${this.DCS}0$r${this.ST}`);
	}

	/** DECCIR's data: the cursor, its rendition and flags, and the character sets (Chapter 12). */
	private cursorInformation(): string {
		const sgr = this.sgr;
		const rend =
			0x40 |
			(sgr & ATTR_REVERSE ? 8 : 0) |
			(sgr & ATTR_BLINK ? 4 : 0) |
			(sgr & ATTR_UNDERLINE ? 2 : 0) |
			(sgr & ATTR_BOLD ? 1 : 0);
		const att = 0x40 | (this.protect ? 1 : 0);
		const flag =
			0x40 |
			(this.pendingWrap ? 8 : 0) |
			(this.singleShift === 3 ? 4 : 0) |
			(this.singleShift === 2 ? 2 : 0) |
			(this.originMode ? 1 : 0);
		const font96 = this.softFontFor("drcs")?.size96 ?? false;
		const size = this.designations.reduce(
			(bits, id, slot) => bits | (is96(id, font96, this.userPreferred) ? 1 << slot : 0),
			0x40,
		);
		const names = this.designations.map((id) => finalFor(id, this.drcsName)).join("");
		return [
			this.row + 1,
			this.col + 1,
			this.page + 1,
			String.fromCharCode(rend),
			String.fromCharCode(att),
			String.fromCharCode(flag),
			this.gl,
			this.gr,
			String.fromCharCode(size),
			names,
		].join(";");
	}

	private restoreCursorInformation(data: string): void {
		const parts = data.split(";");
		if (parts.length < 10) return;
		const [row, col, page, rend, att, flag, gl, gr, size, names] = parts as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		const r = rend.charCodeAt(0);
		const f = flag.charCodeAt(0);
		this.page = Math.max(0, Math.min(this.pages.length - 1, Number(page) - 1 || 0));
		this.row = Math.max(0, Math.min(this.pageLines - 1, Number(row) - 1 || 0));
		this.col = Math.max(0, Math.min(this.columns - 1, Number(col) - 1 || 0));
		this.sgr =
			(r & 8 ? ATTR_REVERSE : 0) | (r & 4 ? ATTR_BLINK : 0) | (r & 2 ? ATTR_UNDERLINE : 0) | (r & 1 ? ATTR_BOLD : 0);
		this.protect = (att.charCodeAt(0) & 1) === 1;
		this.pendingWrap = (f & 8) !== 0 && this.autowrap;
		this.singleShift = f & 4 ? 3 : f & 2 ? 2 : 0;
		this.originMode = (f & 1) === 1;
		this.gl = Math.max(0, Math.min(3, Number(gl) || 0));
		this.gr = Math.max(0, Math.min(3, Number(gr) || 0));
		const sizes = size.charCodeAt(0);
		// the names follow each other: intermediates, then a final
		let slot = 0;
		let name = "";
		for (const char of names) {
			name += char;
			const code = char.charCodeAt(0);
			if (code >= 0x20 && code <= 0x2f) continue;
			const font = this.softFonts.find((candidate) => candidate.name === name);
			const id = font ? "drcs" : charsetFor(name, (sizes & (1 << slot)) !== 0);
			if (id && slot < 4) this.designations[slot] = id;
			if (font) this.drcsName = name;
			slot++;
			name = "";
		}
	}

	private tabReport(): string {
		return this.tabs.flatMap((tab, col) => (tab ? [String(col + 1)] : [])).join("/");
	}

	private restoreTabs(data: string): void {
		this.tabs.fill(false);
		for (const part of data.split("/")) {
			const col = Number(part) - 1;
			if (Number.isInteger(col) && col >= 0 && col < this.columns) this.tabs[col] = true;
		}
	}

	/** What DECTSR carries: modes, margins, the size and the status line type; not the screen or the cursor. */
	terminalState(): TerminalState {
		return {
			columns: this.columns,
			screenLines: this.screenLines,
			pageLines: this.pageLines,
			statusType: this.statusType,
			top: this.top,
			bottom: this.bottom,
			left: this.left,
			right: this.right,
			sgr: this.sgr,
			designations: [...this.designations],
			gl: this.gl,
			gr: this.gr,
			modes: Object.fromEntries(STATE_MODES.map((mode) => [mode, this[mode]])),
			attributeExtent: this.attributeExtent,
			userPreferred: this.userPreferred,
		};
	}

	private restoreState(data: string): void {
		const state = decodeState(data);
		if (!state) return;
		if (state.columns !== this.columns) this.setColumns(state.columns === 132 ? 132 : 80, false);
		this.setPageLength(state.pageLines);
		this.setScreenLines(state.screenLines);
		if (state.statusType !== this.statusType) this.selectStatusLineType(state.statusType);
		this.top = clamp(state.top, 0, this.pageLines - 1);
		this.bottom = clamp(state.bottom, this.top, this.pageLines - 1);
		this.left = clamp(state.left, 0, this.columns - 1);
		this.right = clamp(state.right, this.left, this.columns - 1);
		this.sgr = state.sgr & VISUAL;
		this.designations = state.designations.slice(0, 4) as CharsetId[];
		this.gl = clamp(state.gl, 0, 3);
		this.gr = clamp(state.gr, 0, 3);
		for (const mode of STATE_MODES) {
			if (typeof state.modes[mode] === "boolean") this[mode] = state.modes[mode];
		}
		this.attributeExtent = state.attributeExtent;
		this.userPreferred = state.userPreferred === "latin1" ? "latin1" : "dec";
	}

	// ---- user-defined keys and macros

	/** DECUDK: `Pc;Pl;Pm | Ky/St;...` with St in hex pairs. */
	private defineKeys(params: number[], data: string): void {
		if (this.level < 2 || this.udkLocked) return;
		const [clear = 0, lock = 0, modifier = 0] = params;
		if (modifier > 2) return;
		const keys = modifier === 1 ? this.udkUnshifted : this.udkShifted;
		if (clear === 0) keys.clear();
		for (const definition of data.replace(/[\x08-\x0d]/g, "").split(";")) {
			if (definition === "") continue;
			const [key, value = ""] = definition.split("/");
			const number = Number(key);
			if (!UDK_NUMBERS.has(number)) break;
			const bytes = decodeHex(value);
			if (bytes === undefined) break;
			keys.delete(number);
			if (this.udkBytes() + bytes.length > UDK_SPACE) break;
			if (bytes !== "") keys.set(number, bytes);
		}
		if (lock === 0) this.udkLocked = true;
	}

	private udkBytes(): number {
		let total = 0;
		for (const value of this.udkShifted.values()) total += value.length;
		for (const value of this.udkUnshifted.values()) total += value.length;
		return total;
	}

	/** DECDMAC: `Pid;Pdt;Pen !z D...D`, the data in text or in hex pairs with `!Pn;...;` repeats. */
	private defineMacro(params: number[], data: string): void {
		if (this.level < 2) return;
		const [id = 0, deletion = 0, encoding = 0] = params;
		if (id > 63 || deletion > 1 || encoding > 1) return;
		if (deletion === 1) this.macros.clear();
		else this.macros.delete(id);
		data = data.replace(/[\x08-\x0d]/g, "");
		let text: string | undefined;
		if (encoding === 0) text = data;
		else {
			text = "";
			for (const part of data.split(/(![0-9]*;[0-9A-Fa-f]*;?)/)) {
				const repeat = /^!([0-9]*);([0-9A-Fa-f]*);?$/.exec(part);
				const decoded = decodeHex(repeat ? repeat[2]! : part);
				if (decoded === undefined) return;
				text += repeat ? decoded.repeat(Number(repeat[1]) || 1) : decoded;
			}
		}
		if (text === "" || this.macroBytes() + text.length > MACRO_SPACE) return;
		this.macros.set(id, text);
	}

	private macroBytes(): number {
		let total = 0;
		for (const macro of this.macros.values()) total += macro.length;
		return total;
	}

	private invokeMacro(id: number): void {
		const macro = this.macros.get(id);
		if (!macro || this.macroDepth > 4) return;
		this.macroDepth++;
		try {
			for (let i = 0; i < macro.length; i++) this.parser.byte(macro.charCodeAt(i));
		} finally {
			this.macroDepth--;
		}
	}

	// ---- the printer port, with nothing on it

	/** In printer controller mode everything goes to the printer but CSI 4 i, which ends it. */
	private printerByte(code: number): void {
		const steps = this.printerMatch;
		if (code === 0x1b) this.printerMatch = 1;
		else if (code === 0x9b) this.printerMatch = 2;
		else if (steps === 1 && code === 0x5b) this.printerMatch = 2;
		else if (steps === 2 && code === 0x34) this.printerMatch = 3;
		else if (steps === 3 && code === 0x69) {
			this.printerController = false;
			this.printerMatch = 0;
		} else this.printerMatch = 0;
	}
}

/** The modes DECTSR saves and DECRSTS restores. */
const STATE_MODES = [
	"keyboardLocked",
	"insertMode",
	"localEcho",
	"newLine",
	"cursorKeysApplication",
	"smoothScroll",
	"screenReverse",
	"originMode",
	"autowrap",
	"autorepeat",
	"cursorVisible",
	"national",
	"verticalCoupling",
	"pageCoupling",
	"keypadApplication",
	"backarrowBS",
	"leftRightMarginMode",
	"transmitLimited",
] as const;

/** The keys DECUDK may define (Table 11-1). */
const UDK_NUMBERS = new Set([11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24, 25, 26, 28, 29, 31, 32, 33, 34]);

export interface TerminalState {
	columns: number;
	screenLines: number;
	pageLines: number;
	statusType: number;
	top: number;
	bottom: number;
	left: number;
	right: number;
	sgr: number;
	designations: string[];
	gl: number;
	gr: number;
	modes: Record<string, boolean>;
	attributeExtent: number;
	userPreferred: string;
}

/** The character sets in DECTSR, by their place here. */
const STATE_CHARSETS: readonly CharsetId[] = [
	"ascii",
	"graphics",
	"technical",
	"dec-supplemental",
	"latin1",
	"user-preferred",
	"drcs",
	"british",
	"finnish",
	"french",
	"french-canadian",
	"german",
	"italian",
	"norwegian",
	"portuguese",
	"spanish",
	"swedish",
	"swiss",
];

/**
 * DECTSR's data is the terminal's own. A VT420's is characters from @ to O, four bits each, and so is this one: a
 * byte for each number of the state, the modes a bit each, short enough to go out at 175 characters a second.
 */
function encodeState(state: TerminalState): string {
	const modeBytes = new Array<number>(Math.ceil(STATE_MODES.length / 8)).fill(0);
	STATE_MODES.forEach((mode, i) => {
		if (state.modes[mode]) modeBytes[i >> 3]! |= 1 << (i & 7);
	});
	const numbers = [
		state.columns === 132 ? 1 : 0,
		state.screenLines,
		state.pageLines,
		state.statusType,
		state.top,
		state.bottom,
		state.left,
		state.right,
		state.sgr,
		...state.designations.map((id) => Math.max(0, STATE_CHARSETS.indexOf(id as CharsetId))),
		state.gl,
		state.gr,
		state.attributeExtent,
		state.userPreferred === "latin1" ? 1 : 0,
		...modeBytes,
	];
	return numbers.map((n) => String.fromCharCode(0x40 + ((n >> 4) & 15), 0x40 + (n & 15))).join("");
}

function decodeState(data: string): TerminalState | undefined {
	if (data.length % 2 !== 0 || /[^@-O]/.test(data)) return undefined;
	const numbers: number[] = [];
	for (let at = 0; at < data.length; at += 2)
		numbers.push(((data.charCodeAt(at) - 0x40) << 4) | (data.charCodeAt(at + 1) - 0x40));
	const modeBytes = Math.ceil(STATE_MODES.length / 8);
	if (numbers.length !== 17 + modeBytes) return undefined;
	const n = (index: number): number => numbers[index]!;
	const modes: Record<string, boolean> = {};
	STATE_MODES.forEach((mode, i) => {
		modes[mode] = (n(17 + (i >> 3)) & (1 << (i & 7))) !== 0;
	});
	return {
		columns: n(0) === 1 ? 132 : 80,
		screenLines: n(1),
		pageLines: n(2),
		statusType: n(3),
		top: n(4),
		bottom: n(5),
		left: n(6),
		right: n(7),
		sgr: n(8),
		designations: [9, 10, 11, 12].map((index) => STATE_CHARSETS[n(index)] ?? "ascii"),
		gl: n(13),
		gr: n(14),
		attributeExtent: n(15),
		userPreferred: n(16) === 1 ? "latin1" : "dec",
		modes,
	};
}

function decodeHex(hex: string): string | undefined {
	if (hex.length % 2 !== 0 || /[^0-9A-Fa-f]/.test(hex)) return undefined;
	let out = "";
	for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
	return out;
}

/** A setting's pairs, as DECRQSS reports DECELF, DECLFKC and DECSMKR. */
function pairs(settings: ReadonlyMap<number, number>): string {
	return [...settings].flat().join(";");
}

/** DECELF, DECLFKC or DECSMKR: pairs of what and how, 0 for all of them and 0 for the default. */
function setPairs(settings: Map<number, number>, defaults: ReadonlyMap<number, number>, params: number[]): void {
	for (let i = 0; i + 1 < params.length; i += 2) {
		const which = params[i]!;
		const how = params[i + 1]!;
		for (const key of which === 0 ? [...defaults.keys()] : [which]) {
			if (defaults.has(key)) settings.set(key, how === 0 ? defaults.get(key)! : how);
		}
	}
}

function hex4(value: number): string {
	return value.toString(16).toUpperCase().padStart(4, "0");
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

/** SGR values applied to attributes, or with `reverse` toggled as DECRARA does. */
function applyRendition(attrs: number, values: readonly number[], reverse: boolean): number {
	for (const value of values) {
		if (reverse) {
			if (value === 0) attrs ^= ATTR_BOLD | ATTR_UNDERLINE | ATTR_BLINK | ATTR_REVERSE;
			else if (value === 1) attrs ^= ATTR_BOLD;
			else if (value === 4) attrs ^= ATTR_UNDERLINE;
			else if (value === 5) attrs ^= ATTR_BLINK;
			else if (value === 7) attrs ^= ATTR_REVERSE;
			continue;
		}
		switch (value) {
			case 0:
				attrs &= ~VISUAL;
				break;
			case 1:
				attrs |= ATTR_BOLD;
				break;
			case 4:
				attrs |= ATTR_UNDERLINE;
				break;
			case 5:
				attrs |= ATTR_BLINK;
				break;
			case 7:
				attrs |= ATTR_REVERSE;
				break;
			case 8:
				attrs |= ATTR_INVISIBLE;
				break;
			case 22:
				attrs &= ~ATTR_BOLD;
				break;
			case 24:
				attrs &= ~ATTR_UNDERLINE;
				break;
			case 25:
				attrs &= ~ATTR_BLINK;
				break;
			case 27:
				attrs &= ~ATTR_REVERSE;
				break;
			case 28:
				attrs &= ~ATTR_INVISIBLE;
				break;
		}
	}
	return attrs;
}

function renditionParams(sgr: number): string {
	const values = ["0"];
	if (sgr & ATTR_BOLD) values.push("1");
	if (sgr & ATTR_UNDERLINE) values.push("4");
	if (sgr & ATTR_BLINK) values.push("5");
	if (sgr & ATTR_REVERSE) values.push("7");
	if (sgr & ATTR_INVISIBLE) values.push("8");
	return values.join(";");
}

function copyLine(line: EmuLine): EmuLine {
	return { chars: [...line.chars], attrs: [...line.attrs], lineAttr: line.lineAttr };
}

function copyCells(from: EmuLine, to: EmuLine, start: number, end: number): void {
	for (let col = start; col < end; col++) {
		to.chars[col] = from.chars[col]!;
		to.attrs[col] = from.attrs[col]!;
	}
}

function clearCells(line: EmuLine, start: number, end: number): void {
	line.chars.fill(" ", start, end);
	line.attrs.fill(0, start, end);
}

export function latin1Bytes(text: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
	return bytes;
}
