/**
 * VT420 character sets and Unicode transliteration.
 *
 * The frontend designates four sets once at startup and never changes them:
 *   G0 ASCII, G1 DEC Special Graphics, G2 DEC Technical, G3 DEC Supplemental or ISO Latin-1.
 * Text from the model is Unicode; every code point is mapped to a glyph in one of these sets, to a short
 * transliteration built from them, or dropped. Nothing outside the sets ever reaches the terminal, so text
 * can never inject control sequences.
 */

import { ATTR_REVERSE, glyph, SET_ASCII, SET_GRAPHICS, SET_SUPPLEMENTAL, SET_TECHNICAL } from "./cells.ts";

/** DEC Special Graphics codes 0x5F-0x7E. Codes 0x20-0x5E are identical to ASCII. */
export const SPECIAL_GRAPHICS: ReadonlyMap<number, string> = new Map([
	[0x5f, " "],
	[0x60, "◆"],
	[0x61, "▒"],
	[0x62, "␉"],
	[0x63, "␌"],
	[0x64, "␍"],
	[0x65, "␊"],
	[0x66, "°"],
	[0x67, "±"],
	[0x68, "␤"],
	[0x69, "␋"],
	[0x6a, "┘"],
	[0x6b, "┐"],
	[0x6c, "┌"],
	[0x6d, "└"],
	[0x6e, "┼"],
	[0x6f, "⎺"],
	[0x70, "⎻"],
	[0x71, "─"],
	[0x72, "⎼"],
	[0x73, "⎽"],
	[0x74, "├"],
	[0x75, "┤"],
	[0x76, "┴"],
	[0x77, "┬"],
	[0x78, "│"],
	[0x79, "≤"],
	[0x7a, "≥"],
	[0x7b, "π"],
	[0x7c, "≠"],
	[0x7d, "£"],
	[0x7e, "·"],
]);

/** DEC Technical codes with a Unicode equivalent (xterm's table). 0x31-0x37 are sigma pieces without one. */
export const TECHNICAL: ReadonlyMap<number, string> = new Map([
	[0x21, "⎷"],
	[0x22, "┌"],
	[0x23, "─"],
	[0x24, "⌠"],
	[0x25, "⌡"],
	[0x26, "│"],
	[0x27, "⎡"],
	[0x28, "⎣"],
	[0x29, "⎤"],
	[0x2a, "⎦"],
	[0x2b, "⎧"],
	[0x2c, "⎩"],
	[0x2d, "⎫"],
	[0x2e, "⎭"],
	[0x2f, "⎨"],
	[0x30, "⎬"],
	[0x3c, "≤"],
	[0x3d, "≠"],
	[0x3e, "≥"],
	[0x3f, "∫"],
	[0x40, "∴"],
	[0x41, "∝"],
	[0x42, "∞"],
	[0x43, "÷"],
	[0x44, "Δ"],
	[0x45, "∇"],
	[0x46, "Φ"],
	[0x47, "Γ"],
	[0x48, "∼"],
	[0x49, "≃"],
	[0x4a, "Θ"],
	[0x4b, "×"],
	[0x4c, "Λ"],
	[0x4d, "⇔"],
	[0x4e, "⇒"],
	[0x4f, "≡"],
	[0x50, "Π"],
	[0x51, "Ψ"],
	[0x53, "Σ"],
	[0x56, "√"],
	[0x57, "Ω"],
	[0x58, "Ξ"],
	[0x59, "Υ"],
	[0x5a, "⊂"],
	[0x5b, "⊃"],
	[0x5c, "∩"],
	[0x5d, "∪"],
	[0x5e, "∧"],
	[0x5f, "∨"],
	[0x60, "¬"],
	[0x61, "α"],
	[0x62, "β"],
	[0x63, "χ"],
	[0x64, "δ"],
	[0x65, "ε"],
	[0x66, "φ"],
	[0x67, "γ"],
	[0x68, "η"],
	[0x69, "ι"],
	[0x6a, "θ"],
	[0x6b, "κ"],
	[0x6c, "λ"],
	[0x6e, "ν"],
	[0x6f, "∂"],
	[0x70, "π"],
	[0x71, "ψ"],
	[0x72, "ρ"],
	[0x73, "σ"],
	[0x74, "τ"],
	[0x76, "ƒ"],
	[0x77, "ω"],
	[0x78, "ξ"],
	[0x79, "υ"],
	[0x7a, "ζ"],
	[0x7b, "←"],
	[0x7c, "↑"],
	[0x7d, "→"],
	[0x7e, "↓"],
]);

