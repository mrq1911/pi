/**
 * The VT420 frontend: binds an AgentSession runtime to the transcript, the editor and the screen.
 *
 * Layout, top to bottom: the transcript inside the DECSTBM scrolling region, one separator row that
 * doubles as the status line for work in progress, the editor, and the footer. The footer lives on the
 * host-writable status line when the terminal has one, otherwise on the last row.
 */

import { homedir } from "node:os";
import { basename } from "node:path";
import type { AssistantMessage, AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { ATTR_BOLD, LINE_DOUBLE_BOTTOM, LINE_DOUBLE_TOP, LINE_SINGLE, type Line } from "./cells.ts";
import { Charset } from "./charset.ts";
import { LineEditor } from "./editor.ts";
import type { InputEvent, TerminalResponse } from "./input.ts";
import type { Keymap, Vt420Action } from "./keys.ts";
import { type Frame, type Renderer, rendererFor } from "./renderer.ts";
import { isSaverMode, SAVER_MINUTES, SAVER_MOVE_MS, type SaverMode, saverFrame, saverPlace } from "./saver.ts";
import { SpeedMeter } from "./speed.ts";
import type { TerminalCapabilities } from "./terminal.ts";
import { formatDuration, padCells, spaces, truncateCells } from "./text.ts";
import {
	type BashState,
	type RenderContext,
	SPINNER,
	type ToolState,
	Transcript,
	type TranscriptBlock,
	tildePath,
} from "./transcript.ts";
import {
	type CommandInfo,
	formatRate,
	formatTokens,
	gauge,
	renderBanner,
	renderCharsetShowcase,
	renderHelp,
	renderSelector,
	renderStats,
	type SelectorItem,
	tokenCounts,
} from "./widgets.ts";

/** The part of AgentSessionRuntime the frontend uses. */
export interface Vt420Runtime {
	readonly session: AgentSession;
	readonly cwd: string;
	newSession(): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	setRebindSession(rebind?: (session: AgentSession) => Promise<void>): void;
}

/** The terminal as the frontend sees it. */
export interface Vt420Io {
	readonly caps: TerminalCapabilities;
	readonly backlogMs: number;
	write(bytes: string): void;
	onInput(listener: (event: InputEvent) => void): void;
	onResize(handler: () => void): void;
	/** Terminal reports after startup, which pace the frames. */
	onResponse?(handler: ((response: TerminalResponse) => void) | undefined): void;
	/** Resend terminal setup, for a redraw after the terminal was reset. */
	reinitialize?(): void;
}

export interface Vt420AppOptions {
	runtime: Vt420Runtime;
	io: Vt420Io;
	keymap: Keymap;
	version: string;
	sessionDir?: string;
	largeHeadings?: boolean;
	/** A Return followed by more input within this window is a pasted newline, not a submit. */
	pasteWindowMs?: number;
	animationFps?: number;
	/** Screen saver after a spell without keys; "auto" is "progress" on a DEC terminal and "off" on emulators. */
	screensaver?: SaverMode | "auto";
	screensaverMinutes?: number;
	saverMoveMs?: number;
	/** Keep settings changed by a command, such as /screensaver. */
	saveSettings?(settings: { screensaver: SaverMode; screensaverMinutes: number }): void;
}

/** Longest working directory the footer shows; longer ones shrink to their last component. */
const FOOTER_DIRECTORY_WIDTH = 24;

/** Frames sent but not yet answered, at most: the terminal is never more than a frame behind. */
const SYNC_WINDOW = 2;
/** Line speed assumed for how long an answer may take when the real one is unknown: 9600 baud. */
const SYNC_BYTES_PER_SECOND = 960;

export const COMMANDS: readonly CommandInfo[] = [
	{ name: "help", description: "keys and commands" },
	{ name: "model", args: "[name]", description: "select or switch the model" },
	{ name: "thinking", args: "[level]", description: "set or cycle the thinking level" },
	{ name: "new", description: "start a new session" },
	{ name: "resume", description: "resume an earlier session" },
	{ name: "compact", args: "[focus]", description: "summarize the context" },
	{ name: "session", description: "tokens, speed and context" },
	{ name: "name", args: "<name>", description: "name this session" },
	{ name: "login", args: "[provider]", description: "sign in to a provider" },
	{ name: "logout", args: "<provider>", description: "remove stored credentials" },
	{ name: "export", args: "[path]", description: "write the session as HTML" },
	{ name: "reload", description: "reload skills, prompts and context files" },
	{ name: "charset", description: "show every VT420 glyph" },
	{ name: "redraw", description: "repaint the screen" },
	{ name: "screensaver", args: "[off|blank|progress] [min]", description: "dark screen now, or set when" },
	{ name: "quit", description: "exit" },
];

type Mode =
	| { kind: "normal" }
	| { kind: "help"; lines: Line[]; top: number }
	| {
			kind: "selector";
			title: string;
			items: SelectorItem[];
			filtered: SelectorItem[];
			selected: number;
			top: number;
			filter: LineEditor;
			onSelect(item: SelectorItem): void;
			onCancel?(): void;
	  }
	| {
			kind: "prompt";
			message: string;
			editor: LineEditor;
			resolve(value: string): void;
			reject(error: Error): void;
	  };

const EDITOR_ACTIONS: readonly Vt420Action[] = [
	"editor.newline",
	"editor.left",
	"editor.right",
	"editor.up",
	"editor.down",
	"editor.wordLeft",
	"editor.wordRight",
	"editor.lineStart",
	"editor.lineEnd",
	"editor.backspace",
	"editor.delete",
	"editor.deleteWordBackward",
	"editor.deleteWordForward",
	"editor.deleteToLineStart",
	"editor.deleteToLineEnd",
	"editor.yank",
	"editor.complete",
];

interface FooterStats {
	input: number;
	output: number;
	cacheRead: number;
	contextTokens: number | null;
	contextWindow: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string }) =>
			part.type === "text" ? (part.text ?? "") : part.type === "image" ? "[image]" : "",
		)
		.join("");
}

export class Vt420App {
	private readonly options: Vt420AppOptions;
	private readonly runtime: Vt420Runtime;
	private readonly io: Vt420Io;
	private readonly keymap: Keymap;
	private charset: Charset;
	private renderer: Renderer;
	private readonly transcript = new Transcript();
	private readonly editor = new LineEditor();
	private mode: Mode = { kind: "normal" };
	private follow = true;
	private scrollTop = 0;
	private regionHeight = 1;
	private transcriptLength = 0;
	private showThinking = false;
	private expandTools = false;
	private tick = 0;
	private working = false;
	private workingSince = 0;
	private bashRunning = false;
	private retry: { attempt: number; max: number; until: number } | undefined;
	private compacting: string | undefined;
	private queued = 0;
	private flashText: { text: string; until: number } | undefined;
	private footer: FooterStats = { input: 0, output: 0, cacheRead: 0, contextTokens: null, contextWindow: 0 };
	private readonly speed = new SpeedMeter();
	private readonly tools = new Map<string, TranscriptBlock>();
	private streaming: TranscriptBlock | undefined;
	private unsubscribe: (() => void) | undefined;
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private animationTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingReturn: ReturnType<typeof setTimeout> | undefined;
	/** Ends each frame: DSR 5, whose answer is four bytes, or DA1 where DSR goes unanswered. */
	private syncRequest: { bytes: string; answer: TerminalResponse["kind"] } | undefined;
	/** Bytes of each frame the terminal has not answered yet. */
	private unanswered: number[] = [];
	private syncTimer: ReturnType<typeof setTimeout> | undefined;
	private framePending = false;
	private lastFrameAt = 0;
	private saver: SaverMode;
	private saverMinutes: number;
	private saverTimer: ReturnType<typeof setTimeout> | undefined;
	private saverMoveTimer: ReturnType<typeof setInterval> | undefined;
	/** The screen saver showing, and which; the next key only wakes the screen. */
	private saving: SaverMode | undefined;
	private saverPlace = { row: 0, col: 0 };
	private workedUntil = 0;
	private lastClearAt = 0;
	private loginController: AbortController | undefined;
	private closed = false;
	private exitResolve: (() => void) | undefined;

