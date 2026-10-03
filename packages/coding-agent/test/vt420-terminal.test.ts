import { describe, expect, it } from "vitest";
import { InputParser } from "../src/experimental/vt420/input.ts";
import {
	capabilitiesFromProbe,
	emptyProbe,
	type ProbeResult,
	probeQueries,
	recordResponse,
	restoreSequence,
} from "../src/experimental/vt420/terminal.ts";
import { type EmulatorOptions, Vt420Emulator } from "./vt420-emulator.ts";

const AUTO = {
	statusLine: "auto",
	doubleSize: "auto",
	encoding: "auto",
	supplemental: "auto",
	eightBit: false,
} as const;

function probe(options: EmulatorOptions): ProbeResult {
	const result = emptyProbe();
	const parser = new InputParser({
		onEvent: (event) => {
			if (event.type === "response") recordResponse(result, event.response);
		},
	});
	const emulator = new Vt420Emulator({ ...options, onResponse: (bytes) => parser.feed(bytes) });
	emulator.feed(probeQueries());
	parser.dispose();
	return result;
}

describe("vt420 terminal probe", () => {
	it("recognizes a VT420 and enables its level-4 features", () => {
		const result = probe({ rows: 24, columns: 80, statusType: 1, userPreferredSupplemental: "latin1" });
		const caps = capabilitiesFromProbe(result, AUTO, {}, 19200);
		expect(caps).toMatchObject({
			rows: 24,
			columns: 80,
			level: 4,
			name: "VT420",
			technical: true,
			statusLine: true,
			rectangularOps: true,
			eraseCharacters: true,
			supplemental: "latin1",
			bytesPerSecond: 1920,
			screenReverse: false,
			attributeExtent: 0,
			doubleSize: true,
			deviceStatus: true,
		});
		expect(result.modes.get("?7")).toBe(1);
	});

	it("keeps a VT220 to what it has", () => {
		const caps = capabilitiesFromProbe(probe({ rows: 24, columns: 80, identity: "vt220" }), AUTO, {}, undefined);
		expect(caps).toMatchObject({
			level: 2,
			name: "VT220",
			technical: false,
			statusLine: false,
			rectangularOps: false,
			eraseCharacters: true,
			supplemental: "dec",
		});
		expect(caps.bytesPerSecond).toBeUndefined();
		expect(caps.screenReverse).toBeUndefined();
		expect(caps.deviceStatus).toBeUndefined();
		expect(restoreSequence(emptyProbe(), caps, {})).not.toContain("?5");
	});

	it("detects a UTF-8 terminal from the cursor advance of a two-byte character", () => {
		const utf8 = capabilitiesFromProbe(probe({ rows: 24, columns: 80, utf8: true }), AUTO, {}, undefined);
		expect(utf8).toMatchObject({ unicode: true, technical: true, supplemental: "latin1", rows: 24, columns: 80 });
		// whatever DEC terminal an emulator claims to be, it is named as one and does what a VT220 does
		const xtermJs = emptyProbe();
		Object.assign(xtermJs, { da1: [1, 2], da2: [0, 276, 0], utf8Column: 2 });
		expect(capabilitiesFromProbe(xtermJs, AUTO, {}, undefined)).toMatchObject({
			name: "terminal",
			level: 2,
			eraseCharacters: true,
		});
		const behind = process.env.VT420_TERM;
		process.env.VT420_TERM = "VT420";
		try {
			expect(capabilitiesFromProbe(xtermJs, AUTO, {}, undefined).name).toBe("VT420 via vt420-term");
		} finally {
			if (behind === undefined) delete process.env.VT420_TERM;
			else process.env.VT420_TERM = behind;
		}
		// an emulator that does not answer DA1 keeps level 0, so frames are not paced by it
		expect(capabilitiesFromProbe({ ...emptyProbe(), utf8Column: 2 }, AUTO, {}, undefined).level).toBe(0);
		expect(capabilitiesFromProbe(probe({ rows: 24, columns: 80 }), AUTO, {}, undefined).unicode).toBe(false);
		const forced = capabilitiesFromProbe(
			probe({ rows: 24, columns: 80, utf8: true }),
			{ ...AUTO, encoding: "dec" },
			{},
			undefined,
		);
		expect(forced.unicode).toBe(false);
	});

	it("notices a terminal that ignores double-width lines and leaves the probe row as it was", () => {
		const size = (options: EmulatorOptions, doubleSize: "auto" | "on" | "off" = "auto"): boolean | undefined =>
			capabilitiesFromProbe(probe(options), { ...AUTO, doubleSize }, {}, undefined).doubleSize;
		expect(size({ rows: 24, columns: 80 })).toBe(true);
		expect(size({ rows: 24, columns: 132 })).toBe(true);
		expect(size({ rows: 24, columns: 80, utf8: true, lineAttributes: false })).toBe(false);
		expect(size({ rows: 24, columns: 80, utf8: true, lineAttributes: false }, "on")).toBe(true);
		expect(size({ rows: 24, columns: 80 }, "off")).toBe(false);
		expect(capabilitiesFromProbe(emptyProbe(), AUTO, {}, undefined).doubleSize).toBe(true);
		const emulator = new Vt420Emulator({ rows: 24, columns: 80 });
		emulator.feed(probeQueries());
		expect(emulator.lines.map((_, row) => emulator.lineAttr(row)).every((attr) => attr === 0)).toBe(true);
		expect({ row: emulator.row, col: emulator.col }).toEqual({ row: 0, col: 0 });
	});

	it("falls back to the tty size and VT420 glyphs when nothing answers", () => {
		const caps = capabilitiesFromProbe(emptyProbe(), AUTO, { rows: 36, columns: 132 }, undefined);
		expect(caps).toMatchObject({ rows: 36, columns: 132, level: 0, technical: true, statusLine: false });
		expect(capabilitiesFromProbe(emptyProbe(), { ...AUTO, statusLine: "on" }, {}, undefined).statusLine).toBe(true);
	});

	it("prefers the displayed extent over the cursor report for the screen size", () => {
		const result = emptyProbe();
		result.extent = { lines: 24, columns: 80 };
		result.cpr = { row: 72, col: 80 };
		expect(capabilitiesFromProbe(result, AUTO, {}, undefined).rows).toBe(24);
	});

	it("lifts limited transmit for the session and puts it back", () => {
		const limited = probe({ rows: 24, columns: 80, transmitLimited: true });
		expect(limited.modes.get("?73")).toBe(1);
		expect(restoreSequence(limited, { statusLine: false }, {})).toContain("\x1b[?73h");
		const unlimited = probe({ rows: 24, columns: 80, transmitLimited: false });
		expect(restoreSequence(unlimited, { statusLine: false }, {})).toContain("\x1b[?73l");
		// a terminal that does not know the mode is left alone
		expect(restoreSequence(probe({ rows: 24, columns: 80 }), { statusLine: false }, {})).not.toContain("?73");
	});

	it("restores the reported modes and status line type", () => {
		const result = probe({ rows: 24, columns: 80, statusType: 0 });
		result.modes.set("?7", 2);
		const restore = restoreSequence(result, { statusLine: true }, {});
		expect(restore).toContain("\x1b[0$~");
		expect(restore).toContain("\x1b[?7l");
		expect(restore).toContain("\x1b[?25h");
		expect(restore).toContain("\x1b(B\x1b)B\x1b*%5\x1b+%5\x0f");
		expect(restore).toContain("\x1b[?5l");
		expect(restore).toContain("\x1b[0*x");
		const emulator = new Vt420Emulator({ rows: 24, columns: 80 });
		emulator.feed(`\x1b[?7l\x1b[2$~${restore}`);
		expect(emulator.statusType).toBe(0);
		expect(emulator.autowrap).toBe(false);
	});
});
