import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { Vt420App, type Vt420AppOptions, type Vt420Io, type Vt420Runtime } from "../src/experimental/vt420/app.ts";
import { type InputEvent, InputParser, type TerminalResponse } from "../src/experimental/vt420/input.ts";
import { Keymap } from "../src/experimental/vt420/keys.ts";
import { charsetDesignations, SESSION_MODES, statusLineType } from "../src/experimental/vt420/sequences.ts";
import type { TerminalCapabilities } from "../src/experimental/vt420/terminal.ts";
import { formatTokens } from "../src/experimental/vt420/widgets.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { EMU_BOLD, EMU_REVERSE, EMU_UNDERLINE, type EmulatorOptions, Vt420Emulator } from "./vt420-emulator.ts";

interface Line {
	/** How long the terminal takes to answer; a line that loses answers never does. */
	answerDelayMs?: number;
	drop?: boolean;
}

interface Running {
	emulator: Vt420Emulator;
	output: string[];
	/** Frame requests sent and answered, and the most unanswered at once. */
	line: { requests: number; answers: number; mostAhead: number };
	/** Entries the app asked the runtime to fork from. */
	forks: string[];
	done: Promise<void>;
	input(event: InputEvent): void;
	key(key: string): Promise<void>;
	type(text: string): Promise<void>;
	submit(text: string): Promise<void>;
	screen(): string;
}

const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForIdle(harness: Harness): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (!harness.session.isStreaming && harness.getPendingResponseCount() === 0) break;
		await settle(10);
	}
	await settle();
}

async function start(
	harness: Harness,
	caps: Partial<TerminalCapabilities> = {},
	statusState?: EmulatorOptions["statusState"],
	line?: Line,
	extra: Partial<Vt420AppOptions> = {},
): Promise<Running> {
	const capabilities: TerminalCapabilities = {
		rows: 24,
		columns: 80,
		level: 4,
		name: "VT420",
		technical: true,
		statusLine: true,
		rectangularOps: true,
		eraseCharacters: true,
		supplemental: "dec",
		eightBit: false,
		unicode: false,
		...caps,
	};
	const counts = { requests: 0, answers: 0, mostAhead: 0 };
	const forks: string[] = [];
	let respond: ((response: TerminalResponse) => void) | undefined;
	const answers = new InputParser({
		onEvent: (event) => {
			if (event.type !== "response") return;
			counts.answers++;
			respond?.(event.response);
		},
	});
	const emulator = new Vt420Emulator({
		rows: capabilities.rows,
		columns: capabilities.columns,
		utf8: capabilities.unicode,
		statusState,
		lineAttributes: capabilities.doubleSize !== false,
		onResponse: (bytes) => {
			if (line && !line.drop) setTimeout(() => answers.feed(bytes), line.answerDelayMs ?? 0);
		},
	});
	emulator.feed(
		SESSION_MODES +
			charsetDesignations({
				technical: capabilities.technical,
				supplemental: capabilities.supplemental,
				eightBit: false,
			}) +
			(capabilities.statusLine ? statusLineType(2) : ""),
	);
	const output: string[] = [];
	let listener: ((event: InputEvent) => void) | undefined;
	const io: Vt420Io = {
		caps: capabilities,
		backlogMs: 0,
		write: (bytes) => {
			output.push(bytes);
			counts.requests += bytes.match(/\x1b\[5n|\x1b\[c/g)?.length ?? 0;
			counts.mostAhead = Math.max(counts.mostAhead, counts.requests - counts.answers);
			emulator.feed(Buffer.from(bytes, capabilities.unicode ? "utf8" : "latin1"));
		},
		onInput: (handler) => {
			listener = handler;
		},
		onResize: () => {},
		...(line
			? {
					onResponse: (handler: ((response: TerminalResponse) => void) | undefined) => {
						respond = handler;
					},
				}
			: {}),
	};
	const runtime: Vt420Runtime = {
		get session() {
			return harness.session;
		},
		cwd: harness.tempDir,
		newSession: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		fork: async (entryId) => {
			forks.push(entryId);
			return { cancelled: false, selectedText: "picked again" };
		},
		importFromJsonl: async () => ({ cancelled: false }),
		services: { agentDir: harness.tempDir },
		setRebindSession: () => {},
	};
	const app = new Vt420App({
		runtime,
		io,
		keymap: new Keymap(),
		version: "test",
		pasteWindowMs: 0,
		animationFps: 20,
		...extra,
	});
	const done = app.run();
	await settle();
	const send = async (event: InputEvent): Promise<void> => {
		listener?.(event);
		await settle();
	};
	return {
		emulator,
		output,
		line: counts,
		forks,
		done,
		input: (event) => listener?.(event),
		key: (key) => send({ type: "key", key }),
		type: (text) => send({ type: "text", text }),
		submit: async (text) => {
			await send({ type: "text", text });
			await send({ type: "key", key: "return" });
		},
		screen: () => emulator.screen().join("\n"),
	};
}

const echoBash: AgentTool = {
	name: "bash",
	label: "bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String() }),
	execute: async (_id, params) => {
		const command = (params as { command: string }).command;
		if (command.startsWith("false")) throw new Error("boom\nCommand exited with code 2");
		return { content: [{ type: "text", text: "line one\nline two" }], details: {} };
	},
};

const fakeEdit: AgentTool = {
	name: "edit",
	label: "edit",
	description: "Edit a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
		details: { diff: "-1 old line\n+1 new line\n+2 added" },
	}),
};