/** Composite pieces of the DEC Technical set, for assembling multi-row symbols. */
export const TECH = {
	radicalBottom: 0x21,
	radicalTop: 0x22,
	horizontal: 0x23,
	integralTop: 0x24,
	integralBottom: 0x25,
	vertical: 0x26,
	bracketUpperLeft: 0x27,
	bracketLowerLeft: 0x28,
	bracketUpperRight: 0x29,
	bracketLowerRight: 0x2a,
	braceUpperLeft: 0x2b,
	braceLowerLeft: 0x2c,
	braceUpperRight: 0x2d,
	braceLowerRight: 0x2e,
	braceMiddleLeft: 0x2f,
	braceMiddleRight: 0x30,
	sigmaTopLeft: 0x31,
	sigmaBottomLeft: 0x32,
	sigmaTopDiagonal: 0x33,
	sigmaBottomDiagonal: 0x34,
	sigmaTopRight: 0x35,
	sigmaBottomRight: 0x36,
	sigmaMiddle: 0x37,
} as const;

/** Approximate Unicode shapes for the sigma pieces, used only when displaying terminal contents. */
export const TECHNICAL_SIGMA_PREVIEW: ReadonlyMap<number, string> = new Map([
	[0x31, "⎲"],
	[0x32, "⎳"],
	[0x33, "╲"],
	[0x34, "╱"],
	[0x35, "⌝"],
	[0x36, "⌟"],
	[0x37, "⟩"],
]);

const DEC_SUPPLEMENTAL_UNDEFINED = new Set([
	0x24, 0x26, 0x2c, 0x2d, 0x2e, 0x2f, 0x34, 0x38, 0x3e, 0x50, 0x5e, 0x70, 0x7e,
]);
const DEC_SUPPLEMENTAL_OVERRIDES: ReadonlyMap<number, string> = new Map([
	[0x28, "¤"],
	[0x57, "Œ"],
	[0x5d, "Ÿ"],
	[0x77, "œ"],
	[0x7d, "ÿ"],
]);

/** DEC Supplemental Graphic (the right half of the DEC Multinational set), codes 0x21-0x7E. */
export const DEC_SUPPLEMENTAL: ReadonlyMap<number, string> = (() => {
	const map = new Map<number, string>();
	for (let code = 0x21; code <= 0x7e; code++) {
		if (DEC_SUPPLEMENTAL_UNDEFINED.has(code)) continue;
		map.set(code, DEC_SUPPLEMENTAL_OVERRIDES.get(code) ?? String.fromCharCode(code + 0x80));
	}
	return map;
})();

/** ISO Latin-1 supplemental, a 96-character set: code 0x20-0x7F is U+00A0-U+00FF. */
export const LATIN1_SUPPLEMENTAL: ReadonlyMap<number, string> = (() => {
	const map = new Map<number, string>();
	for (let code = 0x20; code <= 0x7f; code++) map.set(code, String.fromCharCode(code + 0x80));
	return map;
})();

export type SupplementalSet = "dec" | "latin1";

export interface CharsetOptions {
	/** Whether G2 holds DEC Technical (DA1 extension 15). */
	technical: boolean;
	/** Which supplemental set G3 holds. */
	supplemental: SupplementalSet;
	/** Whether 8-bit GR codes reach the terminal. A 96-set's 0x20 and 0x7F are only reachable through GR. */
	eightBit: boolean;
}

/**
 * Transliterations for code points without a glyph. Values are built only from mappable characters.
 * Entries mapped to "" are dropped.
 */
