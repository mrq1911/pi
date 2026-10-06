/**
 * The VT420 the tests draw on: vt420-term's terminal (test/vt420-emu, a copy), set up as pi-vt420's README lists,
 * with the options that pose it as an earlier DEC terminal or a modern emulator, and helpers for assertions.
 */

import { cellCode, cellSet, type Line } from "../src/experimental/vt420/cells.ts";
import { cellToUnicode, type SupplementalSet } from "../src/experimental/vt420/charset.ts";
import {
	ATTR_BLINK,
	ATTR_BOLD,
	ATTR_FLAGS,
	ATTR_REVERSE,
	ATTR_UNDERLINE,
	RECOMMENDED_SETUP,
	Vt420,
	type Vt420Setup,
} from "./vt420-emu/vt420.ts";

/** Unicode text of cells, for assertions on rendered lines. */
export function cellsText(cells: readonly number[], supplemental: SupplementalSet = "dec"): string {
	return cells.map((cell) => cellToUnicode(cellSet(cell), cellCode(cell), supplemental)).join("");
}

export function linesText(lines: readonly Line[], supplemental: SupplementalSet = "dec"): string[] {
	return lines.map((line) => cellsText(line.cells, supplemental).replace(/\s+$/u, ""));
}

export const EMU_BOLD = ATTR_BOLD;
export const EMU_UNDERLINE = ATTR_UNDERLINE;
export const EMU_BLINK = ATTR_BLINK;
export const EMU_REVERSE = ATTR_REVERSE;
/** A cell's attributes without the code its character is kept as. */
export const EMU_FLAGS = ATTR_FLAGS;

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
	 * main display's (xterm), "isolated" also keeps its own G0-G3 designations.
	 */
	statusState?: "separate" | "inherit" | "isolated";
	/** Decode bytes from 0x80 as UTF-8, like a modern emulator, instead of C1 and GR. */
	utf8?: boolean;
	/** False ignores DECDWL and DECDHL, as most modern emulators do. */
	lineAttributes?: boolean;
	/** DECXRLM as Set-Up left it: true for limited transmit; undefined leaves the mode unknown to DECRQM. */
	transmitLimited?: boolean;
	/** Set-Up otherwise than the recommended one, such as the factory's. */
	setup?: Partial<Vt420Setup>;
}

export class Vt420Emulator extends Vt420 {
	constructor(options: EmulatorOptions = {}) {
		super({
			// the Set-Up pi-vt420 is made for; autowrap as the tests have always had it
			setup: {
				...RECOMMENDED_SETUP,
				autowrap: true,
				columns: options.columns ?? 80,
				lines: options.rows ?? 24,
				pageLines: options.rows ?? 24,
				...options.setup,
				statusDisplay: options.statusType ?? 1,
				userPreferred: options.userPreferredSupplemental ?? "dec",
				transmitLimited: options.transmitLimited ?? false,
			},
			onResponse: options.onResponse,
			identity: options.identity,
			statusState: options.statusState,
			utf8: options.utf8,
			lineAttributes: options.lineAttributes,
			unknownModes: options.transmitLimited === undefined ? [73] : [],
		});
	}

	get rows(): number {
		return this.pageLines;
	}
}