describe("vt420 app", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("shows the double-height banner and a status line footer", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// A status line with its own designations, which only shows special characters if they are redone there.
		const app = await start(harness, {}, "isolated");
		expect(app.emulator.lineAttr(0)).toBe(2);
		expect(app.emulator.lineAttr(1)).toBe(3);
		expect(app.emulator.text(0)).toBe(" π");
		expect(app.emulator.text(2)).toContain("⎧ VT420 80x24 + status line · pi test");
		expect(app.emulator.text(4)).toContain("⎩ Help keys · /help commands");
		const window = formatTokens(harness.getModel().contextWindow);
		// Right-aligned against the last column but one, leaving the left side under the prompt empty.
		expect(app.emulator.statusText()).toMatch(new RegExp(`^ {20,}↑0 ↓0 · ·+ 0/${window} · \\S+$`));
		expect(app.emulator.statusText()).toHaveLength(79);
		expect(app.emulator.statusText()).not.toContain("π");
		expect(app.emulator.statusText()).not.toContain("$");
		expect(app.emulator.statusText()).not.toContain(harness.getModel().id);
		expect(app.emulator.status.attrs.every((attrs) => attrs === 0)).toBe(true);
		expect(app.emulator.text(2)).toContain("⎧ VT420");
		await app.key("ctrl+d");
		await app.done;
	});

	it("paces its frames by the terminal's answers, never more than two ahead", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const app = await start(harness, { deviceStatus: true }, undefined, { answerDelayMs: 40 });
		for (let typed = 0; typed < 50; typed++) {
			app.input({ type: "text", text: "x" });
			await settle(4);
		}
		await settle(300);
		expect(app.line.mostAhead).toBe(2);
		// fewer frames than keys, the last showing all of them
		expect(app.line.requests).toBeLessThan(30);
		expect(app.screen()).toContain("x".repeat(50));
		// DSR, whose answer is a few bytes, rather than DA1
		expect(app.output.join("")).not.toContain("\x1b[c");
		await app.key("ctrl+c");
		await app.key("ctrl+d");
		await app.done;
	});

	it("sends a whole page to a DEC terminal in answered pieces, never more than two out", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const app = await start(harness, { deviceStatus: true }, undefined, { answerDelayMs: 30 });
		const before = app.output.length;
		await app.key("help");
		await settle(1500);
		const sent = app.output.slice(before);
		expect(sent.length).toBeGreaterThanOrEqual(4);
		// pieces of about 160 bytes, each with its request, two at most on the line
		expect(Math.max(...sent.map((piece) => piece.length))).toBeLessThanOrEqual(200);
		expect(sent.every((piece) => piece.endsWith("\x1b[5n"))).toBe(true);
		expect(app.line.mostAhead).toBeLessThanOrEqual(2);
		expect(app.screen()).toContain("send, steer while working");
		await app.key("f11");
		await app.key("ctrl+d");
		await app.done;
	});

	it("paces with DA1 when the terminal does not answer DSR, and gets past a lost answer", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const da1 = await start(harness, {}, undefined, { answerDelayMs: 5 });
		da1.input({ type: "text", text: "hello" });
		await settle(100);
		expect(da1.output.join("")).toContain("\x1b[c");
		expect(da1.line.answers).toBe(da1.line.requests);
		await da1.key("ctrl+c");
		await da1.key("ctrl+d");
		await da1.done;

		const lost = await start(harness, { deviceStatus: true, bytesPerSecond: 1_000_000 }, undefined, { drop: true });
		lost.input({ type: "text", text: "a" });
		await settle(40);
		lost.input({ type: "text", text: "b" });
		await settle(40);
		// the first frame and the "a" are out unanswered, so the "b" waits
		expect(lost.screen()).not.toContain("ab");
		await settle(1200);
		expect(lost.screen()).toContain("ab");
		await lost.key("ctrl+c");
		await lost.key("ctrl+d");
		await lost.done;
	}, 10_000);

	it("darkens the screen after a spell without keys, and the key that wakes it does nothing else", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const app = await start(harness, {}, undefined, undefined, { screensaver: "blank", screensaverMinutes: 0.003 });
		expect(app.emulator.text(2)).toContain("VT420");
		await settle(300);
		expect(app.emulator.screen().every((row) => row === "")).toBe(true);
		expect(app.emulator.statusText().trim()).toBe("");
		expect(app.emulator.cursorVisible).toBe(false);
		await app.type("x");
		expect(app.emulator.text(2)).toContain("VT420");
		expect(app.screen()).not.toContain("π x");
		await app.key("ctrl+d");
		await app.done;
	});

	it("shows how the work goes, somewhere else every so often, and /screensaver keeps its setting", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const saved: unknown[] = [];
		const app = await start(harness, {}, undefined, undefined, {
			screensaver: "off",
			saverMoveMs: 60,
			saveSettings: (settings) => saved.push(settings),
		});
		await app.submit("/screensaver progress 0.003");
		expect(saved).toEqual([{ screensaver: "progress", screensaverMinutes: 0.003 }]);
		await settle(300);
		const places = new Set<string>();
		for (let look = 0; look < 6; look++) {
			const rows = app.emulator.screen();
			const lit = rows.flatMap((row, index) => (row === "" ? [] : [{ row: index, text: row }]));
			expect(lit).toHaveLength(1);
			expect(lit[0]!.text.trim()).toBe("π");
			places.add(`${lit[0]!.row}:${lit[0]!.text.indexOf("π")}`);
			await settle(70);
		}
		expect(places.size).toBeGreaterThan(1);
		await app.key("f8");
		await settle(40);
		expect(app.emulator.text(2)).toContain("VT420");
		await app.key("ctrl+d");
		await app.done;
	});

	it("rains what the model writes down the screen, and starts at once without minutes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const saved: unknown[] = [];
		const app = await start(harness, {}, undefined, undefined, { saveSettings: (settings) => saved.push(settings) });
		// F20 rains at once without touching the setting; any key ends it
		await app.key("f20");
		expect(
			app.emulator
				.screen()
				.filter((row) => row !== "")
				.map((row) => row.trim()),
		).toEqual(["π"]);
		expect(saved).toEqual([]);
		await app.type("x");
		expect(app.emulator.text(2)).toContain("VT420");
		await app.submit("/screensaver matrix");
		expect(saved).toEqual([{ screensaver: "matrix", screensaverMinutes: 10 }]);
		// nothing generated yet: the π line alone
		expect(
			app.emulator
				.screen()
				.filter((row) => row !== "")
				.map((row) => row.trim()),
		).toEqual(["π"]);
		const before = app.output.length;
		harness.setResponses([fauxAssistantMessage("alpha bravo charlie delta echo foxtrot golf hotel india juliet")]);
		void harness.session.prompt("spell it");
		await settle(1500);
		const sent = app.output.slice(before).join("");
		// the screen moves down a line at a time, gliding, and words read top to bottom in their columns
		expect(sent).toContain("\x1b[?4h");
		expect(sent).toContain("\x1bM");
		const rows = app.emulator.screen();
		const columns = Array.from({ length: 80 }, (_, col) => rows.map((row) => row[col] ?? " ").join(""));
		const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
		expect(columns.some((text) => words.some((word) => text.includes(word)))).toBe(true);
		await app.type("x");
		expect(app.emulator.text(2)).toContain("VT420");
		await waitForIdle(harness);
		await app.key("ctrl+d");
		await app.done;
	});

	it("lets π fall alone while a tool works and there is nothing to rain", async () => {
		const slow: AgentTool = {
			name: "slow",
			label: "slow",
			description: "Take a while",
			parameters: Type.Object({}),
			execute: async () => {
				await settle(2000);
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [slow] });
		harnesses.push(harness);
		const app = await start(harness);
		await app.submit("/screensaver matrix");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		void harness.session.prompt("wait");
		await settle(800);
		const lit = (): string => app.emulator.screen().join("").replace(/\s/g, "");
		const where = (): number => app.emulator.screen().findIndex((row) => row.includes("π"));
		expect(lit()).toBe("π");
		const first = where();
		const before = app.output.length;
		await settle(300);
		expect(lit()).toBe("π");
		expect(where()).not.toBe(first);
		// it glides down with the screen rather than being written a line further each time
		expect(app.output.slice(before).join("")).toContain("\x1b[?4h");
		await app.type("x");
		await waitForIdle(harness);
		await app.key("ctrl+d");
		await app.done;
	});

	it("moves to an earlier point with /tree and forks from a message with /fork", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);
		const app = await start(harness);
		await app.submit("first question");
		await waitForIdle(harness);
		await app.submit("second question");
		await waitForIdle(harness);
		expect(app.screen()).toContain("answer two");
		await app.submit("/tree");
		expect(app.screen()).toContain("Session tree");
		await app.type("second question");
		await app.key("return");
		expect(app.screen()).toContain("Summarize the branch you leave?");
		await app.key("return");
		await settle(200);
		// back before the second question, which is in the editor again
		expect(app.screen()).not.toContain("answer two");
		expect(app.screen()).toContain("π second question");
		await app.key("ctrl+c");
		await app.submit("/fork");
		expect(app.screen()).toContain("Fork from message");
		await app.key("return");
		await settle(100);
		expect(app.forks).toHaveLength(1);
		expect(app.screen()).toContain("π picked again");
		await app.key("ctrl+c");
		await app.key("ctrl+d");
		await app.done;
	});

	it("changes settings from /settings: toggles flip, choices open their values", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const saved: unknown[] = [];
		const app = await start(harness, {}, undefined, undefined, { saveSettings: (settings) => saved.push(settings) });
		const autoCompact = harness.session.autoCompactionEnabled;
		await app.submit("/settings");
		expect(app.screen()).toContain("Steering mode");
		await app.key("return");
		expect(harness.session.autoCompactionEnabled).toBe(!autoCompact);
		// back on the same row, which shows the new value
		expect(app.screen()).toContain("Settings");
		await app.key("down");
		await app.key("return");
		expect(app.screen()).toContain("one-at-a-time");
		await app.type("all");
		await app.key("return");
		expect(harness.session.steeringMode).toBe("all");
		await app.type("screen saver");
		await app.key("return");
		await app.type("matrix");
		await app.key("return");
		expect(saved).toEqual([{ screensaver: "matrix", screensaverMinutes: 10 }]);
		await app.key("f11");
		await app.key("ctrl+d");
		await app.done;
	});

	it("picks the models next-model goes through with /scoped-models, and saves them", async () => {
		const harness = await createHarness({ models: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] });
		harnesses.push(harness);
		const app = await start(harness);
		await app.submit("/scoped-models");
		expect(app.screen()).toContain("Scoped models");
		await app.type("beta");
		await app.key("return");
		// from all models to all but beta, at once in the session
		expect(harness.session.scopedModels.map((scoped) => scoped.model.id).sort()).toEqual(["alpha", "gamma"]);
		await app.type("save");
		await app.key("return");
		expect(
			harness.settingsManager
				.getEnabledModels()
				?.map((id) => id.split("/").pop())
				.sort(),
		).toEqual(["alpha", "gamma"]);
		await app.type("enable all");
		await app.key("return");
		expect(harness.session.scopedModels).toHaveLength(0);
		await app.key("f11");
		await app.key("ctrl+d");
		await app.done;
	});

	it("walks through /bug with pi's consents", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const app = await start(harness);
		await app.submit("/bug the screen froze");
		expect(app.screen()).toContain("not shared publicly");
		// the description comes prefilled with what followed /bug
		expect(app.screen()).toContain("the screen froze");
		await app.key("return");
		expect(app.screen()).toContain("Include the session transcript?");
		await app.key("return");
		expect(app.screen()).toContain("Upload Report");
		await app.type("cancel");
		await app.key("return");
		expect(app.screen()).toContain("Bug report cancelled");
		await app.key("ctrl+d");
		await app.done;
	});

	it("runs extension commands with the frontend's dialogs, and lists them", async () => {
		const harness = await createHarness({
			extensionFactories: [
				{
					factory: (pi) => {
						pi.registerCommand("greet", {
							description: "say hello",
							handler: async (args, ctx) => {
								const who = await ctx.ui.select("Greet whom?", ["world", "VT420"]);
								const loud = await ctx.ui.confirm("Loudly?", "With an exclamation mark");
								ctx.ui.notify(`hello ${who}${loud ? "!" : ""} ${args}`.trim(), "info");
								ctx.ui.setStatus("greet", "greeted");
							},
						});
					},
				},
			],
		});
		harnesses.push(harness);
		const app = await start(harness);
		// completion and the help know it
		await app.type("/gre");
		await app.key("tab");
		expect(app.screen()).toContain("π /greet");
		await app.type("there");
		await app.key("return");
		await settle(100);
		expect(app.screen()).toContain("Greet whom?");
		await app.key("down");
		await app.key("return");
		await settle(50);
		expect(app.screen()).toContain("Loudly?");
		await app.key("return");
		await settle(100);
		expect(app.screen()).toContain("hello VT420! there");
		expect(app.screen()).toContain("greeted");
		await app.key("f14");
		await app.type("greet");
		expect(app.screen()).toContain("say hello");
		await app.key("f11");
		await app.key("ctrl+d");
		await app.done;
	});

	it("letter-spaces the banner and keeps headings at normal size without double-size lines", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("# Plan\n\nDone.")]);
		const app = await start(harness, { doubleSize: false, unicode: true, supplemental: "latin1" });
		expect(app.emulator.text(0)).toBe("  π");
		expect(app.emulator.text(1)).toBe("");
		expect(app.emulator.text(2)).toContain("⎧ VT420 80x24 + status line · UTF-8 · pi test");
		await app.submit("plan it");
		await waitForIdle(harness);
		expect(app.emulator.screen()).toContain("Plan");
		const planRow = app.emulator.screen().indexOf("Plan");
		expect(app.emulator.attrsAt(planRow, 0)).toBe(EMU_BOLD | EMU_UNDERLINE);
		expect(app.output.join("")).not.toContain("\x1b#");
		await app.key("ctrl+d");
		await app.done;
	});

	it("streams a conversation with tools into the transcript", async () => {
		const harness = await createHarness({ tools: [echoBash, fakeEdit] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("Consider the directory first"),
					fauxToolCall("bash", { command: "ls -la" }),
					fauxToolCall("bash", { command: "false && exit" }),
					fauxToolCall("edit", { path: `${harness.tempDir}/src/main.ts` }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done: **all good** → `ok`"),
		]);
		const app = await start(harness);
		await app.submit("list files");
		await waitForIdle(harness);
		const screen = app.screen();
		expect(screen).toContain("π list files");
		expect(screen).toContain("∴ Consider the directory first");
		expect(screen).toMatch(/\$ ls -la\s+√/);
		expect(screen).toContain("  │ line one");
		expect(screen).toContain("  └ line two");
		expect(screen).toMatch(/\$ false && exit\s+× exit 2/);
		expect(screen).toMatch(/Δ src\/main\.ts\s+√ \+2 -1/);
		expect(screen).toContain("  │ +1 new line");
		expect(screen).toContain("Done: all good → ok");
		// your message sits in a box whose edges replace the blank rows around it, with nothing inverted
		const rows = app.emulator.screen();
		const userRow = rows.findIndex((line) => line.startsWith("│ π list files"));
		expect(rows[userRow]).toMatch(/^│ π list files {60,}│$/);
		expect(rows[userRow - 1]).toMatch(/^┌─{78}┐$/);
		expect(rows[userRow + 1]).toMatch(/^└─{78}┘$/);
		expect(rows[userRow - 2]).not.toBe("");
		expect(rows[userRow + 2]).not.toBe("");
		for (let col = 0; col < 80; col++) expect(app.emulator.attrsAt(userRow, col) & EMU_REVERSE).toBe(0);
		expect(app.emulator.attrsAt(userRow, 2) & EMU_BOLD).toBe(EMU_BOLD);
		for (const chunk of app.output) for (const char of chunk) expect(char.charCodeAt(0)).toBeLessThan(0x80);
		await app.submit("/session");
		expect(app.screen()).toContain(`${harness.getModel().provider}/${harness.getModel().id}`);
		expect(app.screen()).toMatch(/tokens ↑\d/);
		expect(app.screen()).not.toMatch(/\$\d/);
		await app.key("ctrl+d");
		await app.done;
	});

	it("opens help, the model selector and the character set showcase", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const app = await start(harness);
		await app.key("help");
		expect(app.emulator.text(0)).toBe("Keys");
		expect(app.emulator.lineAttr(0)).toBe(1);
		expect(app.screen()).toContain("Do");
		await app.key("x");
		await app.key("pf2");
		expect(app.screen()).toContain("Select model");
		expect(app.screen()).toContain(`◆ ${harness.getModel().provider}/${harness.getModel().id}`);
		const rows = app.emulator.screen();
		const chosen = rows.findIndex((line) => line.includes(`◆ ${harness.getModel().provider}/`));
		for (let col = 0; col < 80; col++) expect(app.emulator.attrsAt(chosen, col) & EMU_REVERSE).toBe(0);
		const marker = rows[chosen]!.indexOf("◆");
		expect(app.emulator.attrsAt(chosen, marker) & EMU_BOLD).toBe(EMU_BOLD);
		expect(app.emulator.attrsAt(chosen, marker + 2) & EMU_BOLD).toBe(EMU_BOLD);
		await app.key("f11");
		expect(app.screen()).not.toContain("Select model");
		await app.submit("/charset");
		expect(app.screen()).toContain("Composite symbols");
		await app.key("find");
		expect(app.emulator.text(0)).toBe(" π");
		await app.key("ctrl+c");
		await app.key("ctrl+c");
		await app.done;
	});

	it("writes the footer as Unicode on a UTF-8 terminal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const app = await start(harness, { unicode: true, supplemental: "latin1" });
		expect(app.emulator.statusText()).toContain("↑0 ↓0 · ······ 0/");
		expect(app.emulator.text(2)).toContain("⎧ VT420");
		await app.key("ctrl+d");
		await app.done;
	});

	it("uses words instead of missing DEC Technical glyphs", async () => {
		const harness = await createHarness({ tools: [echoBash] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "ls" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const app = await start(harness, { technical: false });
		expect(app.emulator.statusText()).toContain("in 0 out 0 · ");
		expect(app.emulator.statusText()).not.toMatch(/\^0|v0|\$/);
		await app.submit("go");
		await waitForIdle(harness);
		expect(app.screen()).toMatch(/\$ ls\s+ok/);
		await app.key("ctrl+d");
		await app.done;
	});

	it("falls back to a footer row without a host-writable status line", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const app = await start(harness, { statusLine: false, technical: false });
		expect(app.emulator.text(23)).toMatch(/^ {20,}in 0 out 0 · /);
		expect(app.emulator.attrsAt(23, 0) & EMU_REVERSE).toBe(0);
		expect(app.emulator.text(2)).toContain("/ VT420 80x24");
		await app.key("f10");
		await app.done;
	});
});
