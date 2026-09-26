/**
 * Keyboard and report parser for a VT420 (and anything that speaks the same ANSI/DEC dialect).
 *
 * LK401 keys arrive as CSI n ~ (editing keypad, F6-F20, Help, Do), SS3 (PF1-PF4, keypad in application
 * mode), CSI A-D (arrows) or C0 controls. Terminal reports (DA, CPR, DECRPM, DECRPSS, DECAUPSS, DECRPDE)
 * share the same stream and are surfaced as responses. 8-bit C1 introducers are accepted as their 7-bit
 * equivalents, and GR bytes are decoded with the terminal's user-preferred supplemental set, or as UTF-8
 * when the terminal speaks it.
 */

import { decodeGR, type SupplementalSet } from "./charset.ts";

export type TerminalResponse =
	| { kind: "da1"; params: number[] }
	| { kind: "da2"; params: number[] }
	| { kind: "cpr"; row: number; col: number }
	| { kind: "mode"; mode: string; value: number }
	| { kind: "setting"; valid: boolean; data: string }
	| { kind: "upss"; supplemental: SupplementalSet }
	| { kind: "extent"; lines: number; columns: number; left: number; top: number; page: number };

export type InputEvent =
	| { type: "key"; key: string }
	| { type: "text"; text: string }
	| { type: "paste"; text: string }
	| { type: "response"; response: TerminalResponse };

export interface InputParserOptions {
	onEvent(event: InputEvent): void;
	/** How long a lone ESC waits for the rest of a sequence. */
	escapeTimeoutMs?: number;
	supplemental?: () => SupplementalSet;
	/** Decode bytes from 0x80 as UTF-8 instead of C1 controls and GR characters. */
	utf8?: () => boolean;
}

const TILDE_KEYS: Record<number, string> = {
	1: "find",
	2: "insert",
	3: "remove",
	4: "select",
	5: "prev",
	6: "next",
	7: "home",
	8: "end",
	11: "f1",
	12: "f2",
	13: "f3",
	14: "f4",
	15: "f5",
	17: "f6",
	18: "f7",
	19: "f8",
	20: "f9",
	21: "f10",
	23: "f11",
	24: "f12",
	25: "f13",
	26: "f14",
	28: "help",
	29: "do",
	31: "f17",
	32: "f18",
	33: "f19",
	34: "f20",
};

const FINAL_KEYS: Record<string, string> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
	E: "begin",
	P: "pf1",
	Q: "pf2",
	R: "pf3",
	S: "pf4",
	Z: "shift+tab",
};

const SS3_KEYS: Record<string, string> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
	P: "pf1",
	Q: "pf2",
	R: "pf3",
	S: "pf4",
	M: "kpenter",
	j: "kpmultiply",
	k: "kpplus",
	l: "kpcomma",
	m: "kpminus",
	n: "kpperiod",
	o: "kpdivide",
	p: "kp0",
	q: "kp1",
	r: "kp2",
	s: "kp3",
	t: "kp4",
	u: "kp5",
	v: "kp6",
	w: "kp7",
	x: "kp8",
	y: "kp9",
};

function controlKey(code: number): string {
	switch (code) {
		case 0x00:
			return "ctrl+space";
		case 0x08:
		case 0x7f:
			return "backspace";
		case 0x09:
			return "tab";
		case 0x0a:
			return "ctrl+j";
		case 0x0d:
			return "return";
		case 0x1c:
			return "ctrl+\\";
		case 0x1d:
			return "ctrl+]";
		case 0x1e:
			return "ctrl+^";
		case 0x1f:
			return "ctrl+_";
		default:
			return `ctrl+${String.fromCharCode(code + 0x60)}`;
	}
}

/** xterm-style modifier parameter: 1 + (shift 1 | alt 2 | ctrl 4 | meta 8). */
function withModifiers(key: string, parameter: number | undefined): string {
	if (!parameter || parameter < 2) return key;
	const bits = parameter - 1;
	let prefix = "";
	if (bits & 4) prefix += "ctrl+";
	if (bits & 2 || bits & 8) prefix += "alt+";
	if (bits & 1) prefix += "shift+";
	return prefix + key;
}

type State = "ground" | "escape" | "csi" | "ss3" | "string" | "stringEscape";

