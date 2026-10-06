// vt420-term's src/emu/charsets.ts (github.com/mrq1911/vt420-term), copied for these tests: change it there, then copy it here.
/**
 * The VT420's character sets as it shows them: what a byte in GL or GR draws, by the set designated there.
 */

import {
	DEC_SUPPLEMENTAL,
	LATIN1_SUPPLEMENTAL,
	SPECIAL_GRAPHICS,
	TECHNICAL,
	TECHNICAL_SIGMA_PREVIEW,
} from "../../src/experimental/vt420/charset.ts";

export type CharsetId =
	| "ascii"
	| "graphics"
	| "technical"
	| "dec-supplemental"
	| "latin1"
	| "drcs"
	| "british"
	| "finnish"
	| "french"
	| "french-canadian"
	| "german"
	| "italian"
	| "norwegian"
	| "portuguese"
	| "spanish"
	| "swedish"
	| "swiss";

/** The reversed question mark the VT420 shows for a character it has no glyph for. */
export const ERROR_CHAR = "⸮";

/** Soft characters are kept as these code points, their position in the set added. */
export const DRCS_BASE = 0xf0000;

/** The positions a national replacement set changes: # @ [ \ ] ^ _ ` { | } ~ */
const NRC_POSITIONS = [0x23, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x7b, 0x7c, 0x7d, 0x7e];

/** Table 2-1 of the VT420 programmer reference. */
const NRC: Record<string, string> = {
	british: "£@[\\]^_`{|}~",
	finnish: "#@ÄÖÅÜ_éäöåü",
	french: "£à°ç§^_`éùè¨",
	"french-canadian": "#àâçêî_ôéùèû",
	german: "#§ÄÖÜ^_`äöüß",
	italian: "£§°çé^_ùàòèì",
	norwegian: "#@ÆØÅ^_`æøå~",
	portuguese: "#@ÃÇÕ^_`ãçõ~",
	spanish: "£§¡Ñ¿^_`°ñç~",
	swedish: "#ÉÄÖÅÜ_éäöåü",
	swiss: "ùàéçêîèôäöüû",
};

const NRC_MAPS: ReadonlyMap<string, ReadonlyMap<number, string>> = new Map(
	Object.entries(NRC).map(([id, chars]) => [id, new Map(NRC_POSITIONS.map((code, i) => [code, [...chars][i]!]))]),
);

/** SCS finals of the 94-character sets; `<` (user-preferred) is resolved when it is designated. */
const FINALS_94: Readonly<Record<string, CharsetId>> = {
	B: "ascii",
	"0": "graphics",
	">": "technical",
	"%5": "dec-supplemental",
	A: "british",
	"5": "finnish",
	C: "finnish",
	R: "french",
	"9": "french-canadian",
	Q: "french-canadian",
	K: "german",
	Y: "italian",
	"`": "norwegian",
	"6": "norwegian",
	E: "norwegian",
	"%6": "portuguese",
	Z: "spanish",
	"7": "swedish",
	H: "swedish",
	"=": "swiss",
};

export function isNational(id: CharsetId): boolean {
	return NRC_MAPS.has(id);
}

/** The set an SCS final names, or undefined for one the terminal does not have. */
export function charsetFor(final: string, size96: boolean, userPreferred: "dec" | "latin1"): CharsetId | undefined {
	if (final === "<") return userPreferred === "latin1" ? "latin1" : "dec-supplemental";
	if (size96) return final === "A" ? "latin1" : undefined;
	return FINALS_94[final];
}

/** The final an SCS sequence would use for a set, as DECCIR reports it. */
export function finalFor(id: CharsetId, drcsName: string): string {
	if (id === "drcs") return drcsName;
	if (id === "latin1") return "A";
	if (id === "dec-supplemental") return "%5";
	return Object.entries(FINALS_94).find(([, value]) => value === id)?.[0] ?? "B";
}

export function is96(id: CharsetId, drcs96: boolean): boolean {
	return id === "latin1" || (id === "drcs" && drcs96);
}

/** The character a 7-bit code (0x20-0x7F) draws in a set, undefined where the set has nothing. */
export function glyphIn(id: CharsetId, code: number): string | undefined {
	switch (id) {
		case "ascii":
			return code < 0x7f ? String.fromCharCode(code) : undefined;
		case "graphics":
			return code < 0x5f ? String.fromCharCode(code) : SPECIAL_GRAPHICS.get(code);
		case "technical":
			if (code === 0x20) return " ";
			return TECHNICAL.get(code) ?? TECHNICAL_SIGMA_PREVIEW.get(code);
		case "dec-supplemental":
			return code === 0x20 ? " " : DEC_SUPPLEMENTAL.get(code);
		case "latin1":
			return code === 0x20 ? " " : LATIN1_SUPPLEMENTAL.get(code);
		case "drcs":
			return String.fromCodePoint(DRCS_BASE + code);
		default: {
			if (code === 0x7f) return undefined;
			return NRC_MAPS.get(id)?.get(code) ?? String.fromCharCode(code);
		}
	}
}

/** The byte a character is typed as with a supplemental set in GR, or undefined where it has none. */
export function supplementalByte(char: string, userPreferred: "dec" | "latin1"): number | undefined {
	const table = userPreferred === "latin1" ? LATIN1_SUPPLEMENTAL : DEC_SUPPLEMENTAL;
	for (const [code, glyph] of table) if (glyph === char) return code | 0x80;
	return undefined;
}

/** The byte a character is typed as with a national replacement set, or undefined where it has none. */
export function nationalByte(char: string, id: CharsetId): number | undefined {
	const map = NRC_MAPS.get(id);
	if (!map) return undefined;
	for (const [code, glyph] of map) if (glyph === char) return code;
	return undefined;
}
