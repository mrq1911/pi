/**
 * Transcript blocks and their VT420 rendering.
 *
 * Every block renders to lines of cells for a given width and caches the result until its content, the
 * width or a display toggle changes. Running blocks re-render per spinner tick; finished blocks never do.
 *
 * Glyphs: user turns are boxed in line drawing and led by π; thinking is ∴; tools are ↑ read, ← write, Δ edit,
 * $ bash, ∼ grep, ∇ find, ├ ls and ƒ for everything else; √ and × close a tool; a bouncing scan line
 * (⎺⎻─⎼⎽) marks work in progress.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ATTR_BOLD, BLANK, isSpace, LINE_SINGLE, type Line } from "@mrq/vt420/cells.js";
import type { Charset } from "@mrq/vt420/charset.js";
import { expandTabs, hardWrap, padCells, spaces, stripAnsi, truncateCells, wrapCells } from "@mrq/vt420/text.js";
import { parseSkillBlock } from "../../core/agent-session.ts";
import { formatDuration, formatSpan } from "./format.ts";
import { renderMarkdown } from "./markdown.ts";
import { formatTokens } from "./widgets.ts";

/** A running tool's heartbeat: a dot that swells to a diamond, and a rest. */
const HEARTBEAT = ["·", "◆", "·", " ", " "];

export interface RenderContext {
	width: number;
	charset: Charset;
	cwd: string;
	home: string;
	showThinking: boolean;
	expandTools: boolean;
	largeHeadings: boolean;
	tick: number;
	now: number;
	/** Display label for the key bound to an action, e.g. "PF4". */
	key(action: "app.tools.expand" | "app.thinking.toggle"): string;
}

export interface ToolState {
	name: string;
	args: Record<string, unknown>;
	status: "pending" | "running" | "done" | "error";
	output: string;
	details?: unknown;
	startedAt?: number;
	durationMs?: number;
}

export interface BashState {
	command: string;
	output: string;
	running: boolean;
	exitCode?: number;
	cancelled: boolean;
	excluded: boolean;
	startedAt: number;
	durationMs?: number;
}

export type ThinkingTimes = Map<number, { since: number; until?: number }>;

export type BlockContent =
	| { kind: "user"; text: string }
	| { kind: "assistant"; message: AssistantMessage; streaming: boolean; thinkingTimes?: ThinkingTimes }
	| { kind: "tool"; tool: ToolState }
	| { kind: "bash"; bash: BashState }
	| { kind: "notice"; level: "info" | "warning" | "error"; text: string }
	| { kind: "summary"; title: string; text: string }
	| { kind: "lines"; render: (context: RenderContext) => Line[] };

export class TranscriptBlock {
	readonly id: number;
	content: BlockContent;
	private version = 0;
	private cacheKey = "";
	private cached: Line[] = [];

	constructor(id: number, content: BlockContent) {
		this.id = id;
		this.content = content;
	}

	/** Mark the content as changed after mutating it. */
	touch(): void {
		this.version++;
	}

	get animated(): boolean {
		const content = this.content;
		if (content.kind === "tool") return content.tool.status === "pending" || content.tool.status === "running";
		if (content.kind === "bash") return content.bash.running;
		return false;
	}

	render(context: RenderContext): Line[] {
		const key = `${this.version}|${context.width}|${context.showThinking}|${context.expandTools}|${this.animated ? context.tick : ""}`;
		if (key === this.cacheKey) return this.cached;
		this.cached = renderBlock(this.content, context);
		this.cacheKey = key;
		return this.cached;
	}
}

export class Transcript {
	blocks: TranscriptBlock[] = [];
	private nextId = 1;

	add(content: BlockContent): TranscriptBlock {
		const block = new TranscriptBlock(this.nextId++, content);
		this.blocks.push(block);
		return block;
	}

	remove(block: TranscriptBlock): void {
		this.blocks = this.blocks.filter((candidate) => candidate !== block);
	}

	clear(): void {
		this.blocks = [];
	}

	get animated(): boolean {
		return this.blocks.some((block) => block.animated);
	}

