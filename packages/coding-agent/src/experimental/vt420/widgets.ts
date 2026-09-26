/**
 * Static screens and decorations: banner, help, character set showcase, session statistics and the
 * boxed selector list. Multi-row symbols are assembled from DEC Technical composite pieces.
 */

import {
	ATTR_BOLD,
	ATTR_REVERSE,
	ATTR_UNDERLINE,
	glyph,
	LINE_DOUBLE_BOTTOM,
	LINE_DOUBLE_TOP,
	LINE_DOUBLE_WIDTH,
	LINE_SINGLE,
	type Line,
	SET_GRAPHICS,
	SET_SUPPLEMENTAL,
	SET_TECHNICAL,
} from "./cells.ts";
import { type Charset, DEC_SUPPLEMENTAL, LATIN1_SUPPLEMENTAL, SPECIAL_GRAPHICS, TECH, TECHNICAL } from "./charset.ts";
import { type Keymap, keyLabel, type Vt420Action } from "./keys.ts";
import { padCells, spaces, truncateCells, wrapCells } from "./text.ts";

const tech = (code: number): number => glyph(SET_TECHNICAL, code);
const BLANK_CELL = 0x20;

/** A five-level sparkline from the scan-line glyphs: ⎽ lowest, ⎺ highest. */
export function sparkline(values: readonly number[], charset: Charset): number[] {
	const levels = ["⎽", "⎼", "─", "⎻", "⎺"];
	const max = Math.max(1, ...values);
	return values.map((value) => charset.cell(levels[Math.min(4, Math.round((value / max) * 4))]!));
}

/** A checkerboard gauge: ▒ for the filled part, · for the rest. */
export function gauge(fraction: number, width: number, charset: Charset, attrs = 0): number[] {
	const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
	return [...charset.cells("▒".repeat(filled), attrs), ...charset.cells("·".repeat(width - filled), attrs)];
}

/** Σ over three rows and two columns, or five rows and three columns. */
export function bigSigma(rows: 3 | 5): number[][] {
	if (rows === 3) {
		return [
			[tech(TECH.sigmaTopLeft), tech(TECH.sigmaTopRight)],
			[BLANK_CELL, tech(TECH.sigmaMiddle)],
			[tech(TECH.sigmaBottomLeft), tech(TECH.sigmaBottomRight)],
		];
	}
	return [
		[tech(TECH.sigmaTopLeft), tech(TECH.horizontal), tech(TECH.sigmaTopRight)],
		[BLANK_CELL, tech(TECH.sigmaTopDiagonal), BLANK_CELL],
		[BLANK_CELL, BLANK_CELL, tech(TECH.sigmaMiddle)],
		[BLANK_CELL, tech(TECH.sigmaBottomDiagonal), BLANK_CELL],
		[tech(TECH.sigmaBottomLeft), tech(TECH.horizontal), tech(TECH.sigmaBottomRight)],
	];
}

/** A tall piece built from top, connector and bottom glyphs, with an optional middle piece. */
function column(rows: number, top: number, bottom: number, middle?: number): number[] {
	const cells = [tech(top)];
	for (let row = 1; row < rows - 1; row++) {
		cells.push(tech(middle !== undefined && row === Math.floor((rows - 1) / 2) ? middle : TECH.vertical));
	}
	cells.push(tech(bottom));
	return cells;
}

export function bigIntegral(rows: number): number[] {
	return column(rows, TECH.integralTop, TECH.integralBottom);
}

export function bigBrace(rows: number, side: "left" | "right"): number[] {
	return side === "left"
		? column(rows, TECH.braceUpperLeft, TECH.braceLowerLeft, TECH.braceMiddleLeft)
		: column(rows, TECH.braceUpperRight, TECH.braceLowerRight, TECH.braceMiddleRight);
}

export function bigBracket(rows: number, side: "left" | "right"): number[] {
	return side === "left"
		? column(rows, TECH.bracketUpperLeft, TECH.bracketLowerLeft)
		: column(rows, TECH.bracketUpperRight, TECH.bracketLowerRight);
}

/** √ over two rows: the vinculum starts above the radical's foot. */
export function bigRadical(radicand: readonly number[]): number[][] {
	return [
		[tech(TECH.radicalTop), ...new Array(radicand.length + 1).fill(tech(TECH.horizontal))],
		[tech(TECH.radicalBottom), BLANK_CELL, ...radicand],
	];
}

export interface BannerInfo {
	version: string;
	terminal: string;
	model: string;
	cwd: string;
	keys: Keymap;
}