const FALLBACKS: Record<string, string> = {
	// spaces and invisible format characters
	"\u00a0": " ",
	"\u00ad": "",
	"\u2000": " ",
	"\u2001": " ",
	"\u2002": " ",
	"\u2003": " ",
	"\u2004": " ",
	"\u2005": " ",
	"\u2006": " ",
	"\u2007": " ",
	"\u2008": " ",
	"\u2009": " ",
	"\u200a": " ",
	"\u202f": " ",
	"\u205f": " ",
	"\u3000": " ",
	// punctuation
	"‐": "-",
	"‑": "-",
	"‒": "-",
	"–": "-",
	"—": "─",
	"―": "─",
	"⸺": "──",
	"−": "-",
	"‘": "'",
	"’": "'",
	"‚": ",",
	"‛": "'",
	"“": '"',
	"”": '"',
	"„": '"',
	"‟": '"',
	"′": "'",
	"″": '"',
	"‹": "<",
	"›": ">",
	"…": "...",
	"‥": "..",
	"•": "·",
	"‣": ">",
	"⁃": "-",
	"∙": "·",
	"⋅": "·",
	"‖": "||",
	"†": "+",
	"‡": "+",
	"‰": "0/00",
	"™": "TM",
	"®": "(R)",
	"℃": "°C",
	"℉": "°F",
	"№": "No",
	"€": "EUR",
	"₹": "INR",
	"₽": "RUB",
	"₩": "KRW",
	"₿": "BTC",
	// arrows
	"↔": "⇔",
	"⇐": "<=",
	"⇑": "↑",
	"⇓": "↓",
	"⟵": "←",
	"⟶": "→",
	"⟷": "⇔",
	"⟹": "⇒",
	"⟸": "<=",
	"⟺": "⇔",
	"➜": "→",
	"➔": "→",
	"➝": "→",
	"➞": "→",
	"➡": "→",
	"⮕": "→",
	"⬅": "←",
	"⬆": "↑",
	"⬇": "↓",
	"↵": "␍",
	"⏎": "␍",
	"↩": "←",
	"↪": "→",
	"↳": "└",
	"↗": "/",
	"↘": "\\",
	"↙": "/",
	"↖": "\\",
	// mathematics
	"≈": "≃",
	"≅": "≃",
	"≒": "≃",
	"∈": "ε",
	"∊": "ε",
	"⊆": "⊂",
	"⊇": "⊃",
	"∵": "∴",
	"∑": "Σ",
	"∏": "Π",
	"∆": "Δ",
	"\u2126": "\u03a9",
	"\u03bc": "\u00b5",
	"∗": "*",
	"∕": "/",
	"∣": "|",
	"∥": "||",
	"≪": "<<",
	"≫": ">>",
	"⩽": "≤",
	"⩾": "≥",
	"⌈": "⎡",
	"⌊": "⎣",
	"⌉": "⎤",
	"⌋": "⎦",
	"∀": "A",
	"∃": "E",
	"∅": "{}",
	"⊕": "(+)",
	"⊗": "(x)",
	"⁰": "0",
	"⁴": "4",
	"⁵": "5",
	"⁶": "6",
	"⁷": "7",
	"⁸": "8",
	"⁹": "9",
	"⁺": "+",
	"⁻": "-",
	ⁿ: "n",
	"₀": "0",
	"₁": "1",
	"₂": "2",
	"₃": "3",
	"₄": "4",
	"₅": "5",
	"₆": "6",
	"₇": "7",
	"₈": "8",
	"₉": "9",
	"⅓": "1/3",
	"⅔": "2/3",
	"⅛": "1/8",
	"¾": "3/4",
	// Greek letters that look like Latin ones or have no glyph
	Α: "A",
	Β: "B",
	Ε: "E",
	Ζ: "Z",
	Η: "H",
	Ι: "I",
	Κ: "K",
	Μ: "M",
	Ν: "N",
	Ο: "O",
	Ρ: "P",
	Τ: "T",
	Χ: "X",
	ο: "o",
	ς: "σ",
	ϑ: "θ",
	ϕ: "φ",
	ϵ: "ε",
	// checks, crosses and pictographs that carry meaning
	"✓": "√",
	"✔": "√",
	"☑": "√",
	"✅": "√",
	"✗": "×",
	"✘": "×",
	"✕": "×",
	"✖": "×",
	"❌": "×",
	"☒": "×",
	"⚠": "!",
	"❗": "!",
	"❓": "?",
	"★": "*",
	"☆": "*",
	"⭐": "*",
	"✦": "*",
	"✧": "*",
	"✱": "*",
	// shapes
	"●": "◆",
	"◉": "◆",
	"♦": "◆",
	"◇": "◆",
	"◊": "◆",
	"⬥": "◆",
	"○": "o",
	"◦": "o",
	"▪": "·",
	"▫": "·",
	"□": "[]",
	"▲": "^",
	"△": "^",
	"▴": "^",
	"▼": "v",
	"▽": "v",
	"▾": "v",
	"▶": ">",
	"►": ">",
	"▸": ">",
	"▹": ">",
	"◀": "<",
	"◄": "<",
	"◂": "<",
	"◃": "<",
	// shades and bar-chart blocks: shades become the checkerboard, bars become scan lines
	"░": "▒",
	"▓": "▒",
	"▁": "⎽",
	"▂": "⎼",
	"▃": "⎼",
	"▄": "─",
	"▅": "⎻",
	"▆": "⎻",
	"▇": "⎺",
	"▔": "⎺",
	"▕": "│",
	"▏": "│",
	"╱": "/",
	"╲": "\\",
	"╳": "X",
	// ligatures without a supplemental glyph
	ﬁ: "fi",
	ﬂ: "fl",
	ﬀ: "ff",
	ﬃ: "ffi",
	ﬄ: "ffl",
	Ĳ: "IJ",
	ĳ: "ij",
	Ł: "L",
	ł: "l",
	Đ: "D",
	đ: "d",
	Ħ: "H",
	ħ: "h",
	ı: "i",
	ŉ: "'n",
	Ŋ: "N",
	ŋ: "n",
	ſ: "s",
	Þ: "Th",
	þ: "th",
	Ð: "D",
	ð: "d",
	ẞ: "SS",
	Œ: "OE",
	œ: "oe",
	"¦": "|",
	"¨": '"',
	"¯": "-",
	"´": "'",
	"¸": ",",
};