	/**
	 * All transcript lines, with one blank line between turns. Tool blocks attach to the turn above them, and a
	 * boxed message's edges take the place of the blank lines around it.
	 */
	lines(context: RenderContext): Line[] {
		const out: Line[] = [];
		let previous: BlockContent["kind"] | undefined;
		let edged = false;
		for (const block of this.blocks) {
			const lines = block.render(context);
			if (lines.length === 0) continue;
			const kind = block.content.kind;
			const boxed = isBoxed(block.content);
			const attached = kind === "tool" && (previous === "tool" || previous === "assistant");
			if (out.length > 0 && !attached && !boxed && !edged) out.push({ cells: [], attr: LINE_SINGLE });
			for (const line of lines) out.push(line);
			previous = kind;
			edged = boxed;
		}
		return out;
	}
}

/** A user message is boxed unless it only invokes a skill. */
function isBoxed(content: BlockContent): boolean {
	if (content.kind !== "user") return false;
	const skill = parseSkillBlock(content.text);
	return !skill || Boolean(skill.userMessage);
}

function renderBlock(content: BlockContent, context: RenderContext): Line[] {
	switch (content.kind) {
		case "user":
			return renderUser(content.text, context);
		case "assistant":
			return renderAssistant(content.message, content.streaming, content.thinkingTimes, context);
		case "tool":
			return renderTool(content.tool, context);
		case "bash":
			return renderBash(content.bash, context);
		case "notice":
			return renderNotice(content.level, content.text, context);
		case "summary":
			return renderSummary(content.title, content.text, context);
		case "lines":
			return content.render(context);
	}
}

function renderUser(text: string, context: RenderContext): Line[] {
	const { charset, width } = context;
	const skill = parseSkillBlock(text);
	if (skill && !skill.userMessage) return renderNotice("info", `skill ${skill.name}`, context);
	const inner = Math.max(4, width - 4);
	const rows: number[][] = skill ? [charset.cells(`· skill ${skill.name}`)] : [];
	const wrapped: number[][] = [];
	for (const source of expandTabs(skill?.userMessage ?? text).split("\n")) {
		wrapped.push(...wrapCells(charset.cells(source), inner - 2));
	}
	wrapped.forEach((row, index) => {
		rows.push([...(index === 0 ? [charset.cell("π", ATTR_BOLD), BLANK] : spaces(2)), ...row]);
	});
	const edge = (left: string, right: string): Line => ({
		cells: [charset.cell(left), ...new Array<number>(inner + 2).fill(charset.cell("─")), charset.cell(right)],
		attr: LINE_SINGLE,
	});
	const side = charset.cell("│");
	return [
		edge("┌", "┐"),
		...rows.map((row): Line => ({ cells: [side, BLANK, ...padCells(row, inner), BLANK, side], attr: LINE_SINGLE })),
		edge("└", "┘"),
	];
}

function renderAssistant(
	message: AssistantMessage,
	streaming: boolean,
	thinkingTimes: ThinkingTimes | undefined,
	context: RenderContext,
): Line[] {
	const { charset, width } = context;
	const out: Line[] = [];
	for (const [index, content] of message.content.entries()) {
		if (content.type === "thinking") {
			const thinking = content.thinking.trim();
			const live = streaming && index === message.content.length - 1;
			if (!context.showThinking) {
				if (!live) out.push(thoughtLine(message, index, thinkingTimes, context));
				else out.push(...thinkingWindow(thinking, `${message.timestamp}:${index}`, context));
				continue;
			}
			const lines = expandTabs(thinking || "thinking")
				.split("\n")
				.map((line) => charset.cells(line));
			for (let at = lines.length - 1, left = live && thinking ? GLOW_WORDS : 0; at >= 0 && left > 0; at--) {
				const glowing = glowLastWords(lines[at]!, left);
				lines[at] = glowing.cells;
				left -= glowing.words;
			}
			const rows = lines.flatMap((cells) => wrapCells(cells, width - 2));
			for (const [index, row] of rows.entries()) {
				out.push({
					cells: [...charset.cells(index === 0 ? `${charset.pick("∴", "»")} ` : "  "), ...row],
					attr: LINE_SINGLE,
				});
			}
		} else if (content.type === "text" && content.text.trim() !== "") {
			if (out.length > 0) out.push({ cells: [], attr: LINE_SINGLE });
			out.push(...renderMarkdown(content.text.trim(), { width, charset, largeHeadings: context.largeHeadings }));
		}
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		const text =
			message.stopReason === "aborted" ? (message.errorMessage ?? "Aborted") : (message.errorMessage ?? "Error");
		out.push(...renderNotice("error", text, context));
	}
	return out;
}

