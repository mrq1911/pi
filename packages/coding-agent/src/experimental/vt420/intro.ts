/**
 * Start-up animation, after the DEC animations kept on vt100.net: xmas2 lets snow fall by reverse indexing a
 * scrolling region and grows a tree by pulling the region's bottom margin up one line at a time. Here digits
 * of π and DEC Technical symbols fall, and the logo builds up from the bottom the same way. A DECSCNM flash
 * marks the finished logo, a DECRARA band sweeps across it, and the tagline zooms in through line attributes.
 *
 * Steps are renderer frames, so the rain goes out as RI and the logo's bar as DECFRA; the flash and the sweep
 * are effects the renderer does not track, and each comes with its undo, so stopping halfway never leaves the
 * screen inverted. Every frame ends with a DA1 request, and a frame goes out only while at most one other is
 * still unanswered: the line's latency stays hidden, and a terminal that is still drawing (smooth scroll, a
 * slow line) is never more than a frame behind.
 */

import {
	ATTR_BOLD,
	ATTR_REVERSE,
	BLANK,
	LINE_DOUBLE_BOTTOM,
	LINE_DOUBLE_TOP,
	LINE_DOUBLE_WIDTH,
	LINE_SINGLE,
	type Line,
} from "./cells.ts";
import { Charset } from "./charset.ts";
import { type Frame, type Renderer, rendererFor } from "./renderer.ts";
import type { TerminalCapabilities, Vt420Terminal } from "./terminal.ts";
import { spaces } from "./text.ts";

/** One character per cell; the shadow goes below and to the right. */
const LOGO = [
	"  ██████████████████████████",
	" ██████████████████████████",
	"██    ███          ███",
	"      ███          ███",
	"      ███          ███",
	"     ███           ███",
	"    ███            ███   ██",
	"  ████              ██████",
];
const LOGO_WIDTH = Math.max(...LOGO.map((row) => row.length)) + 1;
const LOGO_HEIGHT = LOGO.length + 1;
/** The rain spells out π in order. */
const DIGITS = "3141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117067";
const SYMBOLS = ["∫", "∑", "√", "∞", "∂", "≈", "∇", "Δ", "Ω", "θ", "λ", "π"];
const TAGLINE = "coding agent";
/** Rain frames scroll and redraw, so they get time; shine steps are one DECRARA each and can be quick. */
const TICK_MS = 40;
const SHINE_MS = 14;
const SHINE_WIDTH = 3;
/** How long the finished picture stays up. */
const DWELL_MS = 1700;
/** Answered once the terminal has processed everything sent before it. */
const SYNC = "\x1b[c";
/** Frames sent but not yet answered, at most. */
const SYNC_WINDOW = 2;
/** How long to wait for an answer before going on without asking again. */
const SYNC_TIMEOUT_MS = 1000;

export interface IntroStep {
	frame: Frame;
	/** False sends the step without a DA1 request, for steps a terminal draws at once. */
	sync?: boolean;
	/** Sent after the frame: an effect the renderer does not track. */
	effect?: string;
	/** Puts back what the effects so far changed, when the intro stops at this step. */
	undo?: string;
	ms: number;
}

/** Lit cells are reverse-video spaces and the shadow is the DEC checkerboard. */
function logoRows(charset: Charset): number[][] {
	const rows = Array.from({ length: LOGO_HEIGHT }, () => new Array<number>(LOGO_WIDTH).fill(BLANK));
	const lit = (row: number, col: number): boolean => LOGO[row]?.[col] === "█";
	for (let row = 0; row < LOGO_HEIGHT; row++) {
		for (let col = 0; col < LOGO_WIDTH; col++) {
			if (lit(row, col)) rows[row]![col] = BLANK | ATTR_REVERSE;
			else if (lit(row - 1, col - 1)) rows[row]![col] = charset.cell("▒");
		}
	}
	return rows;
}