/** Double-height title followed by three lines held by a large brace. */
export function renderBanner(info: BannerInfo, charset: Charset, width: number): Line[] {
	const title = charset.cells(" π", ATTR_BOLD);
	const lines: Line[] = [
		{ cells: title, attr: LINE_DOUBLE_TOP },
		{ cells: title, attr: LINE_DOUBLE_BOTTOM },
	];
	const help = `${info.keys.label("app.help")} keys · /help commands · ${info.keys.label("app.exit")} exit`;
	const rows = [`${info.terminal} · pi ${info.version}`, `${info.model} · ${info.cwd}`, help];
	const brace = charset.options.technical ? bigBrace(3, "left") : charset.cells("/|\\");
	rows.forEach((text, index) => {
		const content = truncateCells(charset.cells(text), width - 4, charset.cells("…"));
		lines.push({ cells: [BLANK_CELL, brace[index]!, BLANK_CELL, ...content], attr: LINE_SINGLE });
	});
	return lines;
}

interface HelpEntry {
	action: Vt420Action;
	label: string;
}

const HELP_KEYS: HelpEntry[] = [
	{ action: "editor.submit", label: "send, steer while working" },
	{ action: "app.followUp", label: "queue a follow-up" },
	{ action: "editor.newline", label: "new line" },
	{ action: "app.interrupt", label: "interrupt, close" },
	{ action: "app.clear", label: "clear input, twice to exit" },
	{ action: "app.exit", label: "exit when input is empty" },
	{ action: "app.thinking.cycle", label: "thinking level" },
	{ action: "app.model.select", label: "select model" },
	{ action: "app.thinking.toggle", label: "show thinking" },
	{ action: "app.tools.expand", label: "expand tool output" },
	{ action: "app.scroll.pageUp", label: "page back" },
	{ action: "app.scroll.pageDown", label: "page forward" },
	{ action: "app.scroll.top", label: "top of transcript" },
	{ action: "app.scroll.bottom", label: "live view" },
	{ action: "app.resume", label: "resume a session" },
	{ action: "app.menu", label: "command menu" },
	{ action: "app.model.cycle", label: "next model" },
	{ action: "app.redraw", label: "redraw the screen" },
];

export interface CommandInfo {
	name: string;
	args?: string;
	description: string;
}

export function renderHelp(keys: Keymap, commands: readonly CommandInfo[], charset: Charset, width: number): Line[] {
	const lines: Line[] = [{ cells: charset.cells("Keys", ATTR_BOLD | ATTR_UNDERLINE), attr: LINE_DOUBLE_WIDTH }];
	const columns = width >= 100 ? 2 : 1;
	const cellWidth = Math.floor(width / columns);
	const entries = HELP_KEYS.map((entry) => {
		const labels = keys.keys(entry.action).slice(0, 2).map(keyLabel);
		return { keys: labels.join(" "), label: entry.label };
	});
	const keyWidth = Math.min(22, Math.max(...entries.map((entry) => entry.keys.length)) + 1);
	for (let index = 0; index < entries.length; index += columns) {
		const row: number[] = [];
		for (let column = 0; column < columns; column++) {
			const entry = entries[index + column];
			if (!entry) break;
			const text = [...charset.cells(entry.keys.padEnd(keyWidth), ATTR_BOLD), ...charset.cells(entry.label)];
			row.push(...padCells(truncateCells(text, cellWidth - 1, charset.cells("…")), cellWidth));
		}
		lines.push({ cells: row, attr: LINE_SINGLE });
	}
	lines.push({ cells: [], attr: LINE_SINGLE });
	lines.push({ cells: charset.cells("Commands", ATTR_BOLD | ATTR_UNDERLINE), attr: LINE_DOUBLE_WIDTH });
	for (const command of commands) {
		const name = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
		const text = [...charset.cells(name.padEnd(20), ATTR_BOLD), ...charset.cells(command.description)];
		lines.push(...wrapCells(text, width).map((cells): Line => ({ cells, attr: LINE_SINGLE })));
	}
	lines.push({ cells: [], attr: LINE_SINGLE });
	lines.push(
		...wrapCells(
			charset.cells("!cmd runs a shell command and adds its output to the context; !!cmd keeps it out."),
			width,
		).map((cells): Line => ({ cells, attr: LINE_SINGLE })),
	);
	return lines;
}