function thoughtLine(
	message: AssistantMessage,
	index: number,
	thinkingTimes: ThinkingTimes | undefined,
	context: RenderContext,
): Line {
	const { charset } = context;
	const time = thinkingTimes?.get(index);
	let took = "";
	if (time?.until !== undefined) took = ` for ${formatSpan((time.until - time.since) / 1000)}`;
	else {
		const tokens = thinkingTokens(message, index);
		const about = tokens?.estimated ? charset.pick("≃", "~") : "";
		if (tokens) took = ` for ${about}${formatTokens(tokens.count)} token${tokens.count === 1 ? "" : "s"}`;
	}
	return { cells: charset.cells(`${charset.pick("∴", "»")} Thought${took}`), attr: LINE_SINGLE };
}

function thinkingTokens(message: AssistantMessage, index: number): { count: number; estimated: boolean } | undefined {
	// the provider's count covers the whole reply, so it only fits one with a single thinking block
	const reasoning = message.usage?.reasoning;
	if (reasoning && message.content.filter((content) => content.type === "thinking").length === 1)
		return { count: reasoning, estimated: false };
	const content = message.content[index];
	const chars = content?.type === "thinking" ? content.thinking.trim().length : 0;
	return chars > 0 ? { count: Math.ceil(chars / 4), estimated: true } : undefined;
}

/**
 * Live thinking on two rows, the lower one filling as tokens arrive; once it is full the pair moves on a line,
 * which the renderer turns into a smooth scroll of the two rows. Wrapped from the start, so lines keep their breaks,
 * and every line has a hole in both margins, like continuous-form paper, which feeds up with it.
 */
function thinkingWindow(thinking: string, id: string, context: RenderContext): Line[] {
	const { charset, width } = context;
	const hole = charset.pick("°", "o");
	const text = glowLastWords(charset.cells(flattenThinking(thinking)), GLOW_WORDS).cells;
	const room = Math.max(1, width - 4);
	const lines = text.length === 0 ? [charset.cells("thinking")] : wrapCells(text, room);
	const first = Math.max(0, lines.length - 2);
	return [first, first + 1].map((line) => ({
		cells: [...charset.cells(`${hole} `), ...padCells(lines[line] ?? [], room), ...charset.cells(` ${hole}`)],
		attr: LINE_SINGLE,
		roll: { id, line },
	}));
}

const GLOW_WORDS = 3;

function glowLastWords(cells: number[], count: number): { cells: number[]; words: number } {
	let end = cells.length;
	while (end > 0 && isSpace(cells[end - 1]!)) end--;
	let start = end;
	let words = 0;
	while (words < count && start > 0) {
		while (start > 0 && !isSpace(cells[start - 1]!)) start--;
		words++;
		let gap = start;
		while (gap > 0 && isSpace(cells[gap - 1]!)) gap--;
		if (words === count || gap === 0) break;
		start = gap;
	}
	return { cells: cells.map((cell, at) => (at >= start && at < end ? cell | ATTR_BOLD : cell)), words };
}

/** Thinking as one run of text: bold markers dropped, lines joined, paragraphs separated by a dot. */
function flattenThinking(text: string): string {
	return text
		.replace(/\*\*/g, "")
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
		.filter((paragraph) => paragraph !== "")
		.join(" · ");
}

const TOOL_GLYPHS: Record<string, string> = {
	read: "↑",
	write: "←",
	edit: "Δ",
	bash: "$",
	grep: "∼",
	find: "∇",
	ls: "├",
};