/** The intro for this terminal, or no steps when the screen is too small for it. */
export function introSteps(caps: TerminalCapabilities, charset: Charset, version: string, seed = 7): IntroStep[] {
	const { rows, columns } = caps;
	if (rows < 20 || columns < 64) return [];
	let state = seed;
	const random = (): number => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x80000000;
	};
	let digit = 0;
	const symbols = SYMBOLS.filter((symbol) => charset.has(symbol));

	const top = Math.max(1, Math.floor((rows - LOGO_HEIGHT - 5) / 2));
	const left = Math.floor((columns - LOGO_WIDTH) / 2);
	const titleRow = top + LOGO_HEIGHT + 1;
	const logo = logoRows(charset).map((cells): Line => ({ cells: [...spaces(left), ...cells], attr: LINE_SINGLE }));
	const rainFrom = Math.max(0, left - 6);
	const rainTo = Math.min(columns, left + LOGO_WIDTH + 6);
	const baud = caps.bytesPerSecond ? ` · ${caps.bytesPerSecond * 10} baud` : "";
	const described = `${caps.name} · ${columns}x${rows}${baud}`;
	const status = caps.statusLine ? rightAligned(charset.cells(described), columns) : undefined;
	const full = { top: 0, bottom: rows - 1 };
	const steps: IntroStep[] = [];
	const screen = (): Line[] => Array.from({ length: rows }, (): Line => ({ cells: [], attr: LINE_SINGLE }));

	const rainRow = (): number[] => {
		const cells = new Array<number>(columns).fill(BLANK);
		const count = 2 + Math.floor(random() * 4);
		const cols = Array.from({ length: count }, () => rainFrom + Math.floor(random() * (rainTo - rainFrom)));
		for (const col of cols.sort((a, b) => a - b)) {
			const symbol =
				symbols.length > 0 && random() < 0.2 ? symbols[Math.floor(random() * symbols.length)] : undefined;
			cells[col] = charset.cell(symbol ?? DIGITS[digit++ % DIGITS.length]!, random() < 0.3 ? ATTR_BOLD : 0);
		}
		return cells;
	};

	// rain falls into the region, already halfway down in the first frame; once it reaches the bottom, each
	// tick freezes the bottom line into the logo. New rain stops when the rows left to freeze are as many as
	// the rows above the logo, so the last of it lands as the logo completes
	const rain: number[][] = Array.from({ length: top + LOGO_HEIGHT }, () => []);
	const fallen = Math.floor((top + LOGO_HEIGHT) / 2);
	for (let row = fallen - 1; row >= 0; row--) rain[row] = rainRow();
	const reached = top + LOGO_HEIGHT - fallen;
	let bottom = top + LOGO_HEIGHT - 1;
	for (let tick = 0; tick < 400; tick++) {
		if (tick > reached && bottom >= top) bottom--;
		const draining = bottom < top;
		for (let row = bottom; row > 0; row--) rain[row] = rain[row - 1]!;
		rain[0] = tick > reached && bottom - top < top ? [] : rainRow();
		const lines = screen();
		for (let row = 0; row <= bottom; row++) lines[row] = { cells: rain[row]!, attr: LINE_SINGLE };
		for (let row = Math.max(bottom + 1, top); row < top + LOGO_HEIGHT; row++) lines[row] = logo[row - top]!;
		steps.push({ frame: { lines, status, scroll: { top: 0, bottom } }, ms: TICK_MS });
		if (draining && rain.slice(0, bottom + 1).every((cells) => cells.every((cell) => cell === BLANK))) break;
	}

	const picture = (title?: Line[]): Line[] => {
		const lines = screen();
		logo.forEach((line, index) => {
			lines[top + index] = line;
		});
		title?.forEach((line, index) => {
			lines[titleRow + index] = line;
		});
		return lines;
	};
	const still = (lines: Line[], ms: number, extra: Omit<IntroStep, "frame" | "ms"> = {}): void => {
		steps.push({ frame: { lines, status, scroll: full }, ms, ...extra });
	};

	// the flash inverts relative to the screen the user chose, so it is left out when the terminal did not say
	if (caps.screenReverse !== undefined) {
		const flip = caps.screenReverse ? "\x1b[?5l" : "\x1b[?5h";
		const back = caps.screenReverse ? "\x1b[?5h" : "\x1b[?5l";
		still(picture(), 60, { effect: flip, undo: back });
		still(picture(), 40, { effect: back });
	}

	// a band toggles reverse video as it sweeps across the logo; since toggling twice puts cells back, one
	// DECRARA per step covers both the band it leaves and the band it enters
	if (caps.rectangularOps) {
		const restore = `\x1b[${caps.attributeExtent ?? 0}*x`;
		const toggle = (from: number, to: number): string => `\x1b[${top + 1};${from + 1};${top + LOGO_HEIGHT};${to};7$t`;
		let previous: number | undefined;
		for (let col = left - SHINE_WIDTH; col < left + LOGO_WIDTH; col += SHINE_WIDTH) {
			const effect =
				previous === undefined ? `\x1b[2*x${toggle(col, col + SHINE_WIDTH)}` : toggle(previous, col + SHINE_WIDTH);
			still(picture(), SHINE_MS, { effect, undo: toggle(col, col + SHINE_WIDTH) + restore, sync: false });
			previous = col;
		}
		if (previous !== undefined) still(picture(), 30, { effect: toggle(previous, previous + SHINE_WIDTH) + restore });
	}

	const title = charset.cells(TAGLINE, ATTR_BOLD);
	const centered = (cells: number[], width: number): number[] => [
		...spaces(Math.floor((width - cells.length) / 2)),
		...cells,
	];
	const half = Math.floor(columns / 2);
	still(picture([{ cells: centered(title, columns), attr: LINE_SINGLE }]), 80);
	still(picture([{ cells: centered(title, half), attr: LINE_DOUBLE_WIDTH }]), 80);
	const release = charset.cells(`pi ${version}`);
	const zoomed: Line[] = [
		{ cells: centered(title, half), attr: LINE_DOUBLE_TOP },
		{ cells: centered(title, half), attr: LINE_DOUBLE_BOTTOM },
		{ cells: [], attr: LINE_SINGLE },
		{ cells: centered(release, columns), attr: LINE_SINGLE },
	];
	still(picture(zoomed), DWELL_MS);
	return steps;
}

