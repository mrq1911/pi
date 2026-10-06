/**
 * The terminal line: raw mode, capability probing, setup and exact restoration.
 *
 * Raw mode comes from stty so XON/XOFF flow control can stay on: the VT420 sends XOFF when its input
 * buffer fills, and the kernel must stop output instead of passing ^S to us. Node's setRawMode would
 * also force CS8 and break 7-bit parity lines.
 *
 * Probing sends one batch of reports and waits for the DA1 reply, which the terminal answers last. The
 * replies decide which VT420 features are safe to use and what to restore on exit. A terminal that decodes
 * UTF-8 (any modern emulator) gets the same glyphs as Unicode, because emulators rarely implement the DEC
 * Technical and Supplemental sets even when they claim them.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readlinkSync } from "node:fs";
import type { SupplementalSet } from "./charset.ts";
import { type InputEvent, InputParser, type TerminalResponse } from "./input.ts";
import { charsetDesignations, DEFAULT_DESIGNATIONS, SESSION_MODES, statusLineType } from "./sequences.ts";

export interface TerminalCapabilities {
	rows: number;
	columns: number;
	/** Operating level: 1 for VT100 mode, 4 for VT400 mode, 0 when the terminal did not answer. */
	level: number;
	/** A short description such as "VT420" for the banner. */
	name: string;
	technical: boolean;
	statusLine: boolean;
	rectangularOps: boolean;
	eraseCharacters: boolean;
	supplemental: SupplementalSet;
	eightBit: boolean;
	/** The terminal decodes UTF-8: glyphs go out as Unicode instead of through DEC character set shifts. */
	unicode: boolean;
	/** Output speed in bytes per second, when the line speed is known. */
	bytesPerSecond?: number;
	/** The terminal answers DSR 5 with its four-byte status report, the cheapest way to learn it has drawn a frame. */
	deviceStatus?: boolean;
	/** DECSCNM at startup, when the terminal reported it: true for a light screen. */
	screenReverse?: boolean;
	/** DECSCLM at startup, when the terminal reported it: true when it scrolls smoothly. */
	smoothScroll?: boolean;
	/** DECSACE at startup, for putting it back after rectangle attribute changes. */
	attributeExtent?: number;
	/** False when the terminal ignores double-width and double-height lines, as most emulators do. */
	doubleSize?: boolean;
}

export interface Vt420TerminalOptions {
	statusLine: "auto" | "on" | "off";
	/** Double-width and double-height lines: "auto" checks where the terminal puts the cursor on one. */
	doubleSize: "auto" | "on" | "off";
	/** "dec" forces DEC character sets, "utf8" forces Unicode output, "auto" asks the terminal. */
	encoding: "auto" | "dec" | "utf8";
	supplemental: "auto" | SupplementalSet;
	eightBit: boolean;
	columns?: 80 | 132;
	lines?: 24 | 36 | 48;
	flowControl: boolean;
	baud?: number;
	/** How long a lone ESC waits for the rest of a sequence; by default 50 ms on emulators, longer on DEC terminals. */
	escapeTimeoutMs?: number;
	probeTimeoutMs: number;
	logPath?: string;
}

/** Replies collected while probing. */
export interface ProbeResult {
	da1?: number[];
	da2?: number[];
	/** Valid DECRPSS data by request, e.g. "$~" -> "1". */
	settings: Map<string, string>;
	/** DECRPSS replies of any kind; only VT400-class terminals send them. */
	settingReplies: number;
	/** The terminal answered DSR 5. */
	status?: boolean;
	upss?: SupplementalSet;
	extent?: { lines: number; columns: number };
	cpr?: { row: number; col: number };
	/** Cursor column after printing é as two UTF-8 bytes on row 2: 2 in UTF-8 terminals, 3 in 8-bit ones. */
	utf8Column?: number;
	/** Cursor column after moving far right on a double-width line. */
	doubleWidthColumn?: number;
	modes: Map<string, number>;
}

/** Modes put back on exit; one without a fallback is only put back when the terminal reported it. */
const SAVED_MODES: ReadonlyArray<[mode: string, fallback: number | undefined]> = [
	["?7", 1],
	["?25", 1],
	["?1", 2],
	["?66", 2],
	["?6", 2],
	["20", 2],
	["12", 1],
	["4", 2],
	["?5", undefined],
	["?4", undefined],
	["?73", undefined],
];

