import { describe, expect, it } from "vitest";
import { ATTR_BOLD, cellCode } from "../src/experimental/vt420/cells.ts";
import { Charset } from "../src/experimental/vt420/charset.ts";
import { MatrixRain, saverFrame, saverPlace } from "../src/experimental/vt420/saver.ts";

const charset = new Charset({ technical: true, supplemental: "dec", eightBit: false });

/** Column `col` of the rain, top to bottom, with spaces for blank cells. */
function column(rain: MatrixRain, col: number): string {
	return rain
		.lines()
		.map((line) => String.fromCharCode(cellCode(line.cells[col]!)))
		.join("");
}

describe("vt420 screen saver", () => {
	it("rains words down a column, last letter first and bright, so they read top to bottom", () => {
		const rain = new MatrixRain(8, 4, { random: () => 0 });
		rain.feed(charset.cells("render  frames fast"));
		expect(rain.active).toBe(true);
		for (let step = 0; step < 6; step++) rain.step();
		expect(column(rain, 0)).toBe("render  ");
		expect(column(rain, 1)).toBe("frames  ");
		expect(column(rain, 2)).toBe("  fast  ");
		// the letter that led the way down is the bright one
		expect(rain.lines()[5]!.cells[0]! & ATTR_BOLD).toBe(ATTR_BOLD);
		expect(rain.lines()[4]!.cells[0]! & ATTR_BOLD).toBe(0);
		// every step moves the whole screen down a line, which the terminal can scroll
		const before = rain.lines().map((line) => line.cells.join());
		rain.step();
		expect(
			rain
				.lines()
				.slice(1)
				.map((line) => line.cells.join()),
		).toEqual(before.slice(0, -1));
		for (let step = 0; step < 8; step++) rain.step();
		expect(rain.active).toBe(false);
	});

	it("keeps a line inside the screen wherever it is put", () => {
		const frame = saverFrame(
			4,
			10,
			charset.cells("π working"),
			saverPlace(4, 10, 9, () => 0.99),
			false,
		);
		expect(frame.lines.flatMap((line) => (line.cells.length > 0 ? [line.cells.length] : []))).toEqual([10]);
	});
});