function renderTool(tool: ToolState, context: RenderContext): Line[] {
	const { charset } = context;
	const glyph = TOOL_GLYPHS[tool.name] ?? "ƒ";
	// Without the glyph, name the tool; unknown tools already start with their name.
	const marker = charset.has(glyph) ? `${glyph} ` : TOOL_GLYPHS[tool.name] ? `${tool.name} ` : "";
	const running = tool.status === "pending" || tool.status === "running";
	const status = running
		? spinnerStatus(context, tool.startedAt)
		: tool.status === "error"
			? finishedStatus(failMark(charset), "", tool.durationMs)
			: finishedStatus(okMark(charset), doneLabel(tool), tool.durationMs);
	const lines: Line[] = context.expandTools
		? [
				...fullHeader(marker, callText(tool, context), status, context),
				...(tool.name in TOOL_GLYPHS ? [] : argumentRows(tool.args, context)),
			]
		: [header(`${marker}${toolSummary(tool, context)}`, status, context)];
	const body = toolBody(tool, context);
	// expanded or not alike while it runs; it keeps to its latest lines meanwhile
	lines.push(
		...gutter(
			body,
			context.expandTools ? 400 : 5,
			running ? "tail" : tool.name === "edit" ? "head" : "tail",
			context,
		),
	);
	return lines;
}

function renderBash(bash: BashState, context: RenderContext): Line[] {
	const { charset } = context;
	const status = bash.running
		? spinnerStatus(context, bash.startedAt)
		: bash.cancelled
			? finishedStatus(failMark(charset), "cancelled", bash.durationMs)
			: bash.exitCode !== undefined && bash.exitCode !== 0
				? finishedStatus(failMark(charset), `exit ${bash.exitCode}`, bash.durationMs)
				: finishedStatus(okMark(charset), "", bash.durationMs);
	const prompt = bash.excluded ? "!! " : "! ";
	const lines: Line[] = context.expandTools
		? fullHeader(prompt, bash.command.trim(), status, context)
		: [header(`${prompt}${oneLine(bash.command)}`, status, context)];
	const limit = context.expandTools ? 400 : 5;
	lines.push(...gutter(outputLines(bash.output, context.charset), limit, "tail", context));
	return lines;
}

function renderNotice(level: "info" | "warning" | "error", text: string, context: RenderContext): Line[] {
	const { charset, width } = context;
	const marker = level === "error" ? `${failMark(charset)} ` : level === "warning" ? "! " : "· ";
	const attrs = level === "info" ? 0 : ATTR_BOLD;
	const rows = stripAnsi(expandTabs(text))
		.split("\n")
		.flatMap((line) => wrapCells(charset.cells(line, attrs), width - 2));
	return rows.map((row, index) => ({
		cells: [...charset.cells(index === 0 ? marker : "  "), ...row],
		attr: LINE_SINGLE,
	}));
}

function renderSummary(title: string, text: string, context: RenderContext): Line[] {
	const { charset, width } = context;
	const lines: Line[] = [
		{ cells: truncateCells(charset.cells(`≡ ${title}`, ATTR_BOLD), width, charset.cells("…")), attr: LINE_SINGLE },
	];
	if (context.expandTools && text.trim()) {
		lines.push(...renderMarkdown(text.trim(), { width, charset, largeHeadings: false }));
	} else if (text.trim()) {
		lines.push({ cells: charset.cells(`  ${context.key("app.tools.expand")} shows the summary`), attr: LINE_SINGLE });
	}
	return lines;
}

function okMark(charset: Charset): string {
	return charset.pick("√", "ok");
}

function failMark(charset: Charset): string {
	return charset.pick("×", "x");
}

function finishedStatus(mark: string, label: string, durationMs: number | undefined): string {
	const took = durationMs !== undefined && durationMs >= 1000 ? formatDuration(durationMs / 1000) : "";
	return [[label, took].filter(Boolean).join(" · "), mark].filter(Boolean).join(" ");
}

function spinnerStatus(context: RenderContext, startedAt: number | undefined): string {
	const frame = HEARTBEAT[context.tick % HEARTBEAT.length]!;
	const seconds = startedAt === undefined ? 0 : Math.floor((context.now - startedAt) / 1000);
	return seconds >= 2 ? `${formatDuration(seconds)} ${frame}` : frame;
}

/** A tool header with its status right-aligned. */
function header(summary: string, status: string, context: RenderContext): Line {
	const { charset, width } = context;
	const statusCells = charset.cells(status);
	const room = Math.max(4, width - statusCells.length - 1);
	const left = truncateCells(charset.cells(summary), room, charset.cells("…"));
	return { cells: [...padCells(left, width - statusCells.length), ...statusCells], attr: LINE_SINGLE };
}