/** Every glyph of every designated set, plus composite symbols. A test pattern for the terminal's fonts. */
export function renderCharsetShowcase(charset: Charset, width: number): Line[] {
	const lines: Line[] = [];
	const title = (text: string): void => {
		lines.push({ cells: [], attr: LINE_SINGLE });
		lines.push({ cells: charset.cells(text, ATTR_BOLD | ATTR_UNDERLINE), attr: LINE_SINGLE });
	};
	const table = (set: number, codes: number[], label: (code: number) => string): void => {
		const perRow = Math.max(4, Math.floor(width / 5));
		for (let index = 0; index < codes.length; index += perRow) {
			const row: number[] = [];
			for (const code of codes.slice(index, index + perRow)) {
				row.push(...charset.cells(label(code).padStart(2)), BLANK_CELL, glyph(set, code), BLANK_CELL);
			}
			lines.push({ cells: row, attr: LINE_SINGLE });
		}
	};
	lines.push({ cells: charset.cells("VT420 character sets", ATTR_BOLD), attr: LINE_DOUBLE_WIDTH });
	title("G1 DEC Special Graphics (SO)");
	table(SET_GRAPHICS, [...SPECIAL_GRAPHICS.keys()], (code) => String.fromCharCode(code));
	if (charset.options.technical) {
		title("G2 DEC Technical (SS2 / LS2)");
		const codes: number[] = [];
		for (let code = 0x21; code <= 0x7e; code++)
			if (TECHNICAL.has(code) || (code >= 0x31 && code <= 0x37)) codes.push(code);
		table(SET_TECHNICAL, codes, (code) => String.fromCharCode(code));
	} else {
		title("G2 DEC Technical is not available on this terminal");
	}
	const latin = charset.options.supplemental === "latin1";
	title(latin ? "G3 ISO Latin-1 supplemental (SS3 / LS3)" : "G3 DEC Supplemental Graphic (SS3 / LS3)");
	const supplemental = [...(latin ? LATIN1_SUPPLEMENTAL : DEC_SUPPLEMENTAL).keys()].filter(
		(code) => charset.options.eightBit || (code > 0x20 && code < 0x7f),
	);
	table(SET_SUPPLEMENTAL, supplemental, (code) => (code + 0x80).toString(16).toUpperCase());
	title("Attributes and line sizes");
	lines.push({
		cells: [
			...charset.cells("normal "),
			...charset.cells("bold", ATTR_BOLD),
			BLANK_CELL,
			...charset.cells("underline", ATTR_UNDERLINE),
			BLANK_CELL,
			...charset.cells("reverse", ATTR_REVERSE),
		],
		attr: LINE_SINGLE,
	});
	lines.push({ cells: charset.cells("double width ◆"), attr: LINE_DOUBLE_WIDTH });
	const tall = charset.cells("double height π");
	lines.push({ cells: tall, attr: LINE_DOUBLE_TOP }, { cells: tall, attr: LINE_DOUBLE_BOTTOM });
	title("Scan lines, shading and control pictures");
	lines.push({
		cells: [
			...charset.cells("⎺⎻─⎼⎽ spark "),
			...sparkline([1, 3, 2, 5, 8, 6, 9, 4, 2, 1, 3, 7], charset),
			...charset.cells("  gauge "),
			...gauge(0.625, 8, charset),
			...charset.cells("  ␉␌␍␊␤␋"),
		],
		attr: LINE_SINGLE,
	});
	if (charset.options.technical) {
		title("Composite symbols");
		const sigma = bigSigma(5);
		const integral = bigIntegral(5);
		const left = bigBracket(5, "left");
		const right = bigBracket(5, "right");
		const braceLeft = bigBrace(5, "left");
		const braceRight = bigBrace(5, "right");
		const radical = bigRadical(charset.cells("x²+y²"));
		for (let row = 0; row < 5; row++) {
			const cells: number[] = [BLANK_CELL, ...sigma[row]!, ...spaces(3), integral[row]!, ...spaces(3)];
			cells.push(
				left[row]!,
				...spaces(5),
				right[row]!,
				...spaces(3),
				braceLeft[row]!,
				...spaces(5),
				braceRight[row]!,
			);
			cells.push(...spaces(3), ...(row === 1 ? radical[0]! : row === 2 ? radical[1]! : []));
			lines.push({ cells, attr: LINE_SINGLE });
		}
	}
	return lines;
}

export interface StatsInfo {
	sessionId: string;
	sessionFile?: string;
	messages: number;
	toolCalls: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	model: string;
	thinking?: string;
	tokensPerSecond?: number;
	contextTokens: number | null;
	contextWindow: number;
	perTurnOutput: number[];
}

/** "↑12k ↓1.2k R40k", or words where the terminal has no arrows. */
export function tokenCounts(
	charset: Charset,
	tokens: { input: number; output: number; cacheRead: number; cacheWrite?: number },
): string {
	const arrows = charset.has("↑") && charset.has("↓");
	const parts = [
		arrows ? `↑${formatTokens(tokens.input)}` : `in ${formatTokens(tokens.input)}`,
		arrows ? `↓${formatTokens(tokens.output)}` : `out ${formatTokens(tokens.output)}`,
	];
	if (tokens.cacheRead)
		parts.push(arrows ? `R${formatTokens(tokens.cacheRead)}` : `cache ${formatTokens(tokens.cacheRead)}`);
	if (tokens.cacheWrite)
		parts.push(arrows ? `W${formatTokens(tokens.cacheWrite)}` : `written ${formatTokens(tokens.cacheWrite)}`);
	return parts.join(" ");
}

