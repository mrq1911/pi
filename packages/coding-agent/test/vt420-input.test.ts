import { afterEach, describe, expect, it, vi } from "vitest";
import { type InputEvent, InputParser } from "../src/experimental/vt420/input.ts";
import { Keymap, keyLabel, normalizeKey } from "../src/experimental/vt420/keys.ts";

function parse(...chunks: Array<string | Uint8Array>): InputEvent[] {
	const events: InputEvent[] = [];
	const parser = new InputParser({ onEvent: (event) => events.push(event), supplemental: () => "dec" });
	for (const chunk of chunks) parser.feed(chunk);
	parser.dispose();
	return events;
}

function keys(...chunks: string[]): string[] {
	return parse(...chunks).map((event) =>
		event.type === "key" ? event.key : `${event.type}:${JSON.stringify(event)}`,
	);
}

describe("vt420 input", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("recognizes the LK401 editing keypad, top-row keys and PF keys", () => {
		expect(keys("\x1b[1~\x1b[2~\x1b[3~\x1b[4~\x1b[5~\x1b[6~")).toEqual([
			"find",
			"insert",
			"remove",
			"select",
			"prev",
			"next",
		]);
		expect(keys("\x1b[17~\x1b[18~\x1b[19~\x1b[20~\x1b[21~")).toEqual(["f6", "f7", "f8", "f9", "f10"]);
		expect(keys("\x1b[23~\x1b[24~\x1b[25~\x1b[26~\x1b[28~\x1b[29~")).toEqual([
			"f11",
			"f12",
			"f13",
			"f14",
			"help",
			"do",
		]);
		expect(keys("\x1b[31~\x1b[34~\x1b[17;2~\x1b[29;2~")).toEqual(["f17", "f20", "shift+f6", "shift+do"]);
		expect(keys("\x1bOP\x1bOQ\x1bOR\x1bOS\x1bOM\x1bOp\x1bOy")).toEqual([
			"pf1",
			"pf2",
			"pf3",
			"pf4",
			"kpenter",
			"kp0",
			"kp9",
		]);
	});

	it("reads arrows in both cursor key modes and xterm modifiers", () => {
		expect(keys("\x1b[A\x1b[B\x1bOC\x1bOD")).toEqual(["up", "down", "right", "left"]);
		expect(keys("\x1b[1;5C\x1b[1;2A\x1b[1;3D")).toEqual(["ctrl+right", "shift+up", "alt+left"]);
	});

	it("maps C0 controls to keys and coalesces printable text", () => {
		expect(parse("hello\rwor\x7fld\x03\x0a\x08\t")).toEqual([
			{ type: "text", text: "hello" },
			{ type: "key", key: "return" },
			{ type: "text", text: "wor" },
			{ type: "key", key: "backspace" },
			{ type: "text", text: "ld" },
			{ type: "key", key: "ctrl+c" },
			{ type: "key", key: "ctrl+j" },
			{ type: "key", key: "backspace" },
			{ type: "key", key: "tab" },
		]);
	});

	it("reassembles sequences split across reads", () => {
		expect(keys("\x1b", "[2", "9~")).toEqual(["do"]);
		expect(keys("\x1bP0$r2", "$~\x1b", "\\")[0]).toContain('"setting"');
	});

	it("accepts 8-bit C1 introducers and decodes GR characters", () => {
		expect(keys("\x9b29~\x8fP")).toEqual(["do", "pf1"]);
		expect(parse(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toEqual([{ type: "text", text: "café" }]);
	});

	it("decodes UTF-8 input from terminals that speak it", () => {
		const events: InputEvent[] = [];
		const parser = new InputParser({ onEvent: (event) => events.push(event), utf8: () => true });
		parser.feed(Buffer.from("café ř → ", "utf8"));
		parser.feed(Uint8Array.from([0xe2, 0x82]));
		parser.feed(Uint8Array.from([0xac, 0x1b, 0x5b, 0x41]));
		parser.dispose();
		expect(events).toEqual([
			{ type: "text", text: "café ř → " },
			{ type: "text", text: "€" },
			{ type: "key", key: "up" },
		]);
	});

	it("treats a lone ESC as Escape after the timeout and ESC-letter as Alt", () => {
		vi.useFakeTimers();
		const events: InputEvent[] = [];
		const parser = new InputParser({ onEvent: (event) => events.push(event), escapeTimeoutMs: 50 });
		parser.feed("\x1b");
		expect(events).toEqual([]);
		vi.advanceTimersByTime(60);
		expect(events).toEqual([{ type: "key", key: "escape" }]);
		parser.feed("\x1bb");
		expect(events.at(-1)).toEqual({ type: "key", key: "alt+b" });
		parser.dispose();
	});

	it("surfaces terminal reports as responses", () => {
		const responses = parse(
			"\x1b[?64;1;2;6;7;8;9;15;18;19;21c",
			"\x1b[>41;10;0c",
			"\x1b[0n",
			"\x1b[24;80R",
			"\x1bP0$r2$~\x1b\\",
			"\x1bP1$r\x1b\\",
			"\x1bP1!uA\x1b\\",
			"\x1b[?7;2$y",
			"\x1b[20;2$y",
			'\x1b[24;80;1;1;2"w',
		).map((event) => (event.type === "response" ? event.response : undefined));
		expect(responses).toEqual([
			{ kind: "da1", params: [64, 1, 2, 6, 7, 8, 9, 15, 18, 19, 21] },
			{ kind: "da2", params: [41, 10, 0] },
			{ kind: "status", ok: true },
			{ kind: "cpr", row: 24, col: 80 },
			{ kind: "setting", valid: true, data: "2$~" },
			{ kind: "setting", valid: false, data: "" },
			{ kind: "upss", supplemental: "latin1" },
			{ kind: "mode", mode: "?7", value: 2 },
			{ kind: "mode", mode: "20", value: 2 },
			{ kind: "extent", lines: 24, columns: 80, left: 1, top: 1, page: 2 },
		]);
	});

	it("keeps bracketed paste together", () => {
		expect(parse("\x1b[200~line one\r\nline two\x1b[201~x")).toEqual([
			{ type: "paste", text: "line one\nline two" },
			{ type: "text", text: "x" },
		]);
	});
});

describe("vt420 keymap", () => {
	it("normalizes aliases and modifier order", () => {
		expect(normalizeKey("Shift+Ctrl+Up")).toBe("ctrl+shift+up");
		expect(normalizeKey("PageUp")).toBe("prev");
		expect(normalizeKey("F16")).toBe("do");
		expect(normalizeKey("Delete")).toBe("remove");
	});

	it("binds the LK401 legends by default and accepts overrides", () => {
		const keymap = new Keymap();
		expect(keymap.matches("f6", "app.interrupt")).toBe(true);
		expect(keymap.matches("do", "app.followUp")).toBe(true);
		expect(keymap.matches("pf1", "app.thinking.cycle")).toBe(true);
		expect(keymap.label("app.help")).toBe("Help");
		const custom = new Keymap({ "app.interrupt": ["Ctrl+G"] });
		expect(custom.matches("ctrl+g", "app.interrupt")).toBe(true);
		expect(custom.matches("f6", "app.interrupt")).toBe(false);
		expect(keyLabel("ctrl+c")).toBe("Ctrl+C");
		expect(keyLabel("prev")).toBe("Prev Screen");
	});
});
