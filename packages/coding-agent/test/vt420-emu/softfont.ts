// vt420-term's src/emu/softfont.ts (github.com/mrq1911/vt420-term), copied for these tests: change it there, then copy it here.
/**
 * Soft character sets: DECDLD strings decoded into dot matrices.
 */

export interface SoftGlyph {
	/** One number per dot row, bit 0 the leftmost dot. */
	rows: number[];
}

export interface SoftFont {
	/** The Dscs name an SCS sequence designates it by. */
	name: string;
	size96: boolean;
	/** The matrix: dots across and dot rows. */
	width: number;
	height: number;
	/** Text fonts are centred in the cell; full-cell fonts fill it from the left. */
	fullCell: boolean;
	/** The screen the font is for: 80 or 132 columns, 24, 36 or 48 lines. */
	columns: number;
	lines: number;
	/** By 7-bit code, 0x20-0x7F. */
	glyphs: Map<number, SoftGlyph>;
}

const SCREENS: Readonly<Record<number, [number, number]>> = {
	0: [80, 24],
	1: [80, 24],
	2: [132, 24],
	11: [80, 36],
	12: [132, 36],
	21: [80, 48],
	22: [132, 48],
};

/** Maximum dot rows of a cell by lines on the screen, and dots across by columns (Table 5-9). */
const MAX_HEIGHT: Readonly<Record<number, number>> = { 24: 16, 36: 10, 48: 8 };

/**
 * Decode `DCS Pfn;Pcn;Pe;Pcmw;Pss;Pt;Pcmh;Pcss { Dscs sixels ST` into the font it loads: one of `loaded` with the
 * characters added when the erase control keeps the rest, or a new one. Undefined for a load the terminal ignores.
 */
export function loadSoftFont(params: number[], data: string, loaded: readonly SoftFont[]): SoftFont | undefined {
	const [, start = 0, erase = 0, matrixWidth = 0, screenSize = 0, cellType = 0, matrixHeight = 0, setSize = 0] =
		params;
	const screen = SCREENS[screenSize];
	if (!screen || erase > 2 || setSize > 1 || matrixWidth === 1 || matrixWidth > 10 || matrixHeight > 16) {
		return undefined;
	}
	const [columns, lines] = screen;
	const fullCell = cellType === 2;
	// VT220 fonts (Pcmw 2-4) are 10 rows, which the VT420 doubles
	const vt220 = matrixWidth >= 2 && matrixWidth <= 4;
	// left out, the largest the screen allows
	const maxWidth = columns === 80 ? (fullCell ? 10 : 8) : fullCell ? 6 : 5;
	const width = vt220 ? matrixWidth + 3 : matrixWidth === 0 ? maxWidth : matrixWidth;
	const height = vt220 ? 10 : matrixHeight === 0 ? MAX_HEIGHT[lines]! : matrixHeight;
	if ((!vt220 && width > maxWidth) || height > MAX_HEIGHT[lines]!) return undefined;
	// the name: up to two intermediates and a final
	let at = 0;
	while (at < data.length && at < 2 && data.charCodeAt(at) >= 0x20 && data.charCodeAt(at) <= 0x2f) at++;
	const final = data.charCodeAt(at);
	if (!(final >= 0x30 && final <= 0x7e)) return undefined;
	const name = data.slice(0, at + 1);
	const size96 = setSize === 1;
	const previous = loaded.find(
		(font) => font.name === name && font.size96 === size96 && font.columns === columns && font.lines === lines,
	);
	const font: SoftFont =
		previous && erase === 1 ? previous : { name, size96, width, height, fullCell, columns, lines, glyphs: new Map() };
	let code = size96 ? 0x20 + start : 0x20 + Math.max(1, start);
	for (const pattern of data.slice(at + 1).split(";")) {
		if (code > (size96 ? 0x7f : 0x7e)) break;
		const rows = decodeSixels(pattern.replace(/[\x08-\x0d]/g, ""), height);
		if (rows === undefined) break;
		font.glyphs.set(code, { rows: vt220 ? rows.flatMap((row) => [row, row]) : rows });
		code++;
	}
	if (vt220) font.height = 20;
	return font;
}

/** Sixel groups split by `/`, six dot rows each, a column per character; undefined for a bad character. */
function decodeSixels(pattern: string, height: number): number[] | undefined {
	const rows = new Array<number>(height).fill(0);
	let group = 0;
	let column = 0;
	for (const char of pattern) {
		if (char === "/") {
			group++;
			column = 0;
			continue;
		}
		const bits = char.charCodeAt(0) - 0x3f;
		if (bits < 0 || bits > 63) return undefined;
		for (let bit = 0; bit < 6; bit++) {
			const row = group * 6 + bit;
			if (row < height && bits & (1 << bit)) rows[row]! |= 1 << column;
		}
		column++;
	}
	return rows;
}