/** DA2 terminal types. */
const TERMINAL_NAMES: Record<number, string> = {
	0: "VT100",
	1: "VT220",
	2: "VT240",
	18: "VT330",
	19: "VT340",
	24: "VT320",
	28: "DECterm",
	32: "VT382",
	41: "VT420",
	61: "VT510",
	64: "VT520",
	65: "VT525",
};

function stty(args: string[]): { ok: boolean; output: string } {
	try {
		const result = spawnSync("stty", args, { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" });
		return { ok: result.status === 0, output: (result.stdout ?? "").trim() };
	} catch {
		return { ok: false, output: "" };
	}
}

/**
 * Line speed from stty: a serial device's own, or the one sshd copied onto its pseudo-terminal from a client on a
 * serial line. Other pseudo-terminals keep the default 38400, which says nothing.
 */
function detectLineSpeed(): number | undefined {
	if (process.platform !== "linux") return undefined;
	let device: string;
	try {
		device = readlinkSync("/proc/self/fd/1");
	} catch {
		return undefined;
	}
	const serial = /^\/dev\/tty(S|USB|ACM|AMA|XRUSB|mxc|THS|O)\d+$/.test(device);
	if (!serial && process.env.SSH_TTY !== device) return undefined;
	const speed = Number(stty(["speed"]).output);
	if (!Number.isFinite(speed) || speed <= 0) return undefined;
	// 38400 is also every pseudo-terminal's default, so over ssh it counts only with a DEC terminal's own TERM
	return serial || speed !== 38400 || /^vt\d/.test(process.env.TERM ?? "") ? speed : undefined;
}

export function emptyProbe(): ProbeResult {
	return { settings: new Map(), settingReplies: 0, modes: new Map() };
}

const SETTING_REQUESTS = ["$~", "*x", "$|", "*|"];

/**
 * A DEC keyboard sends a lone ESC only for Ctrl-[, while the terminal's answers keep arriving; one split by a slow
 * or networked line must not turn into Escape and typed text.
 */
const DEC_ESCAPE_TIMEOUT_MS = 500;
const EMULATOR_ESCAPE_TIMEOUT_MS = 50;

/** Row of the UTF-8 test; row 1 would look like a modified F3 key report. */
const UTF8_PROBE_ROW = 2;
/** Made double width for a moment: a terminal that honours it keeps the cursor within half the screen. */
const DOUBLE_WIDTH_PROBE_ROW = 3;

/** Every report the probe asks for. DA1 goes last: terminals answer in order, so its reply ends the probe. */
export function probeQueries(): string {
	return [
		`\x1b7\x1b[${UTF8_PROBE_ROW}H\xc3\xa9\x1b[6n\x1b8`,
		`\x1b7\x1b[${DOUBLE_WIDTH_PROBE_ROW}H\x1b#6\x1b[${DOUBLE_WIDTH_PROBE_ROW};999H\x1b[6n\x1b#5\x1b8`,
		...SETTING_REQUESTS.map((request) => `\x1bP$q${request}\x1b\\`),
		"\x1b[&u",
		'\x1b["v',
		...SAVED_MODES.map(([mode]) => `\x1b[${mode}$p`),
		"\x1b7\x1b[999;999H\x1b[6n\x1b8",
		"\x1b[5n",
		"\x1b[>c",
		"\x1b[c",
	].join("");
}

export function recordResponse(probe: ProbeResult, response: TerminalResponse): void {
	switch (response.kind) {
		case "da1":
			probe.da1 = response.params;
			break;
		case "da2":
			probe.da2 = response.params;
			break;
		case "status":
			probe.status = true;
			break;
		case "setting": {
			probe.settingReplies++;
			const request = SETTING_REQUESTS.find((suffix) => response.data.endsWith(suffix));
			if (response.valid && request) probe.settings.set(request, response.data.slice(0, -request.length));
			break;
		}
		case "upss":
			probe.upss = response.supplemental;
			break;
		case "extent":
			if (response.lines > 0 && response.columns > 0) {
				probe.extent = { lines: response.lines, columns: response.columns };
			}
			break;
		case "cpr":
			// The UTF-8 and double-width tests are sent before the size probe, so their reports come first.
			if (probe.utf8Column === undefined && response.row === UTF8_PROBE_ROW) probe.utf8Column = response.col;
			else if (probe.doubleWidthColumn === undefined && response.row === DOUBLE_WIDTH_PROBE_ROW) {
				probe.doubleWidthColumn = response.col;
			} else probe.cpr = { row: response.row, col: response.col };
			break;
		case "mode":
			probe.modes.set(response.mode, response.value);
			break;
	}
}

/** What the replies say is safe to use. `fallback` is the tty size for terminals that report nothing. */
export function capabilitiesFromProbe(
	probe: ProbeResult,
	options: Pick<
		Vt420TerminalOptions,
		"statusLine" | "doubleSize" | "encoding" | "supplemental" | "eightBit" | "columns" | "lines"
	>,
	fallback: { rows?: number; columns?: number },
	baud: number | undefined,
): TerminalCapabilities {
	const da1 = probe.da1;
	const vt400 = probe.settingReplies > 0 || (da1 !== undefined && (da1[0] ?? 0) >= 64);
	const unicode = options.encoding === "utf8" || (options.encoding === "auto" && probe.utf8Column === 2);
	const reported = !da1 ? 0 : (da1[0] ?? 0) >= 62 ? (vt400 ? 4 : (da1[0] ?? 62) - 60) : 1;
	// an emulator does what a VT220 does at least, whatever it answers; xterm.js says VT100, zellij VT220
	const level = unicode && da1 ? Math.max(reported, 2) : reported;
	const id = probe.da2?.[0];
	const screenReverse = reportedMode(probe, "?5");
	const smoothScroll = reportedMode(probe, "?4");
	const columns =
		options.columns ??
		probe.extent?.columns ??
		(Number(probe.settings.get("$|")) || undefined) ??
		probe.cpr?.col ??
		fallback.columns ??
		80;
	const doubleWidth = probe.doubleWidthColumn === undefined || probe.doubleWidthColumn <= Math.ceil(columns / 2);
	return {
		rows:
			options.lines ??
			probe.extent?.lines ??
			(Number(probe.settings.get("*|")) || undefined) ??
			probe.cpr?.row ??
			fallback.rows ??
			24,
		columns,
		level,
		name: unicode
			? emulatorName()
			: id !== undefined && TERMINAL_NAMES[id]
				? TERMINAL_NAMES[id]
				: level >= 4
					? "VT400-class terminal"
					: "terminal",
		technical: unicode || (da1 ? da1.includes(15) : true),
		statusLine: options.statusLine === "on" || (options.statusLine === "auto" && probe.settings.has("$~")),
		rectangularOps: probe.settings.has("*x"),
		eraseCharacters: level === 0 || level >= 2,
		supplemental: unicode ? "latin1" : options.supplemental === "auto" ? (probe.upss ?? "dec") : options.supplemental,
		eightBit: !unicode && options.eightBit,
		unicode,
		...(baud ? { bytesPerSecond: baud / 10 } : {}),
		...(probe.status ? { deviceStatus: true } : {}),
		...(screenReverse === undefined ? {} : { screenReverse }),
		...(smoothScroll === undefined ? {} : { smoothScroll }),
		doubleSize: options.doubleSize === "on" || (options.doubleSize === "auto" && doubleWidth),
		...(probe.settings.has("*x") ? { attributeExtent: Number(probe.settings.get("*x")) || 0 } : {}),
	};
}

/**
 * The terminal vt420-term draws on, when pi runs inside it: VT420_TERM, or LC_VT420_TERM, which ssh passes on where
 * VT420_TERM would be dropped.
 */
export function behindVt420(): string | undefined {
	return process.env.VT420_TERM || process.env.LC_VT420_TERM || undefined;
}

/**
 * Emulators claim a DEC type in DA2 (zellij and xterm.js a VT100, kitty a VT220), so the name comes from vt420-term,
 * which says what is at the end of the line, and is plain "terminal" otherwise.
 */
function emulatorName(): string {
	const behind = behindVt420();
	return behind ? `${behind} via vt420-term` : "terminal";
}

/** A mode's setting from DECRPM, undefined when the terminal did not know the mode. */
function reportedMode(probe: ProbeResult, mode: string): boolean | undefined {
	const value = probe.modes.get(mode);
	return value === 1 || value === 3 ? true : value === 2 || value === 4 ? false : undefined;
}

/** Put back what the session changed, using the values the terminal reported at startup. */
export function restoreSequence(
	probe: ProbeResult,
	caps: Pick<TerminalCapabilities, "statusLine">,
	options: Pick<Vt420TerminalOptions, "columns" | "lines">,
): string {
	const parts = ["\x1b[m\x1b[r"];
	if (caps.statusLine) {
		const original = Number(probe.settings.get("$~") ?? 1);
		parts.push("\x1b[1$}\x1b[2K\x1b[0$}", statusLineType(Number.isInteger(original) ? original : 1));
	}
	parts.push(DEFAULT_DESIGNATIONS);
	for (const [mode, fallback] of SAVED_MODES) {
		const reported = reportedMode(probe, mode);
		const value = reported === undefined ? fallback : reported ? 1 : 2;
		if (value === undefined) continue;
		if (mode === "?66") parts.push(value === 1 ? "\x1b=" : "\x1b>");
		else parts.push(`\x1b[${mode}${value === 1 ? "h" : "l"}`);
	}
	if (probe.settings.has("*x")) parts.push(`\x1b[${Number(probe.settings.get("*x")) || 0}*x`);
	const columns = Number(probe.settings.get("$|"));
	if (options.columns && columns) parts.push(`\x1b[${columns}$|`);
	const lines = Number(probe.settings.get("*|"));
	if (options.lines && lines) parts.push(`\x1b[${lines}*|`);
	parts.push("\x1b[H\x1b[2J");
	return parts.join("");
}

export class Vt420Terminal {
	readonly caps: TerminalCapabilities;
	private readonly options: Vt420TerminalOptions;
	private readonly parser: InputParser;
	private readonly rawWrite: (chunk: Uint8Array) => boolean;
	private readonly originalStdoutWrite: typeof process.stdout.write;
	private readonly originalStderrWrite: typeof process.stderr.write;
	private listener: ((event: InputEvent) => void) | undefined;
	private responseHandler: ((response: TerminalResponse) => void) | undefined;
	private readonly queued: InputEvent[] = [];
	private savedStty: string | undefined;
	private usedSetRawMode = false;
	private probe: ProbeResult = emptyProbe();
	private closed = false;
	private busyUntil = 0;
	private readonly dataHandler = (chunk: Buffer): void => this.parser.feed(chunk);
	private readonly exitHandler = (): void => this.close();
	private resizeHandler: (() => void) | undefined;

	private constructor(options: Vt420TerminalOptions) {
		this.options = options;
		this.rawWrite = process.stdout.write.bind(process.stdout) as (chunk: Uint8Array) => boolean;
		this.originalStdoutWrite = process.stdout.write;
		this.originalStderrWrite = process.stderr.write;
		this.parser = new InputParser({
			escapeTimeoutMs: options.escapeTimeoutMs ?? DEC_ESCAPE_TIMEOUT_MS,
			supplemental: () => this.caps.supplemental,
			utf8: () => this.caps.unicode,
			onEvent: (event) => this.dispatch(event),
		});
		this.caps = {
			rows: 24,
			columns: 80,
			level: 0,
			name: "terminal",
			technical: true,
			statusLine: false,
			rectangularOps: false,
			eraseCharacters: true,
			supplemental: "dec",
			eightBit: options.eightBit,
			unicode: false,
		};
	}

	static async open(options: Vt420TerminalOptions): Promise<Vt420Terminal> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("pi for VT420 needs a terminal on stdin and stdout");
		}
		const terminal = new Vt420Terminal(options);
		terminal.enterRawMode();
		terminal.guardOutput();
		process.stdin.on("data", terminal.dataHandler);
		process.stdin.resume();
		process.on("exit", terminal.exitHandler);
		try {
			await terminal.runProbe();
			terminal.applyProbe();
			terminal.setup();
		} catch (error) {
			terminal.close();
			throw error;
		}
		return terminal;
	}

	/** Receive keys, text and pastes. Input that arrived during startup is delivered first. */
	onInput(listener: (event: InputEvent) => void): void {
		this.listener = listener;
		for (const event of this.queued.splice(0)) listener(event);
	}

	/** Queue input until the next listener. */
	releaseInput(): void {
		this.listener = undefined;
	}

	/** Terminal reports after the start-up probe; without a handler they are dropped. */
	onResponse(handler: ((response: TerminalResponse) => void) | undefined): void {
		this.responseHandler = handler;
	}

	onResize(handler: () => void): void {
		this.resizeHandler = handler;
		process.stdout.on("resize", this.handleResize);
	}

	write(bytes: string): void {
		if (this.closed || bytes.length === 0) return;
		this.rawWrite(Buffer.from(bytes, this.caps.unicode ? "utf8" : "latin1"));
		if (this.caps.bytesPerSecond) {
			this.busyUntil = Math.max(this.busyUntil, Date.now()) + (bytes.length * 1000) / this.caps.bytesPerSecond;
		}
		if (this.options.logPath) {
			try {
				appendFileSync(this.options.logPath, Buffer.from(bytes, this.caps.unicode ? "utf8" : "latin1"));
			} catch {
				// logging is best effort
			}
		}
	}

	/** Resend modes and designations, e.g. after the terminal was reset from Set-Up. */
	reinitialize(): void {
		this.setup();
	}

	/** Milliseconds until the line has sent what was written, at the known line speed. */
	get backlogMs(): number {
		return Math.max(0, this.busyUntil - Date.now());
	}

	close(): void {
		if (this.closed) return;
		this.write(restoreSequence(this.probe, this.caps, this.options));
		this.closed = true;
		this.parser.dispose();
		process.stdin.off("data", this.dataHandler);
		process.stdout.off("resize", this.handleResize);
		process.off("exit", this.exitHandler);
		process.stdin.pause();
		process.stdout.write = this.originalStdoutWrite;
		process.stderr.write = this.originalStderrWrite;
		if (this.savedStty) stty([this.savedStty]);
		else if (this.usedSetRawMode) process.stdin.setRawMode?.(false);
	}

	private readonly handleResize = (): void => {
		if (!process.stdout.rows || !process.stdout.columns) return;
		this.caps.rows = process.stdout.rows;
		this.caps.columns = process.stdout.columns;
		this.resizeHandler?.();
	};

	private dispatch(event: InputEvent): void {
		if (event.type === "response") {
			this.responseHandler?.(event.response);
			return;
		}
		if (this.listener) this.listener(event);
		else this.queued.push(event);
	}

	private enterRawMode(): void {
		const saved = stty(["-g"]);
		const flow = this.options.flowControl ? ["ixon", "-ixany"] : ["-ixon"];
		if (saved.ok && saved.output && stty(["raw", "-echo", ...flow]).ok) {
			this.savedStty = saved.output;
			return;
		}
		process.stdin.setRawMode?.(true);
		this.usedSetRawMode = true;
	}

	/** Anything else printing to stdout or stderr would corrupt the screen; keep it in the log instead. */
	private guardOutput(): void {
		const capture = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean => {
			if (this.options.logPath) {
				try {
					appendFileSync(this.options.logPath, typeof chunk === "string" ? chunk : Buffer.from(chunk));
				} catch {
					// logging is best effort
				}
			}
			const done = typeof encoding === "function" ? encoding : callback;
			if (typeof done === "function") queueMicrotask(() => (done as () => void)());
			return true;
		}) as typeof process.stdout.write;
		process.stdout.write = capture;
		process.stderr.write = capture as typeof process.stderr.write;
	}

	private async runProbe(): Promise<void> {
		const answered = new Promise<void>((resolve) => {
			this.responseHandler = (response) => {
				recordResponse(this.probe, response);
				if (response.kind === "da1") resolve();
			};
		});
		this.write(probeQueries());
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			answered,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, this.options.probeTimeoutMs);
			}),
		]);
		clearTimeout(timer);
		// Late DECRPSS replies can trail DA1 on some emulators.
		await new Promise((resolve) => setTimeout(resolve, 30));
		this.responseHandler = undefined;
	}

	private applyProbe(): void {
		const options = this.options;
		const baud = options.baud ?? detectLineSpeed();
		Object.assign(
			this.caps,
			capabilitiesFromProbe(
				this.probe,
				options,
				{ rows: process.stdout.rows || undefined, columns: process.stdout.columns || undefined },
				baud,
			),
		);
		const lone = options.escapeTimeoutMs ?? (this.caps.unicode ? EMULATOR_ESCAPE_TIMEOUT_MS : DEC_ESCAPE_TIMEOUT_MS);
		this.parser.setEscapeTimeout(Math.max(lone, this.caps.bytesPerSecond ? 4000 / this.caps.bytesPerSecond : 0));
	}

	private setup(): void {
		const { caps, options } = this;
		this.write(
			[
				SESSION_MODES,
				"\x1b[?1l\x1b>",
				// Set-Up's limited transmit holds every answer to 150 characters a second, and pacing waits on them
				reportedMode(this.probe, "?73") ? "\x1b[?73l" : "",
				options.columns ? `\x1b[${options.columns}$|` : "",
				options.lines ? `\x1b[${options.lines}*|` : "",
				charsetDesignations({
					technical: caps.technical,
					supplemental: caps.supplemental,
					eightBit: caps.eightBit,
				}),
				caps.statusLine ? statusLineType(2) : "",
				"\x1b[m\x1b[H\x1b[2J",
			].join(""),
		);
	}
}