/** ASCII stand-ins for DEC Technical glyphs, used when the terminal lacks the set (DA1 without 15). */
const TECHNICAL_FALLBACKS: Record<string, string> = {
	"←": "<-",
	"→": "->",
	"↑": "^",
	"↓": "v",
	"⇒": "=>",
	"⇔": "<=>",
	"√": "V",
	"×": "x",
	"÷": "/",
	"∞": "oo",
	"≡": "=",
	"∼": "~",
	"≃": "~=",
	"∴": ":.",
	"∝": "~",
	"∫": "S",
	"∂": "d",
	"∇": "V",
	ƒ: "f",
	"¬": "-",
	"∧": "^",
	"∨": "v",
	"∩": "n",
	"∪": "U",
	"⊂": "(",
	"⊃": ")",
	Γ: "G",
	Δ: "D",
	Θ: "Th",
	Λ: "L",
	Ξ: "X",
	Π: "P",
	Σ: "S",
	Υ: "Y",
	Φ: "Ph",
	Ψ: "Ps",
	Ω: "W",
	α: "a",
	β: "b",
	γ: "g",
	δ: "d",
	ε: "e",
	ζ: "z",
	η: "h",
	θ: "th",
	ι: "i",
	κ: "k",
	λ: "l",
	ν: "n",
	ξ: "x",
	ρ: "r",
	σ: "s",
	τ: "t",
	υ: "u",
	φ: "ph",
	χ: "ch",
	ψ: "ps",
	ω: "w",
	"⎷": "V",
	"⌠": "|",
	"⌡": "|",
	"⎡": "[",
	"⎣": "[",
	"⎤": "]",
	"⎦": "]",
	"⎧": "/",
	"⎨": "{",
	"⎩": "\\",
	"⎫": "\\",
	"⎬": "}",
	"⎭": "/",
};

/** Full blocks: rendered as reverse-video spaces. */
const REVERSE_BLOCKS = new Set(["█", "▉", "▊", "▋", "▌", "▍", "▎", "▐", "▀", "■", "▬", "▮", "▙", "▛", "▜", "▟"]);

const BOX_DRAWING: Record<string, string> = {};
function box(target: string, sources: string): void {
	for (const source of sources) BOX_DRAWING[source] = target;
}
box("─", "━┄┅┈┉╌╍═╴╶╸╺╼╾");
box("│", "┃┆┇┊┋╎╏║╵╷╹╻╽╿");
box("┌", "┍┎┏╒╓╔╭");
box("┐", "┑┒┓╕╖╗╮");
box("└", "┕┖┗╘╙╚╰");
box("┘", "┙┚┛╛╜╝╯");
box("├", "┝┞┟┠┡┢┣╞╟╠");
box("┤", "┥┦┧┨┩┪┫╡╢╣");
box("┬", "┭┮┯┰┱┲┳╤╥╦");
box("┴", "┵┶┷┸┹┺┻╧╨╩");
box("┼", "┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╪╫╬");

const REPLACEMENT = "?";
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/u;
const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;

/** Maps Unicode text to cells in the four designated sets. */
export class Charset {
	readonly options: CharsetOptions;
	private readonly direct = new Map<number, number>();
	private readonly cache = new Map<number, readonly number[]>();

	constructor(options: CharsetOptions) {
		this.options = options;
		// Lowest priority first; later sets overwrite shared code points.
		if (options.technical) {
			for (const [code, char] of TECHNICAL) this.direct.set(char.codePointAt(0)!, glyph(SET_TECHNICAL, code));
		}
		const supplemental = options.supplemental === "latin1" ? LATIN1_SUPPLEMENTAL : DEC_SUPPLEMENTAL;
		for (const [code, char] of supplemental) {
			// In 7-bit mode a 96-set's corner codes are SPACE and DEL, not NBSP and y-diaeresis.
			if (!options.eightBit && (code === 0x20 || code === 0x7f)) continue;
			this.direct.set(char.codePointAt(0)!, glyph(SET_SUPPLEMENTAL, code));
		}
		for (const [code, char] of SPECIAL_GRAPHICS) {
			if (code === 0x5f) continue;
			this.direct.set(char.codePointAt(0)!, glyph(SET_GRAPHICS, code));
		}
		for (let code = 0x20; code < 0x7f; code++) this.direct.set(code, glyph(SET_ASCII, code));
	}

