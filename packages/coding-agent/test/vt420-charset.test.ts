import { describe, expect, it } from "vitest";
import {
	ATTR_BOLD,
	ATTR_REVERSE,
	cellCode,
	cellSet,
	GLYPH_MASK,
	glyph,
	SET_ASCII,
	SET_GRAPHICS,
	SET_SUPPLEMENTAL,
	SET_TECHNICAL,
} from "../src/experimental/vt420/cells.ts";
import { Charset, decodeGR } from "../src/experimental/vt420/charset.ts";
import { cellsText } from "./vt420-emulator.ts";

const vt420 = new Charset({ technical: true, supplemental: "dec", eightBit: false });
const latin1 = new Charset({ technical: true, supplemental: "latin1", eightBit: false });
const vt220 = new Charset({ technical: false, supplemental: "dec", eightBit: false });

describe("vt420 charset", () => {
	it("puts pi, line drawing and the VT100 symbols in DEC Special Graphics", () => {
		expect(vt420.cells("π")).toEqual([glyph(SET_GRAPHICS, 0x7b)]);
		expect(vt420.cells("┌─┐│└┘├┤┬┴┼")).toEqual(
			[0x6c, 0x71, 0x6b, 0x78, 0x6d, 0x6a, 0x74, 0x75, 0x77, 0x76, 0x6e].map((code) => glyph(SET_GRAPHICS, code)),
		);
		const symbols = "◆▒°±≤≥≠£·⎺⎻⎼⎽␉␌␍␊␤␋";
		expect(vt420.cells(symbols).map(cellSet)).toEqual(new Array([...symbols].length).fill(SET_GRAPHICS));
	});

	it("folds heavy, double, rounded and dashed box drawing onto the light glyphs", () => {
		expect(cellsText(vt420.cells("╭━━╮┃╰══╯┆"))).toBe("┌──┐│└──┘│");
		expect(cellsText(vt420.cells("╔╦╗╠╬╣╚╩╝"))).toBe("┌┬┐├┼┤└┴┘");
	});

	it("uses DEC Technical for arrows, mathematics and Greek", () => {
		expect(vt420.cells("→")).toEqual([glyph(SET_TECHNICAL, 0x7d)]);
		expect(vt420.cells("Σ")).toEqual([glyph(SET_TECHNICAL, 0x53)]);
		expect(vt420.cells("√∞∫∴⇒≡")).toEqual(
			[0x56, 0x42, 0x3f, 0x40, 0x4e, 0x4f].map((code) => glyph(SET_TECHNICAL, code)),
		);
		expect(cellsText(vt420.cells("αβγδ ∑∏ ≈ ∈"))).toBe("αβγδ ΣΠ ≃ ε");
	});

	it("maps accented Latin letters to the supplemental set and strips what it lacks", () => {
		expect(vt420.cells("é")).toEqual([glyph(SET_SUPPLEMENTAL, 0x69)]);
		expect(vt420.cells("ß")).toEqual([glyph(SET_SUPPLEMENTAL, 0x5f)]);
		expect(cellsText(vt420.cells("Příliš žluťoučký kůň"))).toBe("Prílis zlutoucky kun");
		expect(cellsText(latin1.cells("Příliš žluťoučký kůň"), "latin1")).toBe("Prílis zlutoucký kun");
		expect(cellsText(vt420.cells("Œuvre"))).toBe("Œuvre");
		expect(cellsText(latin1.cells("Œuvre ý × ÷"), "latin1")).toBe("OEuvre ý × ÷");
		expect(cellSet(latin1.cell("×"))).toBe(SET_SUPPLEMENTAL);
		expect(cellSet(vt420.cell("×"))).toBe(SET_TECHNICAL);
	});

	it("transliterates typography and drops pictographs", () => {
		expect(cellsText(vt420.cells("“quoted” — ‘it’s’ …"))).toBe("\"quoted\" ─ 'it's' ...");
		expect(cellsText(vt420.cells("done ✅ failed ❌ warn ⚠️"))).toBe("done √ failed × warn !");
		expect(cellsText(vt420.cells("ship 🚀 it 👍🏽! 🇨🇿"))).toBe("ship  it ! ");
		expect(cellsText(vt420.cells("中文"))).toBe("??");
	});

	it("renders blocks as reverse video, shades as the checkerboard and bars as scan lines", () => {
		expect(vt420.cells("█")).toEqual([0x20 | ATTR_REVERSE]);
		expect(cellsText(vt420.cells("░▓"))).toBe("▒▒");
		expect(cellsText(vt420.cells("▁▃▅▇"))).toBe("⎽⎼⎻⎺");
	});

	it("never lets control characters through", () => {
		const cells = vt420.cells("red \x1b[31mtext\x07\x9b\r\n");
		expect(cellsText(cells)).toBe("red [31mtext");
		for (const cell of cells) expect(cellCode(cell)).toBeGreaterThanOrEqual(0x20);
	});

	it("keeps attributes on every cell of a transliteration", () => {
		const cells = vt420.cells("…", ATTR_BOLD);
		expect(cells).toHaveLength(3);
		for (const cell of cells) expect(cell & ~GLYPH_MASK).toBe(ATTR_BOLD);
	});

	it("falls back to ASCII when the terminal has no DEC Technical set", () => {
		expect(cellsText(vt220.cells("a → b ⇒ c √ Σ α"))).toBe("a -> b => c V S a");
		expect(vt220.cells("π")).toEqual([glyph(SET_GRAPHICS, 0x7b)]);
		for (const cell of vt220.cells("→Σ∫≡")) expect(cellSet(cell)).toBe(SET_ASCII);
	});

	it("decodes GR input with the user-preferred supplemental set", () => {
		expect(decodeGR(0xe9, "dec")).toBe("é");
		expect(decodeGR(0xd7, "dec")).toBe("Œ");
		expect(decodeGR(0xd7, "latin1")).toBe("×");
		expect(decodeGR(0xa4, "dec")).toBeUndefined();
	});
});