function fullHeader(prefix: string, text: string, status: string, context: RenderContext): Line[] {
	const { charset, width } = context;
	const statusCells = charset.cells(status);
	const lead = charset.cells(prefix);
	const room = Math.max(4, width - statusCells.length - 1 - lead.length);
	const full = Math.max(4, width - lead.length);
	const [first = "", ...rest] = expandTabs(text).split("\n");
	const rows = [
		...wrapHanging(charset.cells(first), room, full),
		...rest.flatMap((line) => wrapCells(charset.cells(line), full)),
	];
	return rows.map(
		(row, index): Line => ({
			cells:
				index === 0
					? [...padCells([...lead, ...row], width - statusCells.length), ...statusCells]
					: [...spaces(lead.length), ...row],
			attr: LINE_SINGLE,
		}),
	);
}

function argumentRows(args: Record<string, unknown>, context: RenderContext): Line[] {
	const { charset, width } = context;
	const rows: number[][] = [];
	for (const [name, value] of Object.entries(args ?? {})) {
		const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
		const lines = expandTabs(text).split("\n");
		if (lines.length === 1) {
			const wrapped = wrapHanging(charset.cells(`${name}: ${lines[0]}`), width - 2, width - 4);
			rows.push(...wrapped.map((row, index) => [...spaces(index === 0 ? 2 : 4), ...row]));
			continue;
		}
		rows.push([...spaces(2), ...charset.cells(`${name}:`)]);
		for (const line of lines)
			rows.push(...wrapCells(charset.cells(line), width - 4).map((row) => [...spaces(4), ...row]));
	}
	return rows.map((cells) => ({ cells, attr: LINE_SINGLE }));
}

function wrapHanging(cells: number[], first: number, rest: number): number[][] {
	const head = wrapCells(cells, first)[0] ?? [];
	let at = head.length;
	while (at < cells.length && isSpace(cells[at]!)) at++;
	return at < cells.length ? [head, ...wrapCells(cells.slice(at), rest)] : [head];
}

interface BodyLine {
	cells: number[];
}

function gutter(body: BodyLine[], limit: number, keep: "head" | "tail", context: RenderContext): Line[] {
	if (body.length === 0) return [];
	const { charset } = context;
	const hidden = Math.max(0, body.length - limit);
	const shown = hidden === 0 ? body : keep === "tail" ? body.slice(-limit) : body.slice(0, limit);
	const lines: Line[] = [];
	if (hidden > 0 && keep === "tail") {
		lines.push({
			cells: charset.cells(
				`  ┌ ${hidden} earlier line${hidden === 1 ? "" : "s"} · ${context.key("app.tools.expand")}`,
			),
			attr: LINE_SINGLE,
		});
	}
	shown.forEach((line, index) => {
		const last = index === shown.length - 1 && !(hidden > 0 && keep === "head");
		lines.push({ cells: [...charset.cells(last ? "  └ " : "  │ "), ...line.cells], attr: LINE_SINGLE });
	});
	if (hidden > 0 && keep === "head") {
		lines.push({
			cells: charset.cells(`  └ ${hidden} more line${hidden === 1 ? "" : "s"} · ${context.key("app.tools.expand")}`),
			attr: LINE_SINGLE,
		});
	}
	return lines;
}

function toolBody(tool: ToolState, context: RenderContext): BodyLine[] {
	const width = context.width - 4;
	const { charset } = context;
	const wrap = (text: string): BodyLine[] =>
		outputLines(text, charset).flatMap((line) => hardWrap(line.cells, width).map((cells) => ({ cells })));
	if (tool.status === "error") return wrap(tool.output).slice(-5);
	switch (tool.name) {
		case "edit": {
			const diff = diffText(tool.details);
			if (!diff) return [];
			return diff.split("\n").flatMap((line) => {
				const attrs = line.startsWith("+") ? ATTR_BOLD : 0;
				return hardWrap(outputCells(line, charset, attrs), width).map((cells) => ({ cells }));
			});
		}
		case "read":
		case "write": {
			if (!context.expandTools) return [];
			const text = tool.name === "write" ? stringArg(tool.args, "content") : tool.output;
			return wrap(text ?? "");
		}
		default:
			return wrap(tool.output);
	}
}