	constructor(options: Vt420AppOptions) {
		this.options = options;
		this.runtime = options.runtime;
		this.io = options.io;
		this.keymap = options.keymap;
		const caps = options.io.caps;
		this.charset = new Charset({
			technical: caps.technical,
			supplemental: caps.supplemental,
			eightBit: caps.eightBit,
		});
		this.renderer = this.createRenderer();
		const saver = options.screensaver ?? "auto";
		this.saver = saver === "auto" ? (caps.unicode ? "off" : "progress") : saver;
		this.saverMinutes = options.screensaverMinutes ?? SAVER_MINUTES;
	}

	/** Run until the user exits. */
	async run(initial: { prompt?: string; resume?: boolean; notices?: string[] } = {}): Promise<void> {
		const exited = new Promise<void>((resolve) => {
			this.exitResolve = resolve;
		});
		this.runtime.setRebindSession(async () => {
			await this.bindSession();
		});
		await this.bindSession();
		for (const notice of initial.notices ?? []) this.notice("warning", notice);
		this.io.onInput((event) => this.handleInput(event));
		const caps = this.io.caps;
		if (this.io.onResponse && (caps.deviceStatus || caps.level > 0)) {
			const sync = caps.deviceStatus
				? { bytes: "\x1b[5n", answer: "status" as const }
				: { bytes: "\x1b[c", answer: "da1" as const };
			this.syncRequest = sync;
			this.io.onResponse((response) => {
				if (response.kind === sync.answer) this.answered();
			});
		}
		this.io.onResize(() => {
			this.renderer.resize(this.io.caps.rows, this.io.caps.columns);
			this.requestRender();
		});
		this.renderNow();
		this.armSaver();
		if (initial.resume) void this.showSessions();
		if (initial.prompt) {
			this.editor.setText(initial.prompt);
			this.submit("steer");
		}
		await exited;
		this.closed = true;
		this.unsubscribe?.();
		this.runtime.setRebindSession(undefined);
		this.loginController?.abort();
		this.io.onResponse?.(undefined);
		for (const timer of [
			this.renderTimer,
			this.animationTimer,
			this.pendingReturn,
			this.syncTimer,
			this.saverTimer,
		]) {
			if (timer) clearTimeout(timer);
		}
		clearInterval(this.saverMoveTimer);
	}

	/** Request exit; `run()` resolves afterwards. */
	exit(): void {
		this.exitResolve?.();
	}

	private createRenderer(): Renderer {
		return rendererFor(this.io.caps);
	}

	private get session(): AgentSession {
		return this.runtime.session;
	}

	/** The selected model; the agent core holds an "unknown" placeholder when there is none. */
	private get model(): AgentSession["model"] {
		const model = this.session.model;
		return model && model.api !== "unknown" ? model : undefined;
	}

	// ---------------------------------------------------------------------------------------------
	// Session binding and events

	private async bindSession(): Promise<void> {
		this.unsubscribe?.();
		const session = this.session;
		await session.bindExtensions({ mode: "print", onError: (error) => this.notice("error", error.error) });
		this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
		this.working = session.isStreaming;
		this.rebuildTranscript();
		this.refreshFooter();
		this.requestRender();
	}

	private rebuildTranscript(): void {
		this.transcript.clear();
		this.tools.clear();
		this.streaming = undefined;
		const session = this.session;
		const current = this.model;
		const model = current ? `${current.provider}/${current.id}` : "no model";
		const caps = this.io.caps;
		const terminal = `${caps.name} ${caps.columns}x${caps.rows}${caps.statusLine ? " + status line" : ""}${caps.smoothScroll ? " · smooth scroll" : ""}${caps.unicode ? " · UTF-8" : ""}`;
		this.transcript.add({
			kind: "lines",
			render: (context) =>
				renderBanner(
					{
						version: this.options.version,
						terminal,
						model,
						cwd: tildePath(this.runtime.cwd, homedir()),
						keys: this.keymap,
					},
					context.charset,
					context.width,
				),
		});
		for (const message of session.messages) {
			switch (message.role) {
				case "user": {
					const text = messageText(message.content);
					if (text.trim()) this.transcript.add({ kind: "user", text });
					break;
				}
				case "assistant":
					this.transcript.add({ kind: "assistant", message, streaming: false });
					for (const content of message.content) {
						if (content.type !== "toolCall") continue;
						const failed = message.stopReason === "aborted" || message.stopReason === "error";
						this.addTool(content.id, content.name, content.arguments, failed ? "error" : "pending");
					}
					break;
				case "toolResult": {
					const block = this.tools.get(message.toolCallId);
					if (block && block.content.kind === "tool") {
						const tool = block.content.tool;
						tool.output = messageText(message.content);
						tool.details = message.details;
						tool.status = message.isError ? "error" : "done";
						block.touch();
						this.tools.delete(message.toolCallId);
					}
					break;
				}
				case "bashExecution":
					this.transcript.add({
						kind: "bash",
						bash: {
							command: message.command,
							output: message.output,
							running: false,
							exitCode: message.exitCode,
							cancelled: message.cancelled,
							excluded: message.excludeFromContext ?? false,
							startedAt: message.timestamp,
						},
					});
					break;
				case "compactionSummary":
					this.transcript.add({
						kind: "summary",
						title: `Earlier context compacted (${formatTokens(message.tokensBefore)} tokens)`,
						text: message.summary,
					});
					break;
				case "branchSummary":
					this.transcript.add({ kind: "summary", title: "Summary of an abandoned branch", text: message.summary });
					break;
				case "custom":
					if (message.display) this.notice("info", messageText(message.content));
					break;
			}
		}
		// Calls without results in history never finished.
		for (const block of this.tools.values()) {
			if (block.content.kind === "tool" && block.content.tool.status === "pending") {
				block.content.tool.status = "error";
				block.touch();
			}
		}
		this.tools.clear();
	}

