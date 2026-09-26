/**
 * Screen cells for the VT420 frontend.
 *
 * A cell is one packed number: a 7-bit code in one of four designated character sets plus the VT420's
 * four visual attributes. Every glyph occupies exactly one column, so widths are array lengths.
 *
 *   bits 0-6   code within the set (0x20-0x7F)
 *   bits 7-8   set: G0 ASCII, G1 DEC Special Graphics, G2 DEC Technical, G3 supplemental
 *   bits 9-12  bold, underline, blink, reverse
 */

export const SET_ASCII = 0;
export const SET_GRAPHICS = 1;
export const SET_TECHNICAL = 2;
export const SET_SUPPLEMENTAL = 3;

export const ATTR_BOLD = 1 << 9;
export const ATTR_UNDERLINE = 1 << 10;
export const ATTR_BLINK = 1 << 11;
export const ATTR_REVERSE = 1 << 12;
export const ATTR_MASK = ATTR_BOLD | ATTR_UNDERLINE | ATTR_BLINK | ATTR_REVERSE;
export const GLYPH_MASK = 0x1ff;

export const BLANK = 0x20;

export const LINE_SINGLE = 0;
export const LINE_DOUBLE_WIDTH = 1;
export const LINE_DOUBLE_TOP = 2;
export const LINE_DOUBLE_BOTTOM = 3;
export type LineAttr =
	| typeof LINE_SINGLE
	| typeof LINE_DOUBLE_WIDTH
	| typeof LINE_DOUBLE_TOP
	| typeof LINE_DOUBLE_BOTTOM;

/** One display row. Double-width rows hold at most half the screen width in cells. */
export interface Line {
	cells: number[];
	attr: LineAttr;
}

export function glyph(set: number, code: number): number {
	return (set << 7) | code;
}

export function cellSet(cell: number): number {
	return (cell >> 7) & 3;
}

export function cellCode(cell: number): number {
	return cell & 0x7f;
}

export function isBlank(cell: number): boolean {
	return cell === BLANK;
}

export function isSpace(cell: number): boolean {
	return (cell & GLYPH_MASK) === BLANK;
}

export function lineWidth(attr: LineAttr, columns: number): number {
	return attr === LINE_SINGLE ? columns : Math.floor(columns / 2);
}

export function withAttrs(cells: readonly number[], attrs: number): number[] {
	if (attrs === 0) return [...cells];
	return cells.map((cell) => cell | attrs);
}

export function blankLine(): Line {
	return { cells: [], attr: LINE_SINGLE };
}

export function textLine(cells: number[], attr: LineAttr = LINE_SINGLE): Line {
	return { cells, attr };
}