/** Tool output as lines: escape sequences removed, tabs expanded, stray controls shown as DEC control pictures. */
function outputLines(text: string, charset: Charset): BodyLine[] {
	const lines = expandTabs(stripAnsi(text)).replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines.map((line) => ({ cells: outputCells(line, charset) }));
}

function outputCells(line: string, charset: Charset, attrs = 0): number[] {
	const visible = line.replace(/[\r\f\v]/g, (control) => (control === "\r" ? "␍" : control === "\f" ? "␌" : "␋"));
	return charset.cells(visible, attrs);
}

function toolSummary(tool: ToolState, context: RenderContext): string {
	const summary = toolArguments(tool.name, tool.args, context);
	return tool.name in TOOL_GLYPHS ? summary : `${tool.name} ${summary}`.trim();
}

function callText(tool: ToolState, context: RenderContext): string {
	const { name, args } = tool;
	const limit = numberArg(args, "limit");
	switch (name) {
		case "bash": {
			const timeout = numberArg(args, "timeout");
			return `${(stringArg(args, "command") ?? "").trim()}${options([timeout !== undefined && `timeout ${timeout}s`])}`;
		}
		case "grep": {
			const glob = stringArg(args, "glob");
			const lines = numberArg(args, "context");
			return `${toolArguments(name, args, context)}${options([
				glob && `glob ${glob}`,
				args?.ignoreCase === true && "ignore case",
				args?.literal === true && "literal",
				lines !== undefined && `context ${lines}`,
				limit !== undefined && `limit ${limit}`,
			])}`;
		}
		case "find":
		case "ls":
			return `${toolArguments(name, args, context)}${options([limit !== undefined && `limit ${limit}`])}`;
		default:
			return name in TOOL_GLYPHS ? toolArguments(name, args, context) : name;
	}
}

function options(parts: Array<string | false | undefined>): string {
	const shown = parts.filter((part) => typeof part === "string" && part !== "");
	return shown.length > 0 ? ` (${shown.join(", ")})` : "";
}

export function toolArguments(
	name: string,
	args: Record<string, unknown>,
	context: Pick<RenderContext, "cwd" | "home">,
): string {
	const path = (): string => shortenPath(stringArg(args, "path") ?? stringArg(args, "file_path") ?? "", context);
	switch (name) {
		case "bash":
			return oneLine(stringArg(args, "command") ?? "");
		case "read": {
			const offset = numberArg(args, "offset");
			const limit = numberArg(args, "limit");
			const range =
				offset !== undefined || limit !== undefined
					? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
					: "";
			return `${path()}${range}`;
		}
		case "write":
		case "edit":
			return path();
		case "grep":
		case "find": {
			const pattern = stringArg(args, "pattern") ?? "";
			const where = stringArg(args, "path");
			return where ? `${pattern} in ${shortenPath(where, context)}` : pattern;
		}
		case "ls":
			return shortenPath(stringArg(args, "path") ?? ".", context);
		default: {
			const json = JSON.stringify(args ?? {});
			return json === "{}" ? "" : json;
		}
	}
}

function doneLabel(tool: ToolState): string {
	switch (tool.name) {
		case "edit": {
			const diff = diffText(tool.details);
			if (!diff) return "";
			const lines = diff.split("\n");
			const added = lines.filter((line) => line.startsWith("+")).length;
			const removed = lines.filter((line) => line.startsWith("-")).length;
			return `+${added} -${removed}`;
		}
		case "read": {
			const count = lineCount(tool.output);
			return count === 0 ? "" : `${count} line${count === 1 ? "" : "s"}`;
		}
		case "write": {
			const count = lineCount(stringArg(tool.args, "content") ?? "");
			return count === 0 ? "" : `+${count}`;
		}
		default:
			return "";
	}
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function diffText(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const diff = (details as { diff?: unknown }).diff;
	return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
	const value = args?.[name];
	return typeof value === "string" ? value : undefined;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
	const value = args?.[name];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oneLine(command: string): string {
	return command
		.replace(/\\\r?\n/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function shortenPath(path: string, context: Pick<RenderContext, "cwd" | "home">): string {
	if (!path) return path;
	if (path === context.cwd) return ".";
	if (path.startsWith(`${context.cwd}/`)) return path.slice(context.cwd.length + 1);
	return tildePath(path, context.home);
}

export function tildePath(path: string, home: string): string {
	if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
	return path;
}
