/**
 * The VT420 frontend: binds an AgentSession runtime to the transcript, the editor and the screen.
 *
 * Layout, top to bottom: the transcript inside the DECSTBM scrolling region, one separator row that
 * doubles as the status line for work in progress, the editor, and the footer. The footer lives on the
 * host-writable status line when the terminal has one, otherwise on the last row.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	type AssistantMessage,
	type AuthEvent,
	type AuthPrompt,
	getSupportedThinkingLevels,
	type Transport,
} from "@earendil-works/pi-ai";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { getAuthCredential } from "../../cli/auth-command.ts";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { bugReportArchiveFileName, writeBugReportArchive } from "../../core/bug-report.ts";
import { uploadBugReport } from "../../core/bug-report-upload.ts";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import {
	configureHttpDispatcher,
	formatHttpIdleTimeoutMs,
	HTTP_IDLE_TIMEOUT_CHOICES,
} from "../../core/http-dispatcher.ts";
import { resolveModelScopeFromModels } from "../../core/model-resolver.ts";
import { getRadiusGatewayUrl, RADIUS_PROVIDER_ID } from "../../core/radius.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { CACHE_WARMING_MODES, type CacheWarmingMode, type DefaultProjectTrust } from "../../core/settings-manager.ts";
import { getProjectTrustOptions, ProjectTrustStore } from "../../core/trust-manager.ts";
import {
	DISCLAIMER as BUG_REPORT_DISCLAIMER,
	TRANSCRIPT_NOTE as BUG_REPORT_TRANSCRIPT_NOTE,
	type BugReportOptions,
	buildBundle as buildBugReport,
	recordInSession as recordBugReport,
} from "../../modes/interactive/bug-report.ts";
import { exportSessionForShare } from "../../modes/interactive/session-share.ts";
import { getChangelogPath, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { ATTR_BOLD, LINE_DOUBLE_BOTTOM, LINE_DOUBLE_TOP, LINE_SINGLE, type Line } from "./cells.ts";
import { Charset } from "./charset.ts";
import { LineEditor } from "./editor.ts";
import { createExtensionUI } from "./extension-ui.ts";
import type { InputEvent, TerminalResponse } from "./input.ts";
import type { Keymap, Vt420Action } from "./keys.ts";
import { renderMarkdown } from "./markdown.ts";
import { type Frame, type Renderer, rendererFor } from "./renderer.ts";
import {
	generatedText,
	isSaverMode,
	MatrixRain,
	RAIN_STEP_MS,
	SAVER_MINUTES,
	SAVER_MOVE_MS,
	type SaverMode,
	saverFrame,
	saverPlace,
} from "./saver.ts";
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
import { treeRows } from "./tree.ts";
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
export type Vt420Runtime = Pick<
	AgentSessionRuntime,
	"session" | "cwd" | "newSession" | "switchSession" | "fork" | "importFromJsonl" | "setRebindSession"
> & { readonly services: { readonly agentDir: string } };

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
/**
 * A DEC terminal gets a frame in pieces of at most this many bytes, each answered before the window lets more out,
 * so a whole page never runs ahead of it: flow control that comes back over ssh comes too late to stop one.
 */
const SYNC_CHUNK = 160;
/** Bytes a DEC terminal has not answered yet, at most: two pieces' worth, however the frames split into them. */
const SYNC_BYTES_WINDOW = 2 * SYNC_CHUNK;
/** On a faster line the window holds this much of the line's time instead, up to four pieces. */
const SYNC_WINDOW_SECONDS = 1 / 6;

/** Pieces joined into runs of at most `max` characters; a longer piece stays whole. */
function chunks(parts: readonly string[], max: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const part of parts) {
		if (current !== "" && current.length + part.length > max) {
			out.push(current);
			current = "";
		}
		current += part;
	}
	if (current !== "") out.push(current);
	return out;
}

