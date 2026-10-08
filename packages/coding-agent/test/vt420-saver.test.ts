import { ATTR_BOLD, cellCode } from "@mrq/vt420/cells.js";
import { Charset } from "@mrq/vt420/charset.js";
import { describe, expect, it } from "vitest";
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

	it("keeps each line within its bytes, so the terminal can take it in while it glides", () => {
		const text = charset.cells("the quick brown fox jumps over the lazy dog ".repeat(40));
		const seeded = (): (() => number) => {
			let seed = 7;
			return () => {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				return seed / 2147483648;
			};
		};
		const lit = (lineBytes?: number): number[] => {
			const rain = new MatrixRain(24, 80, {
				random: seeded(),
				maxDrops: 26,
				glints: 0,
				...(lineBytes ? { lineBytes } : {}),
			});
			rain.feed(text);
			const counts: number[] = [];
			for (let step = 0; step < 60; step++) {
				rain.step();
				counts.push(rain.lines()[0]!.cells.filter((cell) => cell !== 0x20).length);
			}
			return counts;
		};
		const tight = lit(40);
		// ten bytes for the line, three for each letter coming in: ten letters at most
		expect(Math.max(...tight)).toBeLessThanOrEqual(10);
		const free = lit();
		expect(free.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(tight.reduce((sum, count) => sum + count, 0));
	});

	it("leads a drop with up to three bright cells now and then", () => {
		// the first open column, the chance, then three bright
		const script = [0, 0, 0.99];
		const rain = new MatrixRain(8, 3, { random: () => script.shift() ?? 0, glints: 0 });
		rain.feed(charset.cells("abcdef"));
		for (let step = 0; step < 6; step++) rain.step();
		expect(column(rain, 0)).toBe("abcdef  ");
		const bright = rain.lines().map((line) => (line.cells[0]! & ATTR_BOLD ? 1 : 0));
		// the three that led the way down
		expect(bright).toEqual([0, 0, 0, 1, 1, 1, 0, 0]);
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

	it("hops bright glints down the streams faster than the rain, so streams seem to overtake", () => {
		const rain = new MatrixRain(24, 1, { random: () => 0, maxDrops: 1, glints: 1 });
		rain.feed(charset.cells("abcdefghijklmnopqrstuvwx"));
		// bright rows above the stream's own head, the lowest one
		const glint = (): number | undefined => {
			const rows = rain.lines().flatMap((line, row) => (line.cells[0]! & ATTR_BOLD ? [row] : []));
			return rows.length > 1 ? rows[0] : undefined;
		};
		let hops = 0;
		let last = glint();
		for (let step = 0; step < 20; step++) {
			rain.step();
			const now = glint();
			// the rain moves a row a line; a hop takes the glint three more
			if (last !== undefined && now === last + 4) hops++;
			last = now;
		}
		expect(hops).toBeGreaterThan(0);
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
