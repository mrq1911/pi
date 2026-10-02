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
		const rain = new MatrixRain(8, 4, { random: () => 0, glints: 0 });
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

	it("lets a lone drop fall when there are no words, one at a time", () => {
		const rain = new MatrixRain(6, 3, { random: () => 0, glints: 0 });
		const solo = charset.cells("12sπ");
		for (let step = 0; step < 4; step++) rain.step(solo);
		expect(rain.raining).toBe(false);
		const rows = rain.lines();
		// read top to bottom, led by its last cell, the bright one
		expect(rows[3]!.cells[0]! & ATTR_BOLD).toBe(ATTR_BOLD);
		expect(rows.slice(0, 4).map((line) => line.cells[0])).toEqual([...solo.slice(0, 3), solo[3]! | ATTR_BOLD]);
		// the next one waits until this one has fallen off the screen
		for (let step = 0; step < 6; step++) rain.step(solo);
		expect(rain.lines().filter((line) => line.cells[0] !== 0x20).length).toBeLessThanOrEqual(1);
	});

	it("runs bright glints down the streams faster than the rain, so streams seem to overtake", () => {
		const rain = new MatrixRain(12, 2, { random: () => 0 });
		rain.feed(charset.cells("abcdefghijkl"));
		const bright = (): number[] => rain.lines().flatMap((line, row) => (line.cells[0]! & ATTR_BOLD ? [row] : []));
		for (let step = 0; step < 4; step++) rain.step();
		// the drop's own bright head at the bottom of what has entered, and a glint running ahead of the rain above it
		const before = bright();
		rain.step();
		rain.step();
		const after = bright();
		expect(after.length).toBeGreaterThan(1);
		// a glint races every other line: three rows in two, one ahead of the rain
		const glintBefore = Math.min(...before);
		expect(after).toContain(glintBefore + 3);
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