export class InputParser {
	private readonly options: InputParserOptions;
	private state: State = "ground";
	private sequence = "";
	private stringKind: "dcs" | "osc" | "ignore" = "ignore";
	private text = "";
	private paste: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private escapeTimeoutMs: number;
	private utf8Bytes: number[] = [];
	private utf8Needed = 0;

	constructor(options: InputParserOptions) {
		this.options = options;
		this.escapeTimeoutMs = options.escapeTimeoutMs ?? 50;
	}

	/** Slow lines need a longer wait between the bytes of one key's sequence. */
	setEscapeTimeout(ms: number): void {
		this.escapeTimeoutMs = ms;
	}

	feed(data: Uint8Array | string): void {
		this.clearTimer();
		const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
		for (const byte of bytes) this.byte(byte);
		this.flushText();
		if (this.state === "escape" && this.sequence === "") {
			this.timer = setTimeout(() => this.flush(), this.escapeTimeoutMs);
		} else if (this.state !== "ground") {
			// A sequence split across reads; give up on it if the rest never arrives.
			this.timer = setTimeout(() => this.reset(), 1000);
		}
	}

	/** Treat a pending lone ESC as the Escape key. */
	flush(): void {
		this.clearTimer();
		if (this.state === "escape" && this.sequence === "") {
			this.state = "ground";
			this.emit({ type: "key", key: "escape" });
		}
	}

	dispose(): void {
		this.clearTimer();
	}