function rightAligned(cells: number[], columns: number): number[] {
	return [...spaces(columns - 1 - cells.length), ...cells.slice(0, columns - 1), BLANK];
}

export interface IntroIo {
	readonly backlogMs: number;
	write(bytes: string): void;
}

/** Shows each step for its time, keeping the terminal no more than a frame behind. */
export class IntroPlayer {
	readonly done: Promise<void>;
	private readonly io: IntroIo;
	private readonly renderer: Renderer;
	private readonly steps: readonly IntroStep[];
	private sync: boolean;
	private index = -1;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private held = false;
	private unanswered = 0;
	private ended = false;
	private resolve: () => void = () => {};

	constructor(io: IntroIo, renderer: Renderer, steps: readonly IntroStep[], sync = true) {
		this.io = io;
		this.renderer = renderer;
		this.steps = steps;
		this.sync = sync;
		this.done = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	start(): void {
		this.advance();
	}

	/** Stop where it is; the app's first frame clears the screen anyway. */
	stop(): void {
		if (this.ended) return;
		this.io.write(this.steps[this.index]?.undo ?? "");
		this.end();
	}

	/** The terminal answered DA1. */
	answered(): void {
		if (this.ended || this.unanswered === 0) return;
		this.unanswered--;
		if (this.held && this.unanswered < SYNC_WINDOW) {
			clearTimeout(this.timer);
			this.advance();
		}
	}

	private advance(): void {
		const step = this.steps[++this.index];
		if (!step) {
			this.end();
			return;
		}
		const sync = this.sync && step.sync !== false;
		// counted before writing: a terminal can answer before write returns
		if (sync) this.unanswered++;
		this.held = false;
		this.io.write(this.renderer.render(step.frame) + (step.effect ?? "") + (sync ? SYNC : ""));
		this.timer = setTimeout(
			() => {
				this.held = true;
				if (this.unanswered < SYNC_WINDOW) this.advance();
				else this.timer = setTimeout(() => this.giveUpSync(), SYNC_TIMEOUT_MS);
			},
			Math.max(step.ms, this.io.backlogMs),
		);
	}

	private giveUpSync(): void {
		this.sync = false;
		this.unanswered = 0;
		this.advance();
	}

	private end(): void {
		clearTimeout(this.timer);
		this.ended = true;
		this.resolve();
	}
}

/**
 * Start the intro on the terminal unless it is too small, too slow or did not identify itself. The first key
 * stops it; input after that waits for the app.
 */
export function startIntro(terminal: Vt420Terminal, version: string): IntroPlayer | undefined {
	const caps = terminal.caps;
	if (caps.level < 2 || (caps.bytesPerSecond !== undefined && caps.bytesPerSecond < 960)) return undefined;
	const charset = new Charset({ technical: caps.technical, supplemental: caps.supplemental, eightBit: caps.eightBit });
	const steps = introSteps(caps, charset, version);
	if (steps.length === 0) return undefined;
	const player = new IntroPlayer(terminal, rendererFor(caps), steps);
	terminal.onInput((event) => {
		if (event.type !== "response") player.stop();
	});
	terminal.onResponse((response) => {
		if (response.kind === "da1") player.answered();
	});
	terminal.onResize(() => player.stop());
	void player.done.then(() => {
		terminal.releaseInput();
		terminal.onResponse(undefined);
	});
	player.start();
	return player;
}
