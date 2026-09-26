/**
 * Fixed control sequences for setting up and restoring a VT420.
 */

import type { SupplementalSet } from "./charset.ts";

export interface DesignationOptions {
	technical: boolean;
	supplemental: SupplementalSet;
	eightBit: boolean;
}

/** G0 ASCII, G1 DEC Special Graphics, G2 DEC Technical, G3 supplemental; GL = G0, and GR = G3 in 8-bit mode. */
export function charsetDesignations(options: DesignationOptions): string {
	const g2 = options.technical ? "\x1b*>" : "\x1b*B";
	const g3 = options.supplemental === "latin1" ? "\x1b/A" : "\x1b+%5";
	return `\x1b(B\x1b)0${g2}${g3}\x0f${options.eightBit ? "\x1b|" : ""}`;
}

/** Power-up designations: ASCII in G0/G1, DEC Supplemental in G2/G3, G0 in GL and G2 in GR. */
export const DEFAULT_DESIGNATIONS = "\x1b(B\x1b)B\x1b*%5\x1b+%5\x0f\x1b}";

/** 7-bit C1 controls, replace mode, LNM reset, local echo off, autowrap off, origin mode off. */
export const SESSION_MODES = "\x1b F\x1b[4l\x1b[20l\x1b[12h\x1b[?7l\x1b[?6l";

export function statusLineType(type: number): string {
	return `\x1b[${type}$~`;
}