/** "41.2", "7.3" or "112" tokens per second. */
export function formatRate(rate: number): string {
	return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Session totals beside a large Σ. */
export function renderStats(info: StatsInfo, charset: Charset, width: number): Line[] {
	const sigma = charset.options.technical
		? bigSigma(3)
		: [charset.cells("  "), charset.cells("  "), charset.cells("  ")];
	const speed = info.tokensPerSecond === undefined ? "" : ` · ${formatRate(info.tokensPerSecond)} tok/s`;
	const window = info.contextWindow > 0 ? formatTokens(info.contextWindow) : "?";
	const context =
		info.contextTokens === null
			? `context ?/${window}, known after the next reply`
			: `context ${formatTokens(info.contextTokens)}/${window} `;
	const rows: number[][] = [
		charset.cells(
			`tokens ${tokenCounts(charset, info.tokens)} · ${info.messages} messages · ${charset.pick("ƒ", "")}${info.toolCalls} tool calls`,
		),
		charset.cells(`${info.model}${info.thinking ? ` · thinking ${info.thinking}` : ""}${speed}`, ATTR_BOLD),
		[
			...charset.cells(context),
			...(info.contextTokens === null || info.contextWindow <= 0
				? []
				: gauge(info.contextTokens / info.contextWindow, 10, charset)),
		],
	];
	const lines: Line[] = rows.map((row, index) => ({
		cells: truncateCells([BLANK_CELL, ...sigma[index]!, BLANK_CELL, BLANK_CELL, ...row], width, charset.cells("…")),
		attr: LINE_SINGLE,
	}));
	if (info.perTurnOutput.length > 1) {
		const spark = sparkline(info.perTurnOutput.slice(-(width - 20)), charset);
		lines.push({ cells: [...charset.cells("  output/turn "), ...spark], attr: LINE_SINGLE });
	}
	lines.push({
		cells: truncateCells(charset.cells(`  session ${info.sessionFile ?? info.sessionId}`), width, charset.cells("…")),
		attr: LINE_SINGLE,
	});
	return lines;
}

export interface SelectorItem {
	value: string;
	label: string;
	detail?: string;
}

export interface SelectorView {
	title: string;
	items: readonly SelectorItem[];
	selected: number;
	top: number;
	hint: string;
}

/** A boxed list filling `height` rows; the selected row is marked with ◆ and bold. */
export function renderSelector(view: SelectorView, charset: Charset, width: number, height: number): Line[] {
	const inner = width - 2;
	const top = [...charset.cells("┌─ "), ...charset.cells(view.title, ATTR_BOLD), ...charset.cells(" ")];
	const lines: Line[] = [
		{ cells: [...padCells(top, width - 1, charset.cell("─")), charset.cell("┐")], attr: LINE_SINGLE },
	];
	const visible = Math.max(1, height - 2);
	for (let row = 0; row < visible; row++) {
		const index = view.top + row;
		const item = view.items[index];
		let content: number[] = [];
		if (item) {
			const selected = index === view.selected;
			const attrs = selected ? ATTR_BOLD : 0;
			const detail = item.detail ? charset.cells(item.detail) : [];
			const labelRoom = Math.max(
				4,
				inner - 3 - (detail.length > 0 ? Math.min(detail.length, Math.floor(inner / 2)) + 1 : 0),
			);
			const label = truncateCells(charset.cells(item.label, attrs), labelRoom, charset.cells("…", attrs));
			content = [...charset.cells(selected ? " ◆ " : "   ", attrs), ...label];
			if (detail.length > 0) {
				const room = inner - content.length - 1;
				const shown = truncateCells(detail, Math.max(0, room), charset.cells("…"));
				content = [...padCells(content, inner - shown.length), ...shown];
			}
			content = padCells(content, inner);
		} else if (row === 0 && view.items.length === 0) {
			content = charset.cells("   nothing matches");
		}
		lines.push({ cells: [charset.cell("│"), ...padCells(content, inner), charset.cell("│")], attr: LINE_SINGLE });
	}
	const bottom = [...charset.cells("└─ "), ...charset.cells(view.hint), ...charset.cells(" ")];
	lines.push({
		cells: [...padCells(truncateCells(bottom, width - 1, []), width - 1, charset.cell("─")), charset.cell("┘")],
		attr: LINE_SINGLE,
	});
	return lines;
}