export const COMMANDS: readonly CommandInfo[] = [
	{ name: "help", description: "keys and commands" },
	{ name: "hotkeys", description: "keys and commands, as /help" },
	{ name: "model", args: "[name]", description: "select or switch the model" },
	{ name: "thinking", args: "[level]", description: "set or cycle the thinking level" },
	{ name: "new", description: "start a new session" },
	{ name: "resume", description: "resume an earlier session" },
	{ name: "compact", args: "[focus]", description: "summarize the context" },
	{ name: "session", description: "tokens, speed and context" },
	{ name: "name", args: "[name]", description: "name this session, or show its name" },
	{ name: "clone", description: "copy this session as it stands into a new one" },
	{ name: "fork", description: "a new session from before one of your messages" },
	{ name: "tree", description: "move to another point of the session tree" },
	{ name: "import", args: "<path.jsonl>", description: "replace the session with an exported one" },
	{ name: "login", args: "[provider]", description: "sign in to a provider" },
	{ name: "logout", args: "[provider]", description: "remove stored credentials" },
	{ name: "trust", description: "save whether this project's resources may load" },
	{ name: "settings", description: "the settings that apply here" },
	{ name: "scoped-models", description: "the models that next-model goes through" },
	{ name: "copy", description: "copy the last answer to the clipboard" },
	{ name: "share", description: "share the session through Radius or as a secret gist" },
	{ name: "bug", args: "[what went wrong]", description: "report a bug to the pi developers" },
	{ name: "changelog", description: "what is new in pi" },
	{ name: "export", args: "[path]", description: "write the session as HTML, or JSONL for a .jsonl path" },
	{ name: "reload", description: "reload skills, prompts and context files" },
	{ name: "charset", description: "show every VT420 glyph" },
	{ name: "redraw", description: "repaint the screen" },
	{ name: "screensaver", args: "[off|blank|progress|matrix] [min]", description: "dark screen now, or set when" },
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
			/** A sign-in's prompt: cancelling it ends the sign-in too. */
			auth?: boolean;
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

/** One line of /settings: what it is now, and the values to pick from; one without them is a toggle. */
interface SettingRow {
	label: string;
	value: string;
	choices?: readonly string[];
	apply(value: string): void;
	/** A list of its own instead of values, returning to /settings when done. */
	open?(back: () => void): void;
}

const TRUST_LABELS: Record<DefaultProjectTrust, string> = { ask: "Ask", always: "Always trust", never: "Never trust" };
const SAVER_WAITS = [1, 2, 5, 10, 15, 30, 60];

/** A path argument as pi reads it: in quotes up to the matching one, otherwise up to the first space. */
function pathArgument(args: string): string | undefined {
	const text = args.trimStart();
	const quote = text[0];
	if (quote === '"' || quote === "'") {
		const end = text.indexOf(quote, 1);
		return end > 0 ? text.slice(1, end) : undefined;
	}
	return text.split(/\s/)[0] || undefined;
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
	private summarizing = false;
	private readonly extensionUI: ExtensionUIContext;
	/** What extensions show on the separator row when nothing else is, and their word for working. */
	private extensionStatus: string | undefined;
	private workingWord: string | undefined;
	/** Something a command waits for, shown on the separator row; interrupt cancels it. */
	private activity: { text: string; controller: AbortController } | undefined;
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
	/** Bytes of each piece the terminal has not answered yet. */
	private unanswered: number[] = [];
	/** Pieces of the last frame still to go out. */
	private outbox: string[] = [];
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
	private rain: MatrixRain | undefined;
	private rainTimer: ReturnType<typeof setInterval> | undefined;
	/** How much of the streaming message has gone into the rain. */
	private rainSeen = 0;
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
		this.extensionUI = createExtensionUI({
			select: (title, items, signal) => this.dialogSelect(title, items, signal),
			input: (title, initial, signal) => this.dialogInput(title, initial, signal),
			notice: (level, text) => this.notice(level, text),
			status: (text) => {
				this.extensionStatus = text;
				this.requestRender();
			},
			working: (message) => {
				this.workingWord = message;
				this.requestRender();
			},
			editorText: () => this.editor.text,
			setEditorText: (text) => {
				this.editor.setText(text);
				this.requestRender();
			},
			insertText: (text) => {
				this.editor.insert(text);
				this.requestRender();
			},
			toolsExpanded: () => this.expandTools,
			setToolsExpanded: (expanded) => {
				if (expanded !== this.expandTools) this.toggleTools();
			},
		});
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
		clearInterval(this.rainTimer);
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
		await session.bindExtensions({
			// dialogs without pi's TUI components, as in RPC mode
			mode: "rpc",
			uiContext: this.extensionUI,
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => this.runtime.newSession(options),
				fork: async (entryId, options) => ({ cancelled: (await this.runtime.fork(entryId, options)).cancelled }),
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, options);
					this.rebuildTranscript();
					this.refreshFooter();
					this.requestRender();
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => this.exit(),
			onError: (error) => this.notice("error", `Extension ${error.extensionPath}: ${error.error}`),
		});
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
					this.rainSeen = 0;
				} else if (event.message.role === "custom" && event.message.display) {
					this.notice("info", messageText(event.message.content));
				}
				break;
			case "message_update":
				if (event.message.role === "assistant" && this.streaming) {
					this.updateAssistant(event.message);
					this.speed.update(event.message, Date.now());
					this.feedRain(event.message);
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
			["app.matrix", () => this.startSaver("matrix")],
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
		const session = this.session;
		const names = [
			...this.allCommands().map((command) => command.name),
			...session.promptTemplates.map((template) => template.name),
			...(session.settingsManager.getEnableSkillCommands()
				? session.resourceLoader.getSkills().skills.map((skill) => `skill:${skill.name}`)
				: []),
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
		this.activity?.controller.abort();
		const session = this.session;
		const busy = this.working || this.bashRunning || session.isCompacting || session.isRetrying;
		if (this.bashRunning) session.abortBash();
		if (session.isRetrying) session.abortRetry();
		if (session.isCompacting) {
			session.abortCompaction();
			session.abortBranchSummary();
		}
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
			case "hotkeys":
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
				if (args) {
					session.setSessionName(args);
					const named = session.sessionName ?? args;
					if (named !== args) this.notice("warning", `Session name was normalized from "${args}" to "${named}"`);
					this.flash(`Session named ${named}`);
				} else if (session.sessionName) this.notice("info", `Session name: ${session.sessionName}`);
				else this.notice("warning", "Usage: /name <name>");
				return true;
			case "import":
				void this.importSession(args);
				return true;
			case "fork":
				this.showFork();
				return true;
			case "tree":
				this.showTree();
				return true;
			case "clone": {
				const leaf = session.sessionManager.getLeafId();
				if (!leaf) this.flash("Nothing to clone yet");
				else {
					this.runtime
						.fork(leaf, { position: "at" })
						.then((result) => {
							if (!result.cancelled) this.flash("Cloned to a new session");
						})
						.catch((error: unknown) => this.notice("error", errorMessage(error)));
				}
				return true;
			}
			case "login":
				this.showLogin(args);
				return true;
			case "logout":
				if (args) void this.logout(args);
				else void this.showLogout();
				return true;
			case "trust":
				this.showTrust();
				return true;
			case "settings":
				this.showSettings();
				return true;
			case "scoped-models":
				this.showScopedModels();
				return true;
			case "copy":
				void this.copyLastAnswer();
				return true;
			case "share":
				void this.shareSession();
				return true;
			case "bug":
				void this.reportBug(args);
				return true;
			case "changelog":
				this.showChangelog();
				return true;
			case "export":
				if (args.endsWith(".jsonl")) {
					try {
						this.notice("info", `Exported to ${session.exportToJsonl(args)}`);
					} catch (error) {
						this.notice("error", errorMessage(error));
					}
				} else {
					session
						.exportToHtml(args || undefined)
						.then((path) => this.notice("info", `Exported to ${path}`))
						.catch((error: unknown) => this.notice("error", errorMessage(error)));
				}
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
				this.runtime.switchSession(item.value).catch(async (error: unknown) => {
					const cwd = error instanceof MissingSessionCwdError ? await this.continueHere(error) : undefined;
					if (cwd) {
						await this.runtime
							.switchSession(item.value, { cwdOverride: cwd })
							.catch((retry: unknown) => this.notice("error", errorMessage(retry)));
					} else if (!(error instanceof MissingSessionCwdError)) this.notice("error", errorMessage(error));
				});
			});
		} catch (error) {
			this.notice("error", errorMessage(error));
		}
	}

	/** The frontend's commands, then those extensions registered, which the session runs. */
	private allCommands(): CommandInfo[] {
		const own = new Set(COMMANDS.map((command) => command.name));
		const extensions = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((command) => !own.has(command.invocationName))
			.map((command) => ({ name: command.invocationName, description: command.description ?? "extension command" }));
		return [...COMMANDS, ...extensions];
	}

	private showMenu(): void {
		const commands = this.allCommands();
		const items = commands.map((command) => ({
			value: command.name,
			label: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
			detail: command.description,
		}));
		this.openSelector("Commands", items, (item) => {
			const command = COMMANDS.find((candidate) => candidate.name === item.value);
			// an extension's command may take arguments, so it waits in the editor for Return
			if (!command || command.args?.startsWith("<")) this.editor.setText(`/${item.value} `);
			else this.runCommand(`/${item.value}`);
		});
	}

	private showHelp(): void {
		this.mode = {
			kind: "help",
			lines: renderHelp(this.keymap, this.allCommands(), this.charset, this.io.caps.columns),
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
			this.mode = { kind: "prompt", message: prompt.message, editor, resolve, reject, auth: true };
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
		selected = 0,
	): void {
		this.mode = {
			kind: "selector",
			title,
			items,
			filtered: items,
			selected: Math.max(0, Math.min(items.length - 1, selected)),
			top: 0,
			filter: new LineEditor(),
			onSelect,
			onCancel,
		};
		this.requestRender();
	}

	/** `/import <path>`: replace the session with a JSONL file, offering the current directory when its own is gone. */
	private async importSession(args: string): Promise<void> {
		const path = pathArgument(args);
		if (!path) {
			this.notice("warning", "Usage: /import <path.jsonl>");
			return;
		}
		if (!(await this.confirm(`Replace the current session with ${path}?`))) {
			this.flash("Import cancelled");
			return;
		}
		const load = async (cwd?: string): Promise<void> => {
			const result = await this.runtime.importFromJsonl(path, cwd);
			this.flash(result.cancelled ? "Import cancelled" : `Session imported from ${path}`);
		};
		try {
			await load();
		} catch (error) {
			const cwd = error instanceof MissingSessionCwdError ? await this.continueHere(error) : undefined;
			if (error instanceof MissingSessionCwdError && !cwd) this.flash("Import cancelled");
			else if (cwd)
				await load(cwd).catch((retry: unknown) =>
					this.notice("error", `Failed to import session: ${errorMessage(retry)}`),
				);
			else this.notice("error", `Failed to import session: ${errorMessage(error)}`);
		}
	}

	/** A session whose directory is gone can go on in the current one; undefined when declined. */
	private async continueHere(error: MissingSessionCwdError): Promise<string | undefined> {
		this.notice("warning", formatMissingSessionCwdPrompt(error.issue));
		return (await this.confirm("Continue in the current directory?")) ? error.issue.fallbackCwd : undefined;
	}

	/** `/changelog`: pi's release notes in the pager, newest first. */
	private showChangelog(): void {
		const entries = parseChangelog(getChangelogPath());
		const text = entries.map((entry) => normalizeChangelogLinks(entry.content, entry)).join("\n\n");
		const width = this.io.caps.columns;
		this.mode = {
			kind: "help",
			lines: [
				{ cells: this.charset.cells("What's New", ATTR_BOLD), attr: LINE_SINGLE },
				{ cells: [], attr: LINE_SINGLE },
				...renderMarkdown(text || "No changelog entries found.", {
					width,
					charset: this.charset,
					largeHeadings: this.io.caps.doubleSize !== false,
				}),
			],
			top: 0,
		};
	}

	/**
	 * `/copy`: the last answer to an emulator's clipboard with OSC 52, written through the terminal since stray output
	 * is kept off the screen, or to the desktop's when there is one. A VT420 has no clipboard.
	 */
	private async copyLastAnswer(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.notice("warning", "No agent messages to copy yet");
			return;
		}
		if (this.io.caps.unicode && !process.env.VT420_TERM) {
			const encoded = Buffer.from(text, "utf8").toString("base64");
			if (encoded.length > 100_000) {
				this.notice("error", "Clipboard unavailable: the text exceeds the OSC 52 size limit");
				return;
			}
			this.io.write(`\x1b]52;c;${encoded}\x1b\\`);
			this.flash("Copied the last answer to the clipboard");
			return;
		}
		if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
			this.notice("warning", "This terminal has no clipboard; /export writes the session to a file");
			return;
		}
		try {
			await copyToClipboard(text);
			this.flash("Copied the last answer to the desktop clipboard");
		} catch (error) {
			this.notice("error", errorMessage(error));
		}
	}

	/** `/logout` without a provider: pick one of those with credentials saved by /login. */
	private async showLogout(): Promise<void> {
		const models = this.session.modelRuntime;
		let credentials: ReadonlyArray<{ providerId: string; type: string }>;
		try {
			credentials = await models.listCredentials({ signal: AbortSignal.timeout(15_000) });
		} catch (error) {
			this.notice("error", `Could not read stored credentials: ${errorMessage(error)}`);
			return;
		}
		if (credentials.length === 0) {
			this.notice(
				"info",
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json are unchanged.",
			);
			return;
		}
		const kinds = new Set(credentials.map((credential) => credential.type)).size > 1;
		const items = credentials
			.map(({ providerId, type }) => ({
				value: providerId,
				label: models.getProvider(providerId)?.name ?? providerId,
				detail: kinds ? (type === "oauth" ? "subscription" : "API key") : undefined,
			}))
			.sort((left, right) => left.label.localeCompare(right.label));
		this.openSelector("Log out of", items, (item) => void this.logout(item.value));
	}

	/** `/trust`: save whether this project's own extensions and settings may load, for the next start. */
	private showTrust(): void {
		const cwd = this.session.sessionManager.getCwd();
		let store: ProjectTrustStore;
		let saved: { path: string; decision: boolean } | null;
		try {
			store = new ProjectTrustStore(this.runtime.services.agentDir);
			saved = store.getEntry(cwd);
		} catch (error) {
			this.notice("error", errorMessage(error));
			return;
		}
		const options = getProjectTrustOptions(cwd);
		const here = options[0]?.savedPath;
		const decision = saved ? (saved.decision ? "trusted" : "untrusted") : "none";
		const where = saved ? (saved.path === here ? ` (${saved.path})` : ` (inherited from ${saved.path})`) : "";
		const current = this.session.settingsManager.isProjectTrusted() ? "trusted" : "untrusted";
		this.notice("info", `Project trust for ${cwd}: saved decision ${decision}${where}; this session ${current}`);
		const savedIndex = options.findIndex(
			(option) => saved !== null && option.savedPath === saved.path && option.trusted === saved.decision,
		);
		this.openSelector(
			"Project trust",
			options.map((option, index) => ({
				value: String(index),
				label: option.label,
				detail: index === savedIndex ? "saved" : undefined,
			})),
			(item) => {
				const option = options[Number(item.value)]!;
				try {
					store.setMany(option.updates);
					this.notice(
						"info",
						`Saved trust decision: ${option.trusted ? "trusted" : "untrusted"}. Restart pi for it to take effect.`,
					);
				} catch (error) {
					this.notice("error", errorMessage(error));
				}
			},
			undefined,
			Math.max(0, savedIndex),
		);
	}

	/** `/fork`: a new session from before one of your messages, whose text comes back into the editor. */
	private showFork(): void {
		const messages = this.session.getUserMessagesForForking();
		if (messages.length === 0) {
			this.flash("No messages to fork from");
			return;
		}
		const items = messages.map((message, index) => ({
			value: message.entryId,
			label: message.text.replace(/\s+/g, " ").trim(),
			detail: `${index + 1}/${messages.length}`,
		}));
		this.openSelector(
			"Fork from message",
			items,
			(item) => {
				this.runtime
					.fork(item.value)
					.then((result) => {
						if (result.cancelled) return;
						this.editor.setText(result.selectedText ?? "");
						this.flash("Forked to a new session");
					})
					.catch((error: unknown) => this.notice("error", errorMessage(error)));
			},
			undefined,
			items.length - 1,
		);
	}

	/** `/tree`: the session's tree, opened where it stands, to move to another point of it. */
	private showTree(selectedId?: string): void {
		const manager = this.session.sessionManager;
		const leaf = manager.getLeafId();
		const rows = treeRows(manager.getTree(), leaf);
		if (rows.length === 0) {
			this.flash("No entries in session");
			return;
		}
		const dot = this.charset.pick("•", "*");
		const items = rows.map((row) => ({
			value: row.id,
			label: `${row.prefix}${row.onPath ? `${dot} ` : ""}${row.label ? `[${row.label}] ` : ""}${row.text}`,
		}));
		const target = selectedId ?? leaf;
		const at = rows.findIndex((row) => row.id === target);
		const selected = at >= 0 ? at : rows.findLastIndex((row) => row.onPath);
		this.openSelector("Session tree", items, (item) => void this.navigateTo(item.value), undefined, selected);
	}

	/** Move to `entryId`, summarizing the branch left behind when asked; a user message comes back into the editor. */
	private async navigateTo(entryId: string): Promise<void> {
		const session = this.session;
		if (entryId === session.sessionManager.getLeafId()) {
			this.flash("Already at this point");
			return;
		}
		let summarize = false;
		let customInstructions: string | undefined;
		if (!session.settingsManager.getBranchSummarySkipPrompt()) {
			for (;;) {
				const choice = await this.choose("Summarize the branch you leave?", [
					"No summary",
					"Summarize",
					"Summarize with custom prompt",
				]);
				if (choice === undefined) {
					this.showTree(entryId);
					return;
				}
				summarize = choice !== "No summary";
				if (choice !== "Summarize with custom prompt") break;
				customInstructions = await this.ask("Custom summarization instructions:");
				if (customInstructions !== undefined) break;
			}
		}
		if (session.isStreaming) await session.abort();
		if (session.isCompacting) {
			this.notice("error", "Wait for the current compaction or tree navigation to finish first");
			return;
		}
		this.summarizing = summarize;
		this.requestRender();
		try {
			const result = await session.navigateTree(entryId, { summarize, customInstructions });
			if (result.aborted) {
				this.flash("Branch summarization cancelled");
				this.showTree(entryId);
				return;
			}
			if (result.cancelled) {
				this.flash("Navigation cancelled");
				return;
			}
			this.rebuildTranscript();
			this.refreshFooter();
			if (result.editorText && this.editor.empty) this.editor.setText(result.editorText);
			this.flash("Navigated to the selected point");
		} catch (error) {
			this.notice("error", errorMessage(error));
		} finally {
			this.summarizing = false;
			this.requestRender();
		}
	}

	/** The settings of pi that do something here, and the screen saver's. */
	private settingRows(): SettingRow[] {
		const session = this.session;
		const settings = session.settingsManager;
		const onOff = (on: boolean): string => (on ? "on" : "off");
		const keepSaver = (): void => {
			this.options.saveSettings?.({ screensaver: this.saver, screensaverMinutes: this.saverMinutes });
			this.armSaver();
		};
		const levels = Object.keys(settings.getAllModelThinkingLevels()).length;
		return [
			{
				label: "Auto-compact",
				value: onOff(session.autoCompactionEnabled),
				apply: (value) => session.setAutoCompactionEnabled(value === "on"),
			},
			{
				label: "Steering mode",
				value: session.steeringMode,
				choices: ["one-at-a-time", "all"],
				apply: (value) => session.setSteeringMode(value as "all" | "one-at-a-time"),
			},
			{
				label: "Follow-up mode",
				value: session.followUpMode,
				choices: ["one-at-a-time", "all"],
				apply: (value) => session.setFollowUpMode(value as "all" | "one-at-a-time"),
			},
			{
				label: "Thinking per model",
				value: levels === 0 ? "none" : `${levels} configured`,
				apply: () => {},
				open: (back) => this.showModelThinking(back),
			},
			{
				label: "Transport",
				value: settings.getTransport(),
				choices: ["sse", "websocket", "websocket-cached", "auto"],
				apply: (value) => {
					settings.setTransport(value as Transport);
					session.agent.transport = value as Transport;
				},
			},
			{
				label: "HTTP idle timeout",
				value: formatHttpIdleTimeoutMs(settings.getHttpIdleTimeoutMs()),
				choices: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
				apply: (value) => {
					const ms = HTTP_IDLE_TIMEOUT_CHOICES.find((choice) => choice.label === value)?.timeoutMs ?? 0;
					settings.setHttpIdleTimeoutMs(ms);
					configureHttpDispatcher(ms);
				},
			},
			{
				label: "Cache warming",
				value: settings.getCacheWarmingMode(),
				choices: CACHE_WARMING_MODES,
				apply: (value) => session.setCacheWarmingMode(value as CacheWarmingMode),
			},
			{
				label: "Auto-resize images",
				value: onOff(settings.getImageAutoResize()),
				apply: (value) => settings.setImageAutoResize(value === "on"),
			},
			{
				label: "Block images",
				value: onOff(settings.getBlockImages()),
				apply: (value) => settings.setBlockImages(value === "on"),
			},
			{
				label: "Skill commands",
				value: onOff(settings.getEnableSkillCommands()),
				apply: (value) => settings.setEnableSkillCommands(value === "on"),
			},
			{
				label: "Default project trust (next start)",
				value: TRUST_LABELS[settings.getDefaultProjectTrust()],
				choices: Object.values(TRUST_LABELS),
				apply: (value) => {
					const trust = (Object.keys(TRUST_LABELS) as DefaultProjectTrust[]).find(
						(key) => TRUST_LABELS[key] === value,
					);
					if (trust) settings.setDefaultProjectTrust(trust);
				},
			},
			{
				label: "Install telemetry",
				value: onOff(settings.getEnableInstallTelemetry()),
				apply: (value) => settings.setEnableInstallTelemetry(value === "on"),
			},
			{
				label: "Screen saver",
				value: this.saver,
				choices: ["off", "blank", "progress", "matrix"],
				apply: (value) => {
					if (isSaverMode(value)) this.saver = value;
					keepSaver();
				},
			},
			{
				label: "Screen saver after",
				value: `${this.saverMinutes} min`,
				choices: SAVER_WAITS.map((minutes) => `${minutes} min`),
				apply: (value) => {
					this.saverMinutes = Number.parseInt(value, 10);
					keepSaver();
				},
			},
		];
	}

	/** `/settings`: a toggle flips at once, a choice opens its values, and the list comes back where it was. */
	private showSettings(selected = 0): void {
		const rows = this.settingRows();
		this.openSelector(
			"Settings",
			rows.map((row, index) => ({ value: String(index), label: row.label, detail: row.value })),
			(item) => {
				const index = Number(item.value);
				const row = rows[index]!;
				const back = (): void => this.showSettings(index);
				const apply = (value: string): void => {
					try {
						row.apply(value);
					} catch (error) {
						this.notice("error", errorMessage(error));
					}
					back();
				};
				if (row.open) row.open(back);
				else if (!row.choices) apply(row.value === "on" ? "off" : "on");
				else {
					this.openSelector(
						row.label,
						row.choices.map((choice) => ({
							value: choice,
							label: choice,
							detail: choice === row.value ? "current" : undefined,
						})),
						(choice) => apply(choice.value),
						back,
						Math.max(0, row.choices.indexOf(row.value)),
					);
				}
			},
			undefined,
			selected,
		);
	}

	/** The default thinking level per model: a model, then its level, or back to the global default. */
	private showModelThinking(back: () => void, selected = 0): void {
		const session = this.session;
		const settings = session.settingsManager;
		const current = session.model;
		const models = [...session.modelRuntime.getAvailableSnapshot()].sort(
			(left, right) =>
				Number(right === current) - Number(left === current) || left.provider.localeCompare(right.provider),
		);
		if (models.length === 0) {
			this.notice("warning", "No models available");
			back();
			return;
		}
		this.openSelector(
			"Thinking per model",
			models.map((model, index) => ({
				value: String(index),
				label: `${model.id} [${model.provider}]`,
				detail: settings.getModelThinkingLevel(model.provider, model.id),
			})),
			(item) => {
				const index = Number(item.value);
				const model = models[index]!;
				const set = settings.getModelThinkingLevel(model.provider, model.id);
				const levels: string[] = model.reasoning ? [...getSupportedThinkingLevels(model)] : ["off"];
				if (set) levels.push("(clear)");
				const again = (): void => this.showModelThinking(back, index);
				this.openSelector(
					`Thinking for ${model.id}`,
					levels.map((level) => ({ value: level, label: level, detail: level === set ? "current" : undefined })),
					(choice) => {
						const isCurrent = model === session.model;
						if (choice.value === "(clear)") {
							settings.removeModelThinkingLevel(model.provider, model.id);
							if (isCurrent)
								session.setThinkingLevel(settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
						} else {
							const level = choice.value as Parameters<typeof session.setThinkingLevel>[0];
							settings.setModelThinkingLevel(model.provider, model.id, level);
							if (isCurrent) session.setThinkingLevel(level);
						}
						this.refreshFooter();
						again();
					},
					again,
					Math.max(0, set ? levels.indexOf(set) : 0),
				);
			},
			back,
			selected,
		);
	}

	/**
	 * `/scoped-models`: which models next-model (F18) goes through, in order; the session follows each change at once,
	 * and "Save" keeps it in settings.
	 */
	private showScopedModels(enabled?: string[] | null, selected = 0, unsaved = false): void {
		const session = this.session;
		const models = session.modelRuntime.getAvailableSnapshot();
		const key = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;
		const ids = models.map(key);
		let scope = enabled;
		if (scope === undefined) {
			if (session.scopedModels.length > 0) scope = session.scopedModels.map((scoped) => key(scoped.model));
			else {
				const patterns = session.settingsManager.getEnabledModels();
				scope = patterns?.length
					? resolveModelScopeFromModels(patterns, models).scopedModels.map((scoped) => key(scoped.model))
					: null;
			}
		}
		const on = (id: string): boolean => scope === null || (scope?.includes(id) ?? false);
		const all = (list: string[] | null): boolean => list === null || ids.every((id) => list.includes(id));
		const apply = (next: string[] | null, index: number): void => {
			const usable = next?.filter((id) => ids.includes(id)) ?? [];
			session.setScopedModels(
				next === null || all(next) || usable.length === 0
					? []
					: resolveModelScopeFromModels(usable, models).scopedModels.map((scoped) => ({
							model: scoped.model,
							thinkingLevel: scoped.thinkingLevel,
						})),
			);
			this.showScopedModels(all(next) ? null : next, index, true);
		};
		const count = scope === null ? "all" : `${scope.filter((id) => ids.includes(id)).length}/${ids.length}`;
		const actions = [
			{ value: "save", label: unsaved ? "Save to settings (unsaved)" : "Save to settings", detail: count },
			{ value: "all", label: "Enable all" },
			{ value: "none", label: "Clear all" },
		];
		const ordered = [...ids].sort((left, right) => {
			const rank = (id: string): number =>
				scope === null ? 0 : scope.includes(id) ? scope.indexOf(id) : ids.length;
			return rank(left) - rank(right);
		});
		const mark = this.charset.pick("◆", "*");
		this.openSelector(
			"Scoped models",
			[...actions, ...ordered.map((id) => ({ value: id, label: `${on(id) ? mark : " "} ${id}` }))],
			(item) => {
				const index =
					item.value === "save" || item.value === "all" || item.value === "none"
						? actions.findIndex((action) => action.value === item.value)
						: actions.length + ordered.indexOf(item.value);
				if (item.value === "save") {
					session.settingsManager.setEnabledModels(scope === null || all(scope) ? undefined : [...scope]);
					this.flash("Model selection saved to settings");
					this.showScopedModels(scope, index, false);
				} else if (item.value === "all") apply(null, index);
				else if (item.value === "none") apply([], index);
				else if (scope === null)
					apply(
						ids.filter((id) => id !== item.value),
						index,
					);
				else
					apply(
						scope.includes(item.value) ? scope.filter((id) => id !== item.value) : [...scope, item.value],
						index,
					);
			},
			undefined,
			selected,
		);
	}

	private startActivity(text: string): AbortController {
		const controller = new AbortController();
		this.activity = { text, controller };
		this.requestRender();
		return controller;
	}

	private endActivity(controller: AbortController): void {
		if (this.activity?.controller === controller) this.activity = undefined;
		this.requestRender();
	}

	/** `/share`: the session to Radius when signed in there, otherwise as a secret gist through gh, as pi shares. */
	private async shareSession(): Promise<void> {
		const session = this.session;
		const dir = mkdtempSync(join(tmpdir(), "pi-share-"));
		const controller = this.startActivity("Sharing");
		try {
			const jsonl = join(dir, "session.jsonl");
			exportSessionForShare(jsonl, session);
			const token = session.modelRuntime.getProvider(RADIUS_PROVIDER_ID)
				? getAuthCredential(
						await session.modelRuntime.getAuth(RADIUS_PROVIDER_ID, { minOAuthValidityMs: 5 * 60_000 }),
					)
				: undefined;
			if (token) {
				if (this.activity) this.activity.text = "Uploading to Radius";
				const body = readFileSync(jsonl);
				const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
				url.searchParams.set("visibility", "organization");
				url.searchParams.set("title", "Pi session");
				const response = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/x-ndjson",
						"Content-Length": String(body.byteLength),
					},
					body,
					signal: controller.signal,
				});
				const json = (await response.json().catch(() => null)) as {
					artifact?: { canonical_url: string };
					error?: string;
				} | null;
				if (!response.ok || !json?.artifact) {
					throw new Error(
						`Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`,
					);
				}
				this.notice("info", `Share URL: ${json.artifact.canonical_url}`);
				return;
			}
			const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (auth.error) throw new Error("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			if (auth.status !== 0) throw new Error("GitHub CLI is not logged in. Run 'gh auth login' first.");
			const html = join(dir, "session.html");
			await session.exportToHtml(html);
			if (this.activity) this.activity.text = "Creating gist";
			const gist = await new Promise<string>((resolve, reject) => {
				const child = spawn("gh", ["gist", "create", "--public=false", html]);
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (data: Buffer) => {
					stdout += data.toString();
				});
				child.stderr.on("data", (data: Buffer) => {
					stderr += data.toString();
				});
				controller.signal.addEventListener("abort", () => child.kill(), { once: true });
				child.on("error", reject);
				child.on("close", (code) =>
					code === 0
						? resolve(stdout.trim())
						: reject(new Error(`Failed to create gist: ${stderr.trim() || "Unknown error"}`)),
				);
			});
			const id = gist.split("/").pop();
			if (!id) throw new Error("Failed to parse gist ID from gh output");
			this.notice("info", `Share URL: ${getShareViewerUrl(id)}`);
			this.notice("info", `Gist: ${gist}`);
		} catch (error) {
			if (controller.signal.aborted) this.flash("Share cancelled");
			else this.notice("error", errorMessage(error));
		} finally {
			this.endActivity(controller);
			rmSync(dir, { recursive: true, force: true });
		}
	}

	/** `/bug [what went wrong]`: pi's bug report with the same consents, uploaded or written here as a zip. */
	private async reportBug(hint: string): Promise<void> {
		const session = this.session;
		const cancelled = (): void => this.flash("Bug report cancelled");
		this.notice("info", BUG_REPORT_DISCLAIMER);
		const description = await this.ask("What went wrong? (optional)", hint);
		if (description === undefined) return cancelled();
		this.notice("info", BUG_REPORT_TRANSCRIPT_NOTE);
		const transcript = await this.choose("Include the session transcript?", ["Yes, include the transcript", "No"]);
		if (transcript === undefined) return cancelled();
		const includeSession = transcript !== "No";
		let includeSummary = false;
		const model = session.model;
		if (!includeSession) {
			this.notice(
				"info",
				`The transcript is sent to ${model?.provider ?? "your provider"} with your credentials and tokens. Only the generated summary is attached; the transcript stays on your machine.`,
			);
			const choice = await this.choose(
				`Attach a summary written by ${model?.name ?? "the current model"} instead?`,
				["Yes, generate a summary", "No"],
			);
			if (choice === undefined) return cancelled();
			includeSummary = choice !== "No";
		}
		this.notice(
			"info",
			`Description: ${description || "none"}. Transcript ${includeSession ? "included" : "not included"}, summary ${includeSummary ? `written by ${model?.name ?? "the model"}` : "none"}. Upload sends the report to ${new URL(getRadiusGatewayUrl()).host}; export writes a zip archive in the current directory.`,
		);
		const delivery = await this.choose("Bug report", ["Upload Report", "Export as Zip", "Cancel"]);
		if (delivery === undefined || delivery === "Cancel") return cancelled();
		const options: BugReportOptions = {
			hint: description || undefined,
			includeSession,
			includeSummary,
			delivery: delivery === "Upload Report" ? "upload" : "zip",
		};
		if (options.delivery === "upload" && process.env.PI_OFFLINE) {
			this.notice("error", "Uploading bug reports requires online mode. Use Export as Zip instead.");
			return;
		}
		let summary: string | undefined;
		if (includeSummary) {
			const controller = this.startActivity(`Writing summary with ${model?.name ?? "the model"}`);
			try {
				summary = await session.summarizeForBugReport({ hint: options.hint, signal: controller.signal });
			} catch (error) {
				if (controller.signal.aborted) cancelled();
				else this.notice("error", `Failed to write bug report summary: ${errorMessage(error)}`);
				return;
			} finally {
				this.endActivity(controller);
			}
		}
		let bundle: ReturnType<typeof buildBugReport>;
		try {
			bundle = buildBugReport(session, options, summary);
		} catch (error) {
			this.notice("error", `Failed to build bug report: ${errorMessage(error)}`);
			return;
		}
		if (options.delivery === "upload") {
			const controller = this.startActivity("Uploading bug report");
			let failure: string | undefined;
			try {
				const token = session.modelRuntime.getProvider(RADIUS_PROVIDER_ID)
					? getAuthCredential(
							await session.modelRuntime.getAuth(RADIUS_PROVIDER_ID, { minOAuthValidityMs: 5 * 60_000 }),
						)
					: undefined;
				const result = await uploadBugReport(bundle, { token, signal: controller.signal });
				recordBugReport(session, bundle, { delivery: "upload" });
				this.notice("info", `Bug report uploaded. Report ID: ${result.id}`);
				return;
			} catch (error) {
				if (controller.signal.aborted) return cancelled();
				failure = errorMessage(error);
			} finally {
				this.endActivity(controller);
			}
			this.notice("warning", failure);
			if (
				(await this.choose("Upload failed: export as a zip instead?", ["Export as Zip", "Cancel"])) !==
				"Export as Zip"
			) {
				return cancelled();
			}
		}
		const archive = join(process.cwd(), bugReportArchiveFileName(bundle.metadata.id));
		try {
			await writeBugReportArchive(bundle, archive);
		} catch (error) {
			this.notice("error", `Failed to write bug report: ${errorMessage(error)}`);
			return;
		}
		recordBugReport(session, bundle, { delivery: "zip", path: archive });
		this.notice("info", `Bug report exported to ${archive}, report ID ${bundle.metadata.id}`);
	}

	/** An open dialog gives way to a new one, answering as cancelled, so no extension waits on it forever. */
	private cancelDialog(): void {
		const mode = this.mode;
		if (mode.kind === "selector") {
			this.mode = { kind: "normal" };
			mode.onCancel?.();
		} else if (mode.kind === "prompt" && !mode.auth) {
			this.mode = { kind: "normal" };
			mode.reject(new Error("Cancelled"));
		}
	}

	/** An extension's list: the title's first line on the selector, the rest as a notice. */
	private dialogSelect(title: string, options: readonly string[], signal: AbortSignal): Promise<number | undefined> {
		this.cancelDialog();
		const [heading = "", ...rest] = title.split("\n");
		const more = rest.join(" ").trim();
		if (more) this.notice("info", more);
		return new Promise((resolve) => {
			if (signal.aborted) {
				resolve(undefined);
				return;
			}
			const end = (index: number | undefined): void => {
				signal.removeEventListener("abort", abort);
				resolve(index);
			};
			const abort = (): void => {
				if (this.mode.kind === "selector" && this.mode.title === heading) this.mode = { kind: "normal" };
				this.requestRender();
				end(undefined);
			};
			signal.addEventListener("abort", abort, { once: true });
			this.openSelector(
				heading,
				options.map((option, index) => ({ value: String(index), label: option })),
				(item) => end(Number(item.value)),
				() => end(undefined),
			);
		});
	}

	private dialogInput(title: string, initial: string, signal: AbortSignal): Promise<string | undefined> {
		this.cancelDialog();
		if (signal.aborted) return Promise.resolve(undefined);
		const answer = this.ask(title, initial);
		const abort = (): void => {
			if (this.mode.kind === "prompt" && this.mode.message === title) this.cancelDialog();
		};
		signal.addEventListener("abort", abort, { once: true });
		return answer.finally(() => signal.removeEventListener("abort", abort));
	}

	/** One of `options` from the selector; undefined when cancelled. */
	private choose(title: string, options: readonly string[]): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.openSelector(
				title,
				options.map((option) => ({ value: option, label: option })),
				(item) => resolve(item.value),
				() => resolve(undefined),
			);
		});
	}

	/** A line of text from the prompt; undefined when cancelled. */
	private ask(message: string, initial = ""): Promise<string | undefined> {
		return new Promise((resolve) => {
			const editor = new LineEditor();
			if (initial) editor.setText(initial);
			this.mode = { kind: "prompt", message, editor, resolve, reject: () => resolve(undefined) };
			this.requestRender();
		});
	}

	/** Yes or no, from the selector; cancelling is no. */
	private confirm(title: string): Promise<boolean> {
		return new Promise((resolve) => {
			this.openSelector(
				title,
				[
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
				(item) => resolve(item.value === "yes"),
				() => resolve(false),
			);
		});
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
			if (mode.auth) this.loginController?.abort();
			mode.reject(new Error(mode.auth ? "Sign-in cancelled" : "Cancelled"));
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
		if (this.outbox.length > 0 || !this.roomOnLine()) {
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
		if (this.outbox.length > 0 || !this.roomOnLine()) {
			this.framePending = true;
			return;
		}
		const parts = this.renderer.renderParts(this.compose());
		if (parts.length > 0 && !this.syncRequest) this.io.write(parts.join(""));
		else if (parts.length > 0) {
			// an emulator takes a whole frame at once; a DEC terminal gets the scroll by itself first, so the next glide
			// waits in the terminal while it still draws the frame before
			const head = this.renderer.scrollEnd;
			this.outbox = this.io.caps.unicode
				? [parts.join("")]
				: [...(head > 0 ? [parts.slice(0, head).join("")] : []), ...chunks(parts.slice(head), SYNC_CHUNK)];
			this.pump();
		}
		this.lastFrameAt = Date.now();
		this.scheduleAnimation();
	}

	/**
	 * Whether another frame may start out. An emulator takes two whole frames ahead; a DEC terminal a few hundred
	 * bytes, so a frame of small pieces can follow one still drawing, and the screen keeps moving.
	 */
	private roomOnLine(): boolean {
		if (this.io.caps.unicode) return this.unanswered.length < SYNC_WINDOW;
		return this.unanswered.reduce((sum, length) => sum + length, 0) < this.bytesWindow();
	}

	/** In-flight bytes a DEC terminal may have: two pieces, or a sixth of a second of a fast line, four at most. */
	private bytesWindow(): number {
		const line = Math.round((this.io.caps.bytesPerSecond ?? 0) * SYNC_WINDOW_SECONDS);
		return Math.min(2 * SYNC_BYTES_WINDOW, Math.max(SYNC_BYTES_WINDOW, line));
	}

	/** Send waiting pieces while they fit in the window, or the line is empty. */
	private pump(): void {
		const sync = this.syncRequest;
		if (!sync) return;
		const fits = (next: number): boolean => {
			if (this.unanswered.length === 0) return true;
			if (this.io.caps.unicode) return this.unanswered.length < SYNC_WINDOW;
			return this.unanswered.reduce((sum, length) => sum + length, 0) + next <= this.bytesWindow();
		};
		while (this.outbox.length > 0 && fits(this.outbox[0]!.length + sync.bytes.length)) {
			const bytes = this.outbox.shift()! + sync.bytes;
			// counted before writing: a terminal can answer before write returns
			this.unanswered.push(bytes.length);
			this.armSync();
			this.io.write(bytes);
		}
	}

	/** The terminal answered after the oldest piece still out, so it has drawn that one. */
	private answered(): void {
		if (this.unanswered.length === 0) return;
		this.unanswered.shift();
		this.armSync();
		this.pump();
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
			this.pump();
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
			this.summarizing ||
			this.activity !== undefined ||
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
		if (this.saving === "matrix" && this.rain && (this.rain.active || this.saverBusy())) {
			const status = statusLine ? [] : undefined;
			const shift = this.rain.takeFallen();
			return { lines: this.rain.lines(), status, scroll: { top: 0, bottom: rows - 1 }, smooth: true, shift };
		}
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
		if (mode === "matrix") {
			const { rows, columns, bytesPerSecond } = this.io.caps;
			// as dense as the line keeps smooth: a line of rain costs about 18 bytes and 10 more for each drop; the 64
			// the terminal takes in while it glides come free, the rest hold the next glide up, by 40 ms at most:
			// 12 drops at 19200 baud; and a drop for every ten columns at most, more reads as a wall
			const budget = Math.floor((64 - 18 + (bytesPerSecond ?? 1920) * 0.04) / 10);
			const drops = Math.max(6, Math.min(Math.floor(columns / 10), budget));
			this.rain = new MatrixRain(rows, columns, {
				maxDrops: drops,
				// two glints for every three drops
				glints: Math.max(3, Math.round((drops * 2) / 3)),
			});
			// a message streaming now starts the rain from a little way back
			this.rainSeen = Math.max(0, generatedText(this.streamingMessage()).length - 240);
			this.feedRain(this.streamingMessage());
			this.rainTimer = setInterval(() => this.rainTick(), RAIN_STEP_MS);
			// smooth scroll stays on while it rains, which spares ten bytes a line switching it around every glide
			if (!this.io.caps.smoothScroll) this.io.write("\x1b[?4h");
			this.renderer.setSmoothScroll(true);
		}
		this.moveSaver();
		if (mode === "progress" || mode === "matrix")
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
		clearInterval(this.rainTimer);
		this.rainTimer = undefined;
		if (this.rain) {
			// back to how Set-Up had it
			if (!this.io.caps.smoothScroll) this.io.write("\x1b[?4l");
			this.renderer.setSmoothScroll(this.io.caps.smoothScroll === true);
		}
		this.rain = undefined;
		if (this.io.caps.screenReverse) this.io.write("\x1b[?5h");
		this.armSaver();
		this.requestRender();
	}

	/** Words the model wrote since the last update, into the rain. */
	private feedRain(message: AssistantMessage | undefined): void {
		if (!this.rain) return;
		const text = generatedText(message);
		if (text.length < this.rainSeen) this.rainSeen = 0;
		if (text.length === this.rainSeen) return;
		this.rain.feed(this.charset.cells(text.slice(this.rainSeen).replace(/\s+/g, " ")));
		this.rainSeen = text.length;
	}

	/**
	 * The rain falls a line while the terminal still glides the last, so one scroll follows another without a pause.
	 * Working without writing, a lone π falls; once all is done the rain drains off and the π line comes back.
	 */
	private rainTick(): void {
		const rain = this.rain;
		// one line a frame: lines fallen faster than frames go out would scroll several at once, which jumps
		if (!rain || rain.undrawn > 0 || this.outbox.length > 0 || !this.roomOnLine()) return;
		const busy = this.saverBusy();
		if (!rain.raining && !busy && !rain.active) return;
		rain.step(busy ? this.charset.cells("π") : undefined);
		if (!rain.active && !busy) this.moveSaver();
		this.requestRender();
	}

	/** Work goes on, or waits for an answer, without anything to rain. */
	private saverBusy(): boolean {
		return (
			this.mode.kind === "prompt" ||
			this.mode.kind === "selector" ||
			this.retry !== undefined ||
			this.compacting !== undefined ||
			this.working
		);
	}

	private streamingMessage(): AssistantMessage | undefined {
		const content = this.streaming?.content;
		return content?.kind === "assistant" ? content.message : undefined;
	}

	/** The progress saver's line: how the work goes while it runs, and only π once it is done. */
	private saverLine(): number[] | undefined {
		if (this.saving !== "progress" && this.saving !== "matrix") return undefined;
		const now = Date.now();
		let text = "";
		if (this.mode.kind === "prompt" || this.mode.kind === "selector") text = "Waiting for you";
		else if (this.retry) text = `Retrying in ${formatDuration(Math.max(0, this.retry.until - now) / 1000)}`;
		else if (this.compacting) text = "Compacting";
		else if (this.working) {
			const speed = this.speed.display;
			const approximate = speed?.approximate ? this.charset.pick("≃", "~") : "";
			const rate = speed ? ` · ${approximate}${formatRate(speed.rate)} tok/s` : "";
			text = `Working ${formatDuration((now - this.workingSince) / 1000)}${rate}`;
		}
		return this.charset.cells(text ? `π ${text}` : "π");
	}

	/**
	 * `/screensaver` with a mode keeps it as the setting, and with minutes the wait; without minutes, or with 0, it
	 * starts at once.
	 */
	private screensaverCommand(args: string): void {
		let now = true;
		let changed = false;
		for (const word of args.split(/\s+/).filter((part) => part !== "")) {
			const minutes = Number(word);
			if (isSaverMode(word)) {
				this.saver = word;
				changed = true;
			} else if (Number.isFinite(minutes) && minutes > 0) {
				this.saverMinutes = minutes;
				now = false;
				changed = true;
			} else if (minutes !== 0) {
				this.notice("warning", "Usage: /screensaver [off|blank|progress|matrix] [minutes]");
				return;
			}
		}
		if (changed) {
			try {
				this.options.saveSettings?.({ screensaver: this.saver, screensaverMinutes: this.saverMinutes });
			} catch (error) {
				this.notice("error", `Cannot keep the setting: ${errorMessage(error)}`);
			}
		}
		this.armSaver();
		if (this.saver === "off" && changed) this.flash("Screen saver off");
		else if (now) this.startSaver(this.saver === "off" ? "progress" : this.saver);
		else this.flash(`Screen saver: ${this.saver} after ${this.saverMinutes} min`);
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
		if (this.summarizing) return `Summarizing branch ${spinner} · ${interrupt} stop`;
		if (this.activity) return `${this.activity.text} ${spinner} · ${interrupt} stop`;
		if (this.working) {
			const seconds = Math.floor((now - this.workingSince) / 1000);
			const word = this.workingWord ?? "Working";
			return `${word} ${spinner}${seconds > 0 ? ` ${formatDuration(seconds)}` : ""} · ${interrupt} stop`;
		}
		if (this.bashRunning) return `Running ${spinner} · ${interrupt} stop`;
		return this.extensionStatus;
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