	private reset(): void {
		this.state = "ground";
		this.sequence = "";
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private emit(event: InputEvent): void {
		if (event.type !== "text") this.flushText();
		this.options.onEvent(event);
	}

	private flushText(): void {
		if (!this.text) return;
		const text = this.text;
		this.text = "";
		this.options.onEvent({ type: "text", text });
	}

	private key(key: string): void {
		this.emit({ type: "key", key });
	}

	private byte(byte: number): void {
		switch (this.state) {
			case "ground":
				this.ground(byte);
				return;
			case "escape":
				this.escape(byte);
				return;
			case "csi":
				if (byte === 0x1b) {
					this.state = "escape";
					this.sequence = "";
					return;
				}
				if (byte < 0x20) return;
				this.sequence += String.fromCharCode(byte);
				if (byte >= 0x40 && byte <= 0x7e) {
					const sequence = this.sequence;
					this.reset();
					this.csi(sequence);
				}
				return;
			case "ss3":
				this.reset();
				this.ss3(String.fromCharCode(byte));
				return;
			case "string":
				if (byte === 0x1b) this.state = "stringEscape";
				else if (byte === 0x9c || (byte === 0x07 && this.stringKind === "osc")) this.finishString();
				else this.sequence += String.fromCharCode(byte);
				return;
			case "stringEscape":
				if (byte === 0x5c) this.finishString();
				else {
					this.state = "string";
					this.sequence += `\x1b${String.fromCharCode(byte)}`;
				}
				return;
		}
	}

	private ground(byte: number): void {
		if (this.paste !== undefined) {
			this.paste += String.fromCharCode(byte);
			if (this.paste.endsWith("\x1b[201~")) {
				const text = this.paste.slice(0, -6);
				this.paste = undefined;
				this.emit({ type: "paste", text: text.replace(/\r\n?/g, "\n") });
			}
			return;
		}
		if (this.utf8Needed > 0 && (byte & 0xc0) !== 0x80) {
			this.utf8Needed = 0;
			this.utf8Bytes = [];
		}
		if (byte >= 0x80 && this.options.utf8?.()) {
			this.utf8(byte);
			return;
		}
		if (byte === 0x1b) {
			this.state = "escape";
			this.sequence = "";
			return;
		}
		if (byte >= 0x80 && byte < 0xa0) {
			if (byte === 0x9b) {
				this.state = "csi";
				this.sequence = "";
			} else if (byte === 0x8f) this.state = "ss3";
			else if (byte === 0x90 || byte === 0x9d || byte === 0x98 || byte === 0x9e || byte === 0x9f) {
				this.state = "string";
				this.stringKind = byte === 0x90 ? "dcs" : byte === 0x9d ? "osc" : "ignore";
				this.sequence = "";
			}
			return;
		}
		if (byte < 0x20 || byte === 0x7f) {
			this.key(controlKey(byte));
			return;
		}
		if (byte >= 0xa0) {
			const char = decodeGR(byte, this.options.supplemental?.() ?? "dec");
			if (char) this.text += char;
			return;
		}
		this.text += String.fromCharCode(byte);
	}

	private utf8(byte: number): void {
		if (this.utf8Needed === 0) {
			const needed = byte >= 0xf0 && byte < 0xf5 ? 3 : byte >= 0xe0 ? 2 : byte >= 0xc2 && byte < 0xe0 ? 1 : 0;
			if (needed === 0 || byte >= 0xf5) return;
			this.utf8Bytes = [byte];
			this.utf8Needed = needed;
			return;
		}
		this.utf8Bytes.push(byte);
		if (--this.utf8Needed > 0) return;
		this.text += Buffer.from(this.utf8Bytes).toString("utf8");
		this.utf8Bytes = [];
	}

	private escape(byte: number): void {
		const char = String.fromCharCode(byte);
		if (this.sequence === "") {
			switch (char) {
				case "[":
					this.state = "csi";
					return;
				case "O":
					this.state = "ss3";
					return;
				case "P":
				case "]":
				case "X":
				case "^":
				case "_":
					this.state = "string";
					this.stringKind = char === "P" ? "dcs" : char === "]" ? "osc" : "ignore";
					return;
				case "\x1b":
					this.key("escape");
					return;
			}
		}
		if (byte >= 0x20 && byte <= 0x2f) {
			this.sequence += char;
			return;
		}
		const intermediates = this.sequence;
		this.reset();
		if (intermediates !== "") return;
		if (byte < 0x20) {
			this.key("escape");
			this.ground(byte);
		} else if (byte === 0x7f) {
			this.key("alt+backspace");
		} else {
			this.key(`alt+${char}`);
		}
	}

	private csi(sequence: string): void {
		const final = sequence.at(-1)!;
		let body = sequence.slice(0, -1);
		let prefix = "";
		if (/^[<=>?]/.test(body)) {
			prefix = body[0]!;
			body = body.slice(1);
		}
		const intermediates = /[ -/]*$/.exec(body)?.[0] ?? "";
		const paramText = body.slice(0, body.length - intermediates.length);
		const params = paramText === "" ? [] : paramText.split(";").map((part) => Number.parseInt(part, 10) || 0);

		if (prefix === "?" && final === "c") {
			this.respond({ kind: "da1", params });
			return;
		}
		if (prefix === ">" && final === "c") {
			this.respond({ kind: "da2", params });
			return;
		}
		if (intermediates === "$" && final === "y") {
			this.respond({ kind: "mode", mode: `${prefix}${params[0] ?? 0}`, value: params[1] ?? 0 });
			return;
		}
		if (intermediates === '"' && final === "w") {
			this.respond({
				kind: "extent",
				lines: params[0] ?? 0,
				columns: params[1] ?? 0,
				left: params[2] ?? 1,
				top: params[3] ?? 1,
				page: params[4] ?? 1,
			});
			return;
		}
		if (prefix === "" && intermediates === "" && final === "R" && params.length === 2 && (params[0] ?? 0) > 1) {
			this.respond({ kind: "cpr", row: params[0]!, col: params[1]! });
			return;
		}
		if (prefix !== "" || intermediates !== "") return;
		if (final === "~") {
			const code = params[0] ?? 0;
			if (code === 200) {
				this.paste = "";
				return;
			}
			const name = TILDE_KEYS[code];
			if (name) this.key(withModifiers(name, params[1]));
			return;
		}
		if (final === "R" && params.length === 2 && params[0] === 1) {
			this.key(withModifiers("f3", params[1]));
			return;
		}
		const name = FINAL_KEYS[final];
		if (name) this.key(withModifiers(name, params[1]));
	}

	private ss3(char: string): void {
		const name = SS3_KEYS[char];
		if (name) this.key(name);
	}

	private finishString(): void {
		const data = this.sequence;
		const kind = this.stringKind;
		this.reset();
		if (kind !== "dcs") return;
		const setting = /^(\d*)\$r([\s\S]*)$/.exec(data);
		if (setting) {
			const payload = setting[2] ?? "";
			this.respond({ kind: "setting", valid: payload.length > 0, data: payload });
			return;
		}
		const upss = /^\d*!u(.*)$/.exec(data);
		if (upss) {
			this.respond({ kind: "upss", supplemental: upss[1] === "A" ? "latin1" : "dec" });
			return;
		}
	}

	private respond(response: TerminalResponse): void {
		this.emit({ type: "response", response });
	}
}