	private addTool(id: string, name: string, args: unknown, status: ToolState["status"]): TranscriptBlock {
		const existing = this.tools.get(id);
		if (existing) return existing;
		const block = this.transcript.add({
			kind: "tool",
			tool: { name, args: (args ?? {}) as Record<string, unknown>, status, output: "" },
		});
		this.tools.set(id, block);
		return block;
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.working = true;
				this.workingSince = Date.now();
				break;
			case "agent_end":
				this.working = false;
				this.workedUntil = Date.now();
				if (this.streaming && this.streaming.render(this.context(this.io.caps.columns)).length === 0) {
					this.transcript.remove(this.streaming);
				}
				this.endStreaming();
				for (const block of this.tools.values()) {
					if (
						block.content.kind === "tool" &&
						(block.content.tool.status === "pending" || block.content.tool.status === "running")
					) {
						block.content.tool.status = "error";
						block.touch();
					}
				}
				this.tools.clear();
				this.refreshFooter();
				break;
			case "message_start":
				if (event.message.role === "user") {
					const text = messageText(event.message.content);
					if (text.trim()) this.transcript.add({ kind: "user", text });
					this.follow = true;
				} else if (event.message.role === "assistant") {
					this.streaming = this.transcript.add({ kind: "assistant", message: event.message, streaming: true });
					this.speed.start();
				} else if (event.message.role === "custom" && event.message.display) {
					this.notice("info", messageText(event.message.content));
				}
				break;
			case "message_update":
				if (event.message.role === "assistant" && this.streaming) {
					this.updateAssistant(event.message);
					this.speed.update(event.message, Date.now());
				}
				break;
			case "message_end":
				if (event.message.role === "assistant" && this.streaming) {
					this.updateAssistant(event.message);
					this.speed.finish(event.message, Date.now());
					if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
						for (const block of this.tools.values()) {
							if (block.content.kind === "tool") {
								block.content.tool.status = "error";
								block.content.tool.output = event.message.errorMessage ?? "Aborted";
								block.touch();
							}
						}
						this.tools.clear();
					}
					this.endStreaming();
					this.refreshFooter();
				}
				break;
			case "tool_execution_start": {
				const block = this.addTool(event.toolCallId, event.toolName, event.args, "running");
				if (block.content.kind === "tool") {
					block.content.tool.status = "running";
					block.content.tool.args = (event.args ?? block.content.tool.args) as Record<string, unknown>;
					block.content.tool.startedAt = Date.now();
					block.touch();
				}
				break;
			}
			case "tool_execution_update": {
				const block = this.tools.get(event.toolCallId);
				if (block && block.content.kind === "tool") {
					block.content.tool.output = messageText(event.partialResult?.content);
					block.content.tool.details = event.partialResult?.details;
					block.touch();
				}
				break;
			}
			case "tool_execution_end": {
				const block = this.tools.get(event.toolCallId);
				if (block && block.content.kind === "tool") {
					const tool = block.content.tool;
					tool.output = messageText(event.result?.content);
					tool.details = event.result?.details;
					tool.status = event.isError ? "error" : "done";
					tool.endedAt = Date.now();
					block.touch();
				}
				this.tools.delete(event.toolCallId);
				break;
			}
			case "queue_update":
				this.queued = event.steering.length + event.followUp.length;
				break;
			case "compaction_start":
				this.compacting = event.reason;
				break;
			case "compaction_end":
				this.compacting = undefined;
				if (event.result) {
					this.rebuildTranscript();
					this.refreshFooter();
				} else if (event.aborted) this.notice("info", "Compaction cancelled");
				else if (event.errorMessage) this.notice("error", event.errorMessage);
				break;
			case "auto_retry_start":
				this.retry = { attempt: event.attempt, max: event.maxAttempts, until: Date.now() + event.delayMs };
				break;
			case "auto_retry_end":
				this.retry = undefined;
				if (!event.success) this.notice("error", `Retry failed: ${event.finalError ?? "unknown error"}`);
				break;
			case "summarization_retry_scheduled":
				this.retry = { attempt: event.attempt, max: event.maxAttempts, until: Date.now() + event.delayMs };
				break;
			case "summarization_retry_finished":
				this.retry = undefined;
				break;
		}
		this.requestRender();
	}

	private updateAssistant(message: AssistantMessage): void {
		const block = this.streaming;
		if (!block || block.content.kind !== "assistant") return;
		block.content.message = message;
		block.touch();
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const tool = this.addTool(content.id, content.name, content.arguments, "pending");
			if (tool.content.kind === "tool" && tool.content.tool.status === "pending") {
				tool.content.tool.args = (content.arguments ?? {}) as Record<string, unknown>;
				tool.touch();
			}
		}
	}

	private endStreaming(): void {
		const block = this.streaming;
		this.streaming = undefined;
		if (block?.content.kind !== "assistant" || !block.content.streaming) return;
		block.content.streaming = false;
		block.touch();
	}

	private refreshFooter(): void {
		try {
			const stats = this.session.getSessionStats();
			this.footer = {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				contextTokens: stats.contextUsage?.tokens ?? null,
				contextWindow: stats.contextUsage?.contextWindow ?? this.model?.contextWindow ?? 0,
			};
		} catch {
			// statistics are cosmetic
		}
	}

	private notice(level: "info" | "warning" | "error", text: string): void {
		this.transcript.add({ kind: "notice", level, text });
		this.follow = true;
		this.requestRender();
	}

	private flash(text: string): void {
		this.flashText = { text, until: Date.now() + 2500 };
		this.requestRender();
	}

	// ---------------------------------------------------------------------------------------------
	// Input

	private handleInput(event: InputEvent): void {
		if (this.closed) return;
		if (this.saving) {
			// the key that wakes the screen does nothing else
			this.wake();
			return;
		}
		this.armSaver();
		if (this.pendingReturn !== undefined) {
			clearTimeout(this.pendingReturn);
			this.pendingReturn = undefined;
			const pasted =
				event.type === "text" || event.type === "paste" || (event.type === "key" && event.key === "return");
			if (pasted && this.mode.kind === "normal") this.editor.newline();
			else this.dispatchKey("return");
		}
		// Pasted text arrives at line speed; allow a few character times between a Return and what follows.
		const bytesPerSecond = this.io.caps.bytesPerSecond;
		const pasteWindow = this.options.pasteWindowMs ?? Math.max(25, bytesPerSecond ? 4000 / bytesPerSecond : 0);
		if (event.type === "key" && event.key === "return" && this.mode.kind === "normal" && pasteWindow > 0) {
			this.pendingReturn = setTimeout(() => {
				this.pendingReturn = undefined;
				this.dispatchKey("return");
				this.requestRender();
			}, pasteWindow);
			return;
		}
		if (event.type === "key") this.dispatchKey(event.key);
		else if (event.type === "text" || event.type === "paste") this.insertText(event.text);
		this.requestRender();
	}

	private insertText(text: string): void {
		const mode = this.mode;
		if (mode.kind === "help") {
			this.mode = { kind: "normal" };
			return;
		}
		if (mode.kind === "selector") {
			mode.filter.insert(text.replace(/\n/g, " "));
			this.refilter(mode);
			return;
		}
		if (mode.kind === "prompt") {
			mode.editor.insert(text.replace(/\n/g, ""));
			return;
		}
		this.editor.insert(text);
	}

	private dispatchKey(key: string): void {
		switch (this.mode.kind) {
			case "help":
				this.helpKey(key, this.mode);
				return;
			case "selector":
				this.selectorKey(key, this.mode);
				return;
			case "prompt":
				this.promptKey(key, this.mode);
				return;
			default:
				this.normalKey(key);
		}
	}

	private normalKey(key: string): void {
		if (this.keymap.matches(key, "app.exit") && this.editor.empty) {
			this.exit();
			return;
		}
		const page = Math.max(1, this.regionHeight - 2);
		const handlers: Array<[Vt420Action, () => void]> = [
			["app.interrupt", () => this.interrupt()],
			["app.clear", () => this.clearOrExit()],
			["app.followUp", () => this.submit("followUp")],
			["editor.submit", () => this.submit("steer")],
			["app.help", () => this.showHelp()],
			["app.menu", () => this.showMenu()],
			["app.resume", () => void this.showSessions()],
			["app.mainScreen", () => this.scrollToEnd()],
			["app.redraw", () => this.redraw()],
			["app.thinking.cycle", () => this.cycleThinking()],
			["app.model.select", () => this.showModels()],
			["app.model.cycle", () => void this.cycleModel()],
			["app.thinking.toggle", () => this.toggleThinking()],
			["app.tools.expand", () => this.toggleTools()],
			["app.scroll.pageUp", () => this.scrollBy(-page)],
			["app.scroll.pageDown", () => this.scrollBy(page)],
			["app.scroll.top", () => this.scrollBy(-this.transcriptLength)],
			["app.scroll.bottom", () => this.scrollToEnd()],
		];
		const handler = handlers.find(([action]) => this.keymap.matches(key, action));
		if (handler) handler[1]();
		else this.editKey(this.editor, key, true);
	}

	private toggleThinking(): void {
		this.showThinking = !this.showThinking;
		this.flash(this.showThinking ? "Showing thinking" : "Hiding thinking");
	}

	private toggleTools(): void {
		this.expandTools = !this.expandTools;
		this.flash(this.expandTools ? "Expanded tool output" : "Collapsed tool output");
	}

	private scrollToEnd(): void {
		this.follow = true;
	}

	/** Apply an editing action; returns whether `key` was one. */
	private editKey(editor: LineEditor, key: string, withHistory: boolean): boolean {
		const action = this.keymap.find(key, EDITOR_ACTIONS);
		switch (action) {
			case undefined:
				return false;
			case "editor.newline":
				editor.newline();
				break;
			case "editor.left":
				editor.left();
				break;
			case "editor.right":
				editor.right();
				break;
			case "editor.up":
				if (!editor.up() && withHistory) editor.historyPrevious();
				break;
			case "editor.down":
				if (!editor.down() && withHistory) editor.historyNext();
				break;
			case "editor.wordLeft":
				editor.wordLeft();
				break;
			case "editor.wordRight":
				editor.wordRight();
				break;
			case "editor.lineStart":
				editor.lineStart();
				break;
			case "editor.lineEnd":
				editor.lineEnd();
				break;
			case "editor.backspace":
				editor.backspace();
				break;
			case "editor.delete":
				editor.deleteForward();
				break;
			case "editor.deleteWordBackward":
				editor.deleteWordBackward();
				break;
			case "editor.deleteWordForward":
				editor.deleteWordForward();
				break;
			case "editor.deleteToLineStart":
				editor.deleteToLineStart();
				break;
			case "editor.deleteToLineEnd":
				editor.deleteToLineEnd();
				break;
			case "editor.yank":
				editor.yank();
				break;
			case "editor.complete":
				if (editor === this.editor) this.complete();
				break;
		}
		return true;
	}

	private complete(): void {
		const text = this.editor.text;
		if (!text.startsWith("/") || text.includes(" ") || text.includes("\n")) return;
		const names = [
			...COMMANDS.map((command) => command.name),
			...this.session.promptTemplates.map((template) => template.name),
		];
		const prefix = text.slice(1);
		const matches = [...new Set(names)].filter((name) => name.startsWith(prefix)).sort();
		if (matches.length === 0) return;
		if (matches.length === 1) {
			this.editor.setText(`/${matches[0]} `);
			return;
		}
		let common = matches[0]!;
		for (const match of matches) while (!match.startsWith(common)) common = common.slice(0, -1);
		if (common.length > prefix.length) this.editor.setText(`/${common}`);
		else this.flash(matches.map((name) => `/${name}`).join(" "));
	}

	private interrupt(): void {
		const session = this.session;
		const busy = this.working || this.bashRunning || session.isCompacting || session.isRetrying;
		if (this.bashRunning) session.abortBash();
		if (session.isRetrying) session.abortRetry();
		if (session.isCompacting) session.abortCompaction();
		if (session.isStreaming) void session.abort();
		if (!busy) this.follow = true;
	}

	private clearOrExit(): void {
		if (!this.editor.empty) {
			this.editor.clear();
			return;
		}
		if (this.working || this.bashRunning || this.session.isCompacting) {
			this.interrupt();
			return;
		}
		const now = Date.now();
		if (now - this.lastClearAt < 1500) {
			this.exit();
			return;
		}
		this.lastClearAt = now;
		this.flash(`${this.keymap.label("app.clear")} again to exit`);
	}

	private submit(behavior: "steer" | "followUp"): void {
		const text = this.editor.text;
		if (!text.trim()) return;
		this.editor.addToHistory(text);
		this.editor.clear();
		this.follow = true;
		const trimmed = text.trim();
		if (trimmed.startsWith("/") && this.runCommand(trimmed)) return;
		if (trimmed.startsWith("!")) {
			void this.runBash(trimmed);
			return;
		}
		const session = this.session;
		const run = session.isStreaming ? session.prompt(text, { streamingBehavior: behavior }) : session.prompt(text);
		if (session.isStreaming && behavior === "followUp") this.flash("Queued as follow-up");
		run.catch((error: unknown) => this.notice("error", errorMessage(error)));
	}

	private runCommand(text: string): boolean {
		const name = text.slice(1).split(/\s+/)[0] ?? "";
		const args = text.slice(1 + name.length).trim();
		const session = this.session;
		switch (name) {
			case "help":
				this.showHelp();
				return true;
			case "model":
				if (args) this.setModelByName(args);
				else this.showModels();
				return true;
			case "thinking":
				if (args) this.setThinking(args);
				else this.cycleThinking();
				return true;
			case "new":
				void this.runtime.newSession().catch((error: unknown) => this.notice("error", errorMessage(error)));
				return true;
			case "resume":
				void this.showSessions();
				return true;
			case "compact":
				session.compact(args || undefined).catch((error: unknown) => this.notice("error", errorMessage(error)));
				return true;
			case "session":
				this.showStats();
				return true;
			case "name":
				if (!args) this.notice("warning", "Usage: /name <name>");
				else {
					session.setSessionName(args);
					this.flash(`Session named ${args}`);
				}
				return true;
			case "login":
				this.showLogin(args);
				return true;
			case "logout":
				void this.logout(args);
				return true;
			case "export":
				session
					.exportToHtml(args || undefined)
					.then((path) => this.notice("info", `Exported to ${path}`))
					.catch((error: unknown) => this.notice("error", errorMessage(error)));
				return true;
			case "reload":
				session
					.reload()
					.then(() => this.flash("Reloaded skills, prompts and context files"))
					.catch((error: unknown) => this.notice("error", errorMessage(error)));
				return true;
			case "charset":
				this.transcript.add({
					kind: "lines",
					render: (context) => renderCharsetShowcase(context.charset, context.width),
				});
				return true;
			case "redraw":
				this.redraw();
				return true;
			case "screensaver":
				this.screensaverCommand(args);
				return true;
			case "quit":
			case "exit":
				this.exit();
				return true;
			default:
				return false;
		}
	}

	private async runBash(text: string): Promise<void> {
		const excluded = text.startsWith("!!");
		const command = text.slice(excluded ? 2 : 1).trim();
		if (!command) return;
		const bash: BashState = { command, output: "", running: true, cancelled: false, excluded, startedAt: Date.now() };
		const block = this.transcript.add({ kind: "bash", bash });
		this.bashRunning = true;
		this.requestRender();
		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					bash.output += chunk;
					block.touch();
					this.requestRender();
				},
				{ excludeFromContext: excluded },
			);
			bash.output = result.output;
			bash.exitCode = result.exitCode;
			bash.cancelled = result.cancelled;
		} catch (error) {
			bash.output += `\n${errorMessage(error)}`;
			bash.exitCode = 1;
		} finally {
			bash.running = false;
			this.bashRunning = false;
			block.touch();
			this.requestRender();
		}
	}

	private cycleThinking(): void {
		const level = this.session.cycleThinkingLevel();
		this.flash(level ? `Thinking ${level}` : "This model does not think");
	}

	private setThinking(level: string): void {
		const levels = this.session.getAvailableThinkingLevels();
		const match = levels.find((candidate) => candidate === level);
		if (!match) {
			this.notice("warning", `Thinking levels: ${levels.join(", ")}`);
			return;
		}
		this.session.setThinkingLevel(match);
		this.flash(`Thinking ${match}`);
	}

	private async cycleModel(): Promise<void> {
		try {
			const result = await this.session.cycleModel("forward");
			if (result) this.flash(`Model ${result.model.provider}/${result.model.id}`);
			else this.flash("No other models");
		} catch (error) {
			this.notice("error", errorMessage(error));
		}
	}

	private availableModels(): SelectorItem[] {
		const current = this.model;
		const models = [...this.session.modelRuntime.getAvailableSnapshot()];
		models.sort((left, right) => {
			const leftCurrent = left.provider === current?.provider && left.id === current?.id;
			const rightCurrent = right.provider === current?.provider && right.id === current?.id;
			return leftCurrent === rightCurrent ? 0 : leftCurrent ? -1 : 1;
		});
		return models.map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: `${model.provider}/${model.id}`,
			detail: `${model.provider === current?.provider && model.id === current?.id ? "current · " : ""}${formatTokens(model.contextWindow)} context`,
		}));
	}

	private selectModel(value: string): void {
		const separator = value.indexOf("/");
		const model = this.session.modelRuntime.getModel(value.slice(0, separator), value.slice(separator + 1));
		if (!model) {
			this.notice("error", `Unknown model ${value}`);
			return;
		}
		this.session
			.setModel(model, { persist: true })
			.then(() => {
				this.flash(`Model ${value}`);
				this.refreshFooter();
			})
			.catch((error: unknown) => this.notice("error", errorMessage(error)));
	}

	private showModels(): void {
		const items = this.availableModels();
		if (items.length === 0) {
			this.notice("warning", "No models are available. Use /login or set a provider API key.");
			return;
		}
		this.openSelector("Select model", items, (item) => this.selectModel(item.value));
	}

	private setModelByName(query: string): void {
		const items = this.availableModels();
		const exact = items.find((item) => item.value === query || item.value.endsWith(`/${query}`));
		const match = exact ?? fuzzyFilter(items, query, (item) => item.value)[0];
		if (match) this.selectModel(match.value);
		else this.notice("warning", `No model matches ${query}`);
	}

	private async showSessions(): Promise<void> {
		try {
			const sessions = await SessionManager.list(this.runtime.cwd, this.options.sessionDir);
			const current = this.session.sessionFile;
			sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
			const items = sessions
				.filter((info) => info.path !== current)
				.map((info) => ({
					value: info.path,
					label: info.name ?? (info.firstMessage.split("\n")[0]?.trim() || "(no messages)"),
					detail: `${info.modified.toISOString().slice(0, 16).replace("T", " ")} · ${info.messageCount}`,
				}));
			if (items.length === 0) {
				this.notice("info", "No earlier sessions in this directory");
				return;
			}
			this.openSelector("Resume session", items, (item) => {
				this.runtime.switchSession(item.value).catch((error: unknown) => this.notice("error", errorMessage(error)));
			});
		} catch (error) {
			this.notice("error", errorMessage(error));
		}
	}

	private showMenu(): void {
		const items = COMMANDS.map((command) => ({
			value: command.name,
			label: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
			detail: command.description,
		}));
		this.openSelector("Commands", items, (item) => {
			const command = COMMANDS.find((candidate) => candidate.name === item.value);
			if (command?.args?.startsWith("<")) this.editor.setText(`/${command.name} `);
			else this.runCommand(`/${item.value}`);
		});
	}

	private showHelp(): void {
		this.mode = {
			kind: "help",
			lines: renderHelp(this.keymap, COMMANDS, this.charset, this.io.caps.columns),
			top: 0,
		};
	}

	private showStats(): void {
		const session = this.session;
		const stats = session.getSessionStats();
		const perTurnOutput = session.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.map((message) => message.usage?.output ?? 0);
		const model = this.model;
		const info = {
			sessionId: stats.sessionId,
			sessionFile: stats.sessionFile,
			messages: stats.totalMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens,
			model: model ? `${model.provider}/${model.id}` : "no model",
			thinking: model?.reasoning ? session.thinkingLevel : undefined,
			tokensPerSecond: this.speed.last,
			contextTokens: stats.contextUsage?.tokens ?? null,
			contextWindow: stats.contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
			perTurnOutput,
		};
		this.transcript.add({ kind: "lines", render: (context) => renderStats(info, context.charset, context.width) });
		this.follow = true;
	}

	private showLogin(query: string): void {
		const runtime = this.session.modelRuntime;
		const items: SelectorItem[] = [];
		for (const provider of runtime.getProviders()) {
			const configured = runtime.getProviderAuthStatus(provider.id).configured ? " · signed in" : "";
			if (provider.auth.oauth) {
				items.push({
					value: JSON.stringify([provider.id, "oauth"]),
					label: provider.name,
					detail: `${provider.auth.oauth.name}${configured}`,
				});
			}
			if (provider.auth.apiKey?.login) {
				items.push({
					value: JSON.stringify([provider.id, "api_key"]),
					label: provider.name,
					detail: `${provider.auth.apiKey.name}${configured}`,
				});
			}
		}
		items.sort((left, right) => left.label.localeCompare(right.label));
		this.openSelector("Sign in", items, (item) => {
			const [providerId, authType] = JSON.parse(item.value) as [string, "oauth" | "api_key"];
			void this.login(providerId, authType);
		});
		if (query && this.mode.kind === "selector") {
			this.mode.filter.setText(query);
			this.refilter(this.mode);
		}
	}

	private async login(providerId: string, authType: "oauth" | "api_key"): Promise<void> {
		if (this.loginController) {
			this.notice("warning", "A sign-in is already running");
			return;
		}
		const controller = new AbortController();
		this.loginController = controller;
		try {
			await this.session.modelRuntime.login(providerId, authType, {
				signal: controller.signal,
				prompt: (prompt) => this.askAuth(prompt),
				notify: (event) => this.authEvent(event),
			});
			this.notice("info", `Signed in to ${providerId}`);
		} catch (error) {
			this.notice(
				controller.signal.aborted ? "info" : "error",
				controller.signal.aborted ? "Sign-in cancelled" : `Sign-in failed: ${errorMessage(error)}`,
			);
		} finally {
			this.loginController = undefined;
			if (this.mode.kind === "prompt") this.mode = { kind: "normal" };
			this.requestRender();
		}
	}

	private askAuth(prompt: AuthPrompt): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			if (prompt.signal?.aborted) {
				reject(new Error("Prompt cancelled"));
				return;
			}
			prompt.signal?.addEventListener(
				"abort",
				() => {
					if (this.mode.kind === "prompt" || this.mode.kind === "selector") this.mode = { kind: "normal" };
					reject(new Error("Prompt cancelled"));
					this.requestRender();
				},
				{ once: true },
			);
			if (prompt.type === "select") {
				this.openSelector(
					prompt.message,
					prompt.options.map((option) => ({ value: option.id, label: option.label, detail: option.description })),
					(item) => resolve(item.value),
					() => {
						this.loginController?.abort();
						reject(new Error("Sign-in cancelled"));
					},
				);
				this.requestRender();
				return;
			}
			const editor = new LineEditor();
			editor.secret = prompt.type === "secret";
			this.mode = { kind: "prompt", message: prompt.message, editor, resolve, reject };
			this.requestRender();
		});
	}

	private authEvent(event: AuthEvent): void {
		switch (event.type) {
			case "auth_url":
				this.notice(
					"info",
					`Open this address on another device:\n${event.url}${event.instructions ? `\n${event.instructions}` : ""}`,
				);
				break;
			case "device_code": {
				const code = event.userCode;
				this.notice("info", `Enter this code at ${event.verificationUri}`);
				this.transcript.add({
					kind: "lines",
					render: (context) => {
						const cells = context.charset.cells(`  ${code}`, ATTR_BOLD);
						// letter-spaced, a code would seem to contain spaces
						if (this.io.caps.doubleSize === false) return [{ cells, attr: LINE_SINGLE }];
						return [
							{ cells, attr: LINE_DOUBLE_TOP },
							{ cells: [...cells], attr: LINE_DOUBLE_BOTTOM },
						];
					},
				});
				break;
			}
			case "info":
				this.notice("info", [event.message, ...(event.links ?? []).map((link) => link.url)].join("\n"));
				break;
			case "progress":
				this.flash(event.message);
				break;
		}
	}

	private async logout(providerId: string): Promise<void> {
		if (!providerId) {
			this.notice("warning", "Usage: /logout <provider>");
			return;
		}
		try {
			await this.session.modelRuntime.logout(providerId);
			this.notice("info", `Removed credentials for ${providerId}`);
		} catch (error) {
			this.notice("error", errorMessage(error));
		}
	}

	private openSelector(
		title: string,
		items: SelectorItem[],
		onSelect: (item: SelectorItem) => void,
		onCancel?: () => void,
	): void {
		this.mode = {
			kind: "selector",
			title,
			items,
			filtered: items,
			selected: 0,
			top: 0,
			filter: new LineEditor(),
			onSelect,
			onCancel,
		};
		this.requestRender();
	}

	private refilter(mode: Extract<Mode, { kind: "selector" }>): void {
		const query = mode.filter.text.trim();
		mode.filtered = query
			? fuzzyFilter(mode.items, query, (item) => `${item.label} ${item.detail ?? ""} ${item.value}`)
			: mode.items;
		mode.selected = 0;
		mode.top = 0;
	}

	private selectorKey(key: string, mode: Extract<Mode, { kind: "selector" }>): void {
		const keys = this.keymap;
		const page = Math.max(1, this.regionHeight - 3);
		if (keys.matches(key, "select.cancel")) {
			this.mode = { kind: "normal" };
			mode.onCancel?.();
			return;
		}
		if (keys.matches(key, "select.confirm")) {
			const item = mode.filtered[mode.selected];
			this.mode = { kind: "normal" };
			if (item) mode.onSelect(item);
			return;
		}
		const move = (delta: number): void => {
			if (mode.filtered.length === 0) return;
			mode.selected = Math.max(0, Math.min(mode.filtered.length - 1, mode.selected + delta));
		};
		if (keys.matches(key, "select.up")) move(-1);
		else if (keys.matches(key, "select.down")) move(1);
		else if (keys.matches(key, "select.pageUp")) move(-page);
		else if (keys.matches(key, "select.pageDown")) move(page);
		else if (this.editKey(mode.filter, key, false)) this.refilter(mode);
	}

	private promptKey(key: string, mode: Extract<Mode, { kind: "prompt" }>): void {
		const keys = this.keymap;
		if (keys.matches(key, "select.cancel") || keys.matches(key, "app.interrupt")) {
			this.mode = { kind: "normal" };
			this.loginController?.abort();
			mode.reject(new Error("Sign-in cancelled"));
			return;
		}
		if (keys.matches(key, "editor.submit") || keys.matches(key, "select.confirm")) {
			this.mode = { kind: "normal" };
			mode.resolve(mode.editor.text);
			return;
		}
		this.editKey(mode.editor, key, false);
	}

	private helpKey(key: string, mode: Extract<Mode, { kind: "help" }>): void {
		const keys = this.keymap;
		const page = Math.max(1, this.regionHeight - 1);
		const max = Math.max(0, mode.lines.length - this.regionHeight);
		if (keys.matches(key, "app.scroll.pageDown") || keys.matches(key, "select.down")) {
			const step = keys.matches(key, "select.down") ? 1 : page;
			if (mode.top >= max && step === page) this.mode = { kind: "normal" };
			else mode.top = Math.min(max, mode.top + step);
			return;
		}
		if (keys.matches(key, "app.scroll.pageUp") || keys.matches(key, "select.up")) {
			mode.top = Math.max(0, mode.top - (keys.matches(key, "select.up") ? 1 : page));
			return;
		}
		this.mode = { kind: "normal" };
	}

	private scrollBy(delta: number): void {
		const maxTop = Math.max(0, this.transcriptLength - this.regionHeight);
		const current = this.follow ? maxTop : this.scrollTop;
		const next = Math.max(0, Math.min(maxTop, current + delta));
		this.scrollTop = next;
		this.follow = next >= maxTop;
	}

	private redraw(): void {
		this.io.reinitialize?.();
		this.renderer.forgetState();
		this.renderer.invalidate();
		this.requestRender();
	}

	// ---------------------------------------------------------------------------------------------
	// Rendering

	private requestRender(): void {
		if (this.closed || this.renderTimer) return;
		if (this.unanswered.length >= SYNC_WINDOW) {
			// the answer to an earlier frame draws this one
			this.framePending = true;
			return;
		}
		const sinceLast = Date.now() - this.lastFrameAt;
		const delay = Math.max(0, 16 - sinceLast, this.io.backlogMs - 30);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.renderNow();
		}, delay);
	}

	private renderNow(): void {
		if (this.closed) return;
		if (this.unanswered.length >= SYNC_WINDOW) {
			this.framePending = true;
			return;
		}
		const frame = this.compose();
		let bytes = this.renderer.render(frame);
		if (bytes !== "" && this.syncRequest) {
			bytes += this.syncRequest.bytes;
			// counted before writing: a terminal can answer before write returns
			this.unanswered.push(bytes.length);
			this.armSync();
		}
		this.io.write(bytes);
		this.lastFrameAt = Date.now();
		this.scheduleAnimation();
	}

	/** The terminal answered after the oldest frame still out, so it has drawn that one. */
	private answered(): void {
		if (this.unanswered.length === 0) return;
		this.unanswered.shift();
		this.armSync();
		this.releaseFrame();
	}

	/** An answer lost on the way must not stop the screen: past the time the frames out could take, they count as drawn. */
	private armSync(): void {
		clearTimeout(this.syncTimer);
		this.syncTimer = undefined;
		if (this.unanswered.length === 0) return;
		const bytes = this.unanswered.reduce((sum, length) => sum + length, 0);
		const ms = 1000 + (bytes * 1000) / (this.io.caps.bytesPerSecond ?? SYNC_BYTES_PER_SECOND);
		this.syncTimer = setTimeout(() => {
			this.syncTimer = undefined;
			this.unanswered = [];
			this.releaseFrame();
		}, ms);
	}

	private releaseFrame(): void {
		if (!this.framePending) return;
		this.framePending = false;
		this.requestRender();
	}

	private get animating(): boolean {
		return (
			this.working ||
			this.bashRunning ||
			this.compacting !== undefined ||
			this.retry !== undefined ||
			this.flashText !== undefined ||
			this.transcript.animated
		);
	}

	private scheduleAnimation(): void {
		if (this.animationTimer || !this.animating) return;
		const bytesPerSecond = this.io.caps.bytesPerSecond ?? Number.POSITIVE_INFINITY;
		const fps = this.options.animationFps ?? (bytesPerSecond <= 960 ? 2 : 5);
		this.animationTimer = setTimeout(() => {
			this.animationTimer = undefined;
			this.tick++;
			if (this.flashText && Date.now() > this.flashText.until) this.flashText = undefined;
			this.requestRender();
		}, 1000 / fps);
	}

	private context(width: number): RenderContext {
		return {
			width,
			charset: this.charset,
			cwd: this.runtime.cwd,
			home: homedir(),
			showThinking: this.showThinking,
			// emulators do not scroll smoothly, so there the live thinking ticks along one line
			rollThinking: !this.io.caps.unicode,
			expandTools: this.expandTools,
			// letter-spaced headings read badly, so without double size they stay at normal size
			largeHeadings: (this.options.largeHeadings ?? true) && this.io.caps.doubleSize !== false,
			tick: this.tick,
			now: Date.now(),
			key: (action) => this.keymap.label(action),
		};
	}

	private compose(): Frame {
		const { rows, columns, statusLine } = this.io.caps;
		if (this.saving) return saverFrame(rows, columns, this.saverLine(), this.saverPlace, statusLine);
		const input = this.inputLayout(columns);
		const maxInput = Math.max(1, Math.min(8, Math.floor(rows / 4)));
		const inputTop = Math.max(0, Math.min(input.cursorRow - maxInput + 1, input.rows.length - maxInput));
		const shownInput = input.rows.slice(inputTop, inputTop + maxInput);
		const footerRows = statusLine ? 0 : 1;
		const regionHeight = Math.max(1, rows - 1 - shownInput.length - footerRows);
		this.regionHeight = regionHeight;
		const lines = this.regionLines(regionHeight, columns);
		lines.push({ cells: this.separator(columns), attr: LINE_SINGLE });
		for (const row of shownInput) lines.push({ cells: row, attr: LINE_SINGLE });
		const footer = this.footerCells(columns);
		if (!statusLine) lines.push({ cells: footer, attr: LINE_SINGLE });
		const cursorVisible = this.mode.kind !== "help";
		return {
			lines,
			status: statusLine ? footer : undefined,
			cursor: cursorVisible
				? { row: regionHeight + 1 + (input.cursorRow - inputTop), col: Math.min(columns - 1, input.cursorCol) }
				: undefined,
			scroll: { top: 0, bottom: regionHeight - 1 },
		};
	}

	// ---------------------------------------------------------------------------------------------
	// Screen saver

	/** Start the screen saver once the configured spell passes without a key. */
	private armSaver(): void {
		clearTimeout(this.saverTimer);
		this.saverTimer = undefined;
		if (this.saver === "off" || this.closed) return;
		this.saverTimer = setTimeout(() => this.startSaver(this.saver), this.saverMinutes * 60_000);
	}

	private startSaver(mode: SaverMode): void {
		if (mode === "off" || this.saving || this.closed) return;
		clearTimeout(this.saverTimer);
		this.saverTimer = undefined;
		this.saving = mode;
		// a light screen would stay lit
		if (this.io.caps.screenReverse) this.io.write("\x1b[?5l");
		this.moveSaver();
		if (mode === "progress")
			this.saverMoveTimer = setInterval(() => this.moveSaver(), this.options.saverMoveMs ?? SAVER_MOVE_MS);
	}

	private moveSaver(): void {
		const { rows, columns } = this.io.caps;
		this.saverPlace = saverPlace(rows, columns, this.saverLine()?.length ?? 0);
		this.requestRender();
	}

	private wake(): void {
		this.saving = undefined;
		clearInterval(this.saverMoveTimer);
		this.saverMoveTimer = undefined;
		if (this.io.caps.screenReverse) this.io.write("\x1b[?5h");
		this.armSaver();
		this.requestRender();
	}

	/** The progress saver's line: how long the work has run, or how long ago it ended. */
	private saverLine(): number[] | undefined {
		if (this.saving !== "progress") return undefined;
		const now = Date.now();
		let text: string;
		if (this.mode.kind === "prompt" || this.mode.kind === "selector") text = "Waiting for you";
		else if (this.retry) text = `Retrying in ${formatDuration(Math.max(0, this.retry.until - now) / 1000)}`;
		else if (this.compacting) text = "Compacting";
		else if (this.working) {
			const speed = this.speed.display;
			const approximate = speed?.approximate ? this.charset.pick("≃", "~") : "";
			const rate = speed ? ` · ${approximate}${formatRate(speed.rate)} tok/s` : "";
			text = `Working ${formatDuration((now - this.workingSince) / 1000)}${rate}`;
		} else if (this.workedUntil) text = `Done ${formatDuration((now - this.workedUntil) / 1000)} ago`;
		else text = "Idle";
		return this.charset.cells(`π ${text}`);
	}

	/** `/screensaver` starts it now; a mode or a number of minutes changes the setting and keeps it. */
	private screensaverCommand(args: string): void {
		const words = args.split(/\s+/).filter((word) => word !== "");
		if (words.length === 0) {
			this.startSaver(this.saver === "off" ? "progress" : this.saver);
			return;
		}
		for (const word of words) {
			const minutes = Number(word);
			if (isSaverMode(word)) this.saver = word;
			else if (Number.isFinite(minutes) && minutes > 0) this.saverMinutes = minutes;
			else {
				this.notice("warning", "Usage: /screensaver [off|blank|progress] [minutes]");
				return;
			}
		}
		try {
			this.options.saveSettings?.({ screensaver: this.saver, screensaverMinutes: this.saverMinutes });
		} catch (error) {
			this.notice("error", `Cannot keep the setting: ${errorMessage(error)}`);
		}
		this.armSaver();
		this.flash(
			this.saver === "off" ? "Screen saver off" : `Screen saver: ${this.saver} after ${this.saverMinutes} min`,
		);
	}

	private inputLayout(width: number): { rows: number[][]; cursorRow: number; cursorCol: number } {
		const charset = this.charset;
		switch (this.mode.kind) {
			case "selector":
				return this.mode.filter.layout(width, charset, charset.cells(`${charset.pick("∇", ">")} `, ATTR_BOLD));
			case "prompt":
				return this.mode.editor.layout(width, charset, charset.cells("» ", ATTR_BOLD));
			default:
				return this.editor.layout(width, charset, charset.cells("π ", ATTR_BOLD));
		}
	}

	private regionLines(height: number, width: number): Line[] {
		const mode = this.mode;
		let lines: Line[];
		if (mode.kind === "selector") {
			const visible = Math.max(1, height - 2);
			if (mode.selected < mode.top) mode.top = mode.selected;
			if (mode.selected >= mode.top + visible) mode.top = mode.selected - visible + 1;
			const hint = `${this.keymap.label("select.confirm")} choose · ${this.keymap.label("select.cancel")} cancel · type to filter`;
			lines = renderSelector(
				{ title: mode.title, items: mode.filtered, selected: mode.selected, top: mode.top, hint },
				this.charset,
				width,
				height,
			);
		} else if (mode.kind === "help") {
			lines = mode.lines.slice(mode.top, mode.top + height);
		} else {
			const all = this.transcript.lines(this.context(width));
			this.transcriptLength = all.length;
			const maxTop = Math.max(0, all.length - height);
			if (this.follow || this.scrollTop >= maxTop) {
				this.follow = true;
				this.scrollTop = maxTop;
			}
			lines = all.slice(this.scrollTop, this.scrollTop + height);
		}
		while (lines.length < height) lines.push({ cells: [], attr: LINE_SINGLE });
		return lines.slice(0, height);
	}

	private statusText(): string | undefined {
		const interrupt = this.keymap.label("app.interrupt");
		const spinner = SPINNER[this.tick % SPINNER.length]!;
		const now = Date.now();
		if (this.mode.kind === "prompt") return this.mode.message.split("\n")[0];
		if (this.flashText && now <= this.flashText.until) return this.flashText.text;
		if (this.retry) {
			const seconds = Math.max(0, Math.ceil((this.retry.until - now) / 1000));
			return `Retry ${this.retry.attempt}/${this.retry.max} in ${formatDuration(seconds)} · ${interrupt} stop`;
		}
		if (this.compacting) return `Compacting ${spinner} · ${interrupt} stop`;
		if (this.working) {
			const seconds = Math.floor((now - this.workingSince) / 1000);
			return `Working ${spinner}${seconds > 0 ? ` ${formatDuration(seconds)}` : ""} · ${interrupt} stop`;
		}
		if (this.bashRunning) return `Running ${spinner} · ${interrupt} stop`;
		return undefined;
	}

	private separator(width: number): number[] {
		const charset = this.charset;
		const line = charset.cell("─");
		const status = this.statusText();
		const left: number[] = [line];
		if (status) left.push(charset.cell("◆"), ...charset.cells(` ${status} `));
		const right: number[] = [];
		if (this.mode.kind === "normal") {
			const hidden = Math.max(0, this.transcriptLength - this.regionHeight - this.scrollTop);
			if (!this.follow && hidden > 0) {
				const more = charset.has("↓") ? `↓ ${hidden} more` : `${hidden} more below`;
				right.push(...charset.cells(` ${more} · ${this.keymap.label("app.scroll.bottom")} `));
			} else if (this.queued > 0) {
				right.push(...charset.cells(` ${this.queued} queued `));
			} else if (!status) {
				right.push(...charset.cells(` ${this.keymap.label("app.help")} keys `));
			}
		}
		right.push(line);
		const room = Math.max(0, width - right.length);
		const shown = truncateCells(left, room, charset.cells("… "));
		return [...padCells(shown, width - right.length, line), ...right];
	}

	/** Tokens in and out, generation speed, context use and the directory, right-aligned to leave room under the prompt. */
	private footerCells(width: number): number[] {
		const charset = this.charset;
		const stats = this.footer;
		const segments: Array<{ cells: number[]; priority: number }> = [];
		segments.push({ cells: charset.cells(tokenCounts(charset, stats)), priority: 0 });
		const speed = this.speed.display;
		if (speed) {
			const approximate = speed.approximate ? charset.pick("≃", "~") : "";
			segments.push({ cells: charset.cells(`${approximate}${formatRate(speed.rate)} tok/s`), priority: 1 });
		}
		if (stats.contextWindow > 0) {
			const used = stats.contextTokens;
			segments.push({
				cells: [
					...gauge(used === null ? 0 : used / stats.contextWindow, 6, charset),
					...charset.cells(` ${used === null ? "?" : formatTokens(used)}/${formatTokens(stats.contextWindow)}`),
				],
				priority: 2,
			});
		}
		const path = tildePath(this.runtime.cwd, homedir());
		const directory = path.length <= FOOTER_DIRECTORY_WIDTH ? path : basename(this.runtime.cwd);
		segments.push({
			cells: truncateCells(charset.cells(directory), FOOTER_DIRECTORY_WIDTH, charset.cells("…")),
			priority: 3,
		});
		const separator = charset.cells(" · ");
		const length = (list: typeof segments): number =>
			list.reduce((sum, segment) => sum + segment.cells.length, 0) + separator.length * (list.length - 1);
		let kept = segments;
		while (kept.length > 1 && length(kept) > width - 2) {
			const drop = kept.reduce((worst, segment) => (segment.priority > worst.priority ? segment : worst));
			kept = kept.filter((segment) => segment !== drop);
		}
		const cells: number[] = [];
		kept.forEach((segment, index) => {
			if (index > 0) cells.push(...separator);
			cells.push(...segment.cells);
		});
		const shown = truncateCells(cells, width - 2, []);
		return [...spaces(width - 1 - shown.length), ...shown, 0x20];
	}
}