	/** Cells for `text`, each OR-ed with `attrs`. Newlines and other controls must be handled by the caller. */
	cells(text: string, attrs = 0): number[] {
		const result: number[] = [];
		for (const char of text) {
			for (const cell of this.resolve(char)) result.push(cell | attrs);
		}
		return result;
	}

	/** The first cell for `char`, or the replacement glyph. */
	cell(char: string, attrs = 0): number {
		return (this.resolve(char)[0] ?? glyph(SET_ASCII, REPLACEMENT.charCodeAt(0))) | attrs;
	}

	/** Whether `char` has its own glyph rather than a transliteration. */
	has(char: string): boolean {
		return this.direct.has(char.codePointAt(0)!);
	}

	/** `preferred` when every character in it has its own glyph, otherwise `fallback`. */
	pick(preferred: string, fallback: string): string {
		for (const char of preferred) if (!this.has(char)) return fallback;
		return preferred;
	}

	private resolve(char: string): readonly number[] {
		const codePoint = char.codePointAt(0)!;
		const cached = this.cache.get(codePoint);
		if (cached) return cached;
		const cells = this.lookup(char, codePoint, 0);
		this.cache.set(codePoint, cells);
		return cells;
	}

	private lookup(char: string, codePoint: number, depth: number): number[] {
		const direct = this.direct.get(codePoint);
		if (direct !== undefined) return [direct];
		if (REVERSE_BLOCKS.has(char)) return [glyph(SET_ASCII, 0x20) | ATTR_REVERSE];
		const replacement =
			BOX_DRAWING[char] ?? FALLBACKS[char] ?? (this.options.technical ? undefined : TECHNICAL_FALLBACKS[char]);
		if (replacement !== undefined && depth < 3) {
			const cells: number[] = [];
			for (const part of replacement) cells.push(...this.lookup(part, part.codePointAt(0)!, depth + 1));
			return cells;
		}
		if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return [];
		if (MARK.test(char) || FORMAT.test(char) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return [];
		const decomposed = char.normalize("NFD");
		if (decomposed !== char) {
			const base = decomposed.codePointAt(0)!;
			const baseChar = String.fromCodePoint(base);
			if (!MARK.test(baseChar)) {
				const composed = decomposed.normalize("NFC");
				if (composed !== char && this.direct.has(composed.codePointAt(0)!)) {
					return [this.direct.get(composed.codePointAt(0)!)!];
				}
				return this.lookup(baseChar, base, depth + 1);
			}
		}
		const compat = char.normalize("NFKD");
		if (compat !== char && depth < 3) {
			const cells: number[] = [];
			for (const part of compat) {
				if (!MARK.test(part)) cells.push(...this.lookup(part, part.codePointAt(0)!, depth + 1));
			}
			if (cells.length > 0) return cells;
		}
		if (PICTOGRAPHIC.test(char)) return [];
		return [glyph(SET_ASCII, REPLACEMENT.charCodeAt(0))];
	}
}

/** Decode one cell back to Unicode, for tests and diagnostics. */
export function cellToUnicode(set: number, code: number, supplemental: SupplementalSet): string {
	if (code === 0x20) return " ";
	switch (set) {
		case SET_GRAPHICS:
			if (code < 0x5f) return String.fromCharCode(code);
			return SPECIAL_GRAPHICS.get(code) ?? REPLACEMENT;
		case SET_TECHNICAL:
			return TECHNICAL.get(code) ?? TECHNICAL_SIGMA_PREVIEW.get(code) ?? REPLACEMENT;
		case SET_SUPPLEMENTAL:
			return (supplemental === "latin1" ? LATIN1_SUPPLEMENTAL : DEC_SUPPLEMENTAL).get(code) ?? REPLACEMENT;
		default:
			return String.fromCharCode(code);
	}
}

/** Decode a byte the terminal sent in GR (0xA0-0xFF) using its user-preferred supplemental set. */
export function decodeGR(byte: number, supplemental: SupplementalSet): string | undefined {
	const code = byte & 0x7f;
	if (supplemental === "latin1") return LATIN1_SUPPLEMENTAL.get(code);
	return DEC_SUPPLEMENTAL.get(code);
}
