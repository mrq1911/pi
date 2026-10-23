import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ATTR_BOLD, LINE_SINGLE, type Line } from "@mrq/vt420/cells.js";
import { Charset } from "@mrq/vt420/charset.js";
import { type Frame, Renderer } from "@mrq/vt420/renderer.js";
import { charsetDesignations, SESSION_MODES } from "@mrq/vt420/sequences.js";
import { linesText, Vt420Emulator } from "@mrq/vt420-emu/emulator.js";
import { describe, expect, it } from "vitest";
import { traceCells } from "../src/experimental/vt420/scope.ts";
import {
	type RenderContext,
	type ToolState,
	Transcript,
	TranscriptBlock,
} from "../src/experimental/vt420/transcript.ts";
import { tokenCounts } from "../src/experimental/vt420/widgets.ts";

const WIDTH = 40;
const THINKING =
	"**Reading the footer**\n\nThe user wants the footer on the right.\nI will check footerCells, then the tests";

const charset = new Charset({ technical: true, supplemental: "dec", eightBit: false });

function context(showThinking = false): RenderContext {
	return {
		width: WIDTH,
		charset,
		cwd: "/work",
		home: "/home/user",
		showThinking,
		expandTools: false,
		foldSteps: true,
		foldAfter: 0,
		largeHeadings: true,
		tick: 0,
		now: 0,
		key: () => "PF2",
	};
}

function reply(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function thinkingBlock(thinking: string, streaming: boolean): TranscriptBlock {
	return new TranscriptBlock(1, {
		kind: "assistant",
		message: reply([{ type: "thinking", thinking }]),
		streaming,
	});
}

describe("vt420 transcript thinking", () => {
	it("settles on how long it thought once it is done, or else how many tokens", () => {
		const answering = new TranscriptBlock(1, {
			kind: "assistant",
			message: reply([
				{ type: "thinking", thinking: THINKING },
				{ type: "text", text: "Done." },
			]),
			streaming: true,
			thinkingTimes: new Map([[0, { since: 1000, until: 93_400 }]]),
		});
		expect(linesText(answering.render(context()))).toEqual(["∴ Thought for 1 min 32 sec", "", "Done."]);
		expect(linesText(thinkingBlock(THINKING, false).render(context()))).toEqual(["∴ Thought for ≃26 tokens"]);
		const counted = (content: AssistantMessage["content"]): string[] =>
			linesText(
				new TranscriptBlock(1, {
					kind: "assistant",
					message: { ...reply(content), usage: { ...reply([]).usage, output: 1500, reasoning: 1234 } },
					streaming: false,
				}).render(context()),
			);
		expect(counted([{ type: "thinking", thinking: THINKING }])).toEqual(["∴ Thought for 1.2k tokens"]);
		const twice = counted([
			{ type: "thinking", thinking: "one" },
			{ type: "toolCall", id: "a", name: "ls", arguments: {} },
			{ type: "thinking", thinking: "two two two" },
		]);
		expect(twice).toEqual(["∴ Thought for ≃1 token", "∴ Thought for ≃3 tokens"]);
		expect(linesText(thinkingBlock("", false).render(context()))).toEqual(["∴ Thought"]);
		const expanded = linesText(thinkingBlock(THINKING, false).render(context(true)));
		expect(expanded[0]).toBe("∴ **Reading the footer**");
		expect(expanded.length).toBeGreaterThan(3);
	});

	it("rolls live thinking up two rows, a scroll for each line it fills, smooth where the terminal glides", () => {
		// a hole in each margin of every line, like continuous-form paper
		expect(linesText(thinkingBlock("", true).render(context()))).toEqual([
			`° thinking${" ".repeat(WIDTH - 12)} °`,
			`°${" ".repeat(WIDTH - 2)}°`,
		]);
		// a VT420 and an emulator alike, which jumps where the VT420 glides
		for (const unicode of [false, true]) {
			const renderer = new Renderer({
				rows: 4,
				columns: WIDTH,
				statusLine: false,
				rectangularOps: true,
				eraseCharacters: true,
				eightBit: false,
				unicode,
			});
			const emulator = new Vt420Emulator({ rows: 4, columns: WIDTH, utf8: unicode });
			emulator.feed(SESSION_MODES + charsetDesignations({ technical: true, supplemental: "dec", eightBit: false }));
			const words = `${THINKING} and then the renderer, and the emulator after it`.split(" ");
			let rolls = 0;
			for (let count = 1; count <= words.length; count++) {
				const lines = thinkingBlock(words.slice(0, count).join(" "), true).render(context());
				expect(lines).toHaveLength(2);
				const above = { cells: charset.cells("above"), attr: LINE_SINGLE } as const;
				const frame: Frame = {
					lines: [above, ...lines, { cells: [], attr: LINE_SINGLE }],
					scroll: { top: 0, bottom: 3 },
				};
				const bytes = renderer.render(frame);
				if (bytes.includes("\x1b[?4h\x1bD\x1b[?4l")) rolls++;
				emulator.feed(Buffer.from(bytes, unicode ? "utf8" : "latin1"));
				expect([emulator.text(0), emulator.text(1), emulator.text(2)]).toEqual(["above", ...linesText(lines)]);
			}
			expect(rolls).toBeGreaterThan(1);
		}
	});

	it("makes the last three words of live thinking glow", () => {
		const glowing = (lines: Line[]): string[] =>
			linesText(lines.map((line) => ({ ...line, cells: line.cells.filter((cell) => cell & ATTR_BOLD) }))).filter(
				(text) => text !== "",
			);
		const views = [context(), context(true)];
		for (const view of views) {
			expect(glowing(thinkingBlock(THINKING, true).render(view)).join(" ")).toBe("then the tests");
			expect(glowing(thinkingBlock(`${THINKING} pass`, true).render(view)).join(" ")).toBe("the tests pass");
			expect(glowing(thinkingBlock("one", true).render(view))).toEqual(["one"]);
			if (view.showThinking) expect(glowing(thinkingBlock("a b c\nd e", true).render(view))).toEqual(["c", "d e"]);
			expect(glowing(thinkingBlock("", true).render(view))).toEqual([]);
			expect(glowing(thinkingBlock(THINKING, false).render(view))).toEqual([]);
		}
	});
});

describe("vt420 scope traces", () => {
	it("swings a standing wave in place while the model reads, where the others travel", () => {
		const scan = (phase: Parameters<typeof traceCells>[0], tick: number): string =>
			linesText([{ cells: traceCells(phase, tick, charset, false), attr: LINE_SINGLE }])[0]!;
		expect([0, 1, 2, 3, 4].map((tick) => scan("reading", tick))).toEqual(["⎺⎽⎺⎽", "────", "⎽⎺⎽⎺", "────", "⎺⎽⎺⎽"]);
		expect(scan("thinking", 1)).toBe(scan("thinking", 0).slice(1) + scan("thinking", 4)[0]);
		// soft glyphs after the other traces' 24: a frame a tick, the same two glyphs across its cells
		const soft = traceCells("reading", 3, charset, true).map((cell) => cell & 0x7f);
		expect(soft).toEqual([0x39 + 6, 0x3a + 6, 0x39 + 6, 0x3a + 6]);
		expect(traceCells("reading", 11, charset, true)).toEqual(traceCells("reading", 3, charset, true));
	});
});

describe("vt420 token counts", () => {
	it("counts the tokens the model took in fresh and how much of the prompt the cache served", () => {
		const tokens = { input: 9000, output: 1200, cacheRead: 40_000, cacheWrite: 3000 };
		expect(tokenCounts(charset, tokens)).toBe("↑12k »76% ↓1.2k");
		expect(tokenCounts(charset, { ...tokens, cacheRead: 0 })).toBe("↑12k ↓1.2k");
		const plain = new Charset({ technical: false, supplemental: "dec", eightBit: false });
		expect(tokenCounts(plain, tokens)).toBe("in 12k 76% cached out 1.2k");
	});
});

describe("vt420 transcript steps", () => {
	const call = (name: string, command: string): AssistantMessage["content"][number] => ({
		type: "toolCall",
		id: command,
		name,
		arguments: { command },
	});
	const stretch = (live: { running: boolean } | undefined): Transcript => {
		const transcript = new Transcript();
		const thought = (ms: number) => new Map([[0, { since: 0, until: ms }]]);
		transcript.add({ kind: "user", text: "fix the build" });
		transcript.add({
			kind: "assistant",
			message: reply([{ type: "thinking", thinking: "look first" }, call("bash", "make")]),
			streaming: false,
			thinkingTimes: thought(12_000),
		});
		transcript.add({
			kind: "tool",
			tool: { name: "bash", args: { command: "make" }, status: "error", output: "boom", durationMs: 1000 },
		});
		transcript.add({
			kind: "assistant",
			message: reply([{ type: "thinking", thinking: "then read" }, call("read", "a.ts")]),
			streaming: false,
			thinkingTimes: thought(3000),
		});
		transcript.add({
			kind: "tool",
			tool: {
				name: "read",
				args: { path: "/work/a.ts" },
				status: live?.running ? "running" : "done",
				output: "x",
				durationMs: live?.running ? undefined : 2000,
				startedAt: 0,
			},
		});
		if (!live) {
			transcript.add({
				kind: "assistant",
				message: reply([
					{ type: "thinking", thinking: "so" },
					{ type: "text", text: "Fixed it." },
				]),
				streaming: false,
				thinkingTimes: thought(5000),
			});
		}
		return transcript;
	};
	const shown = (transcript: Transcript, view: Partial<RenderContext> = {}): string[] =>
		linesText(transcript.lines({ ...context(), ...view })).slice(3);

	it("folds thinking and calls into one line, the answer's thinking too, a failed call marked", () => {
		expect(shown(stretch(undefined))).toEqual([`∴ 20 sec · >× ↑${" ".repeat(23)}3s`, "", "Fixed it."]);
	});

	it("keeps the latest step in full while the model works, beneath the ones done", () => {
		const lines = shown(stretch({ running: true }), { working: true });
		// the line gives the whole stretch, the call going beating in it, and its own line keeps only its time
		expect(lines[0]).toBe(`∴ 15 sec · >× ·${" ".repeat(23)}1s`);
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("∴ Thought for 3 sec");
		expect(lines[3]).toBe("↑ a.ts");
	});

	it("folds a stretch whole once a reply follows it, whatever room there is", () => {
		for (const view of [{ foldAfter: 2 }, { foldAfter: "auto" as const, height: 100 }]) {
			expect(shown(stretch(undefined), view)[0]).toMatch(/^∴ 20 sec · >× ↑ +3s$/);
		}
		// an earlier stretch folds as the reply after it comes, the one at the end stays open while it fits
		const transcript = new Transcript();
		transcript.add({ kind: "user", text: "fix the build" });
		transcript.add({
			kind: "assistant",
			message: reply([{ type: "thinking", thinking: "look" }, call("bash", "make")]),
			streaming: false,
			thinkingTimes: new Map([[0, { since: 0, until: 2000 }]]),
		});
		transcript.add({ kind: "tool", tool: { name: "bash", args: { command: "make" }, status: "done", output: "" } });
		transcript.add({
			kind: "assistant",
			message: reply([{ type: "text", text: "Now the tests." }, call("read", "a.ts")]),
			streaming: false,
		});
		transcript.add({
			kind: "tool",
			tool: { name: "read", args: { path: "/work/a.ts" }, status: "done", output: "" },
		});
		const lines = shown(transcript, { foldAfter: "auto", height: 100 });
		expect(lines[0]).toMatch(/^∴ 2 sec · > *$/);
		expect(lines).toContain("Now the tests.");
		expect(lines.some((line) => line.startsWith("↑ a.ts"))).toBe(true);
	});

	it("keeps open the latest steps of the stretch at the end, N of them, or, auto, as many as its turn fits", () => {
		const open = stretch({ running: false });
		// two steps: 1 keeps the latest, 2 both; the line gives them all, those still open too
		const one = shown(open, { foldAfter: 1 });
		expect(one[0]).toMatch(/^∴ 15 sec · >× ↑ +3s$/);
		expect(one.slice(1, 3)).toEqual(["", "∴ Thought for 3 sec"]);
		expect(shown(open, { foldAfter: 2 })[0]).toBe("∴ Thought for 12 sec");
		// auto: the message box and the steps take 9 rows
		expect(shown(open, { foldAfter: "auto", height: 9 })[0]).toBe("∴ Thought for 12 sec");
		expect(shown(open, { foldAfter: "auto", height: 8 }).slice(0, 3)).toEqual(one.slice(0, 3));
		expect(shown(open, { foldAfter: "auto", height: 4 })[0]).toMatch(/^∴ 15 sec · >× ↑ +3s$/);
		// while the model works the latest step stays open, however little room
		const live = shown(stretch({ running: true }), { foldAfter: "auto", height: 4, working: true });
		expect(live[0]).toMatch(/^∴ 15 sec · >× · +1s$/);
		expect(live[2]).toBe("∴ Thought for 3 sec");
	});

	it("goes on in rows beneath when the glyphs do not fit one, under the first", () => {
		const transcript = new Transcript();
		transcript.add({ kind: "user", text: "read them all" });
		for (let file = 0; file < 20; file++) {
			transcript.add({
				kind: "assistant",
				message: reply([call("read", `f${file}`)]),
				streaming: false,
			});
			transcript.add({
				kind: "tool",
				tool: { name: "read", args: { path: `/work/f${file}` }, status: "done", output: "" },
			});
		}
		transcript.add({ kind: "assistant", message: reply([{ type: "text", text: "Read." }]), streaming: false });
		const lines = shown(transcript);
		expect(lines[0]).toBe(`${"↑ ".repeat(19)}↑`);
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("Read.");
		const thought = new Transcript();
		thought.add({ kind: "user", text: "think and read" });
		thought.add({
			kind: "assistant",
			message: reply([
				{ type: "thinking", thinking: "x" },
				...Array.from({ length: 16 }, (_, i) => call("read", `g${i}`)),
			]),
			streaming: false,
			thinkingTimes: new Map([[0, { since: 0, until: 4000 }]]),
		});
		for (let file = 0; file < 16; file++) {
			thought.add({
				kind: "tool",
				tool: { name: "read", args: { path: `/work/g${file}` }, status: "done", output: "", durationMs: 1000 },
			});
		}
		const rows = shown(thought).slice(0, 2);
		expect(rows[0]).toBe(`∴ 4 sec · ${"↑ ".repeat(12)}↑${" ".repeat(2)}16s`);
		expect(rows[1]).toBe(`${" ".repeat(10)}↑ ↑ ↑`);
	});

	it("shows every step again unfolded, and PF3 or PF4 alone leave them folded", () => {
		const unfolded = shown(stretch(undefined), { foldSteps: false });
		expect(unfolded.some((line) => line.startsWith("> make"))).toBe(true);
		expect(unfolded).toContain("∴ Thought for 12 sec");
		for (const view of [{ expandTools: true }, { showThinking: true }]) {
			expect(shown(stretch(undefined), view)[0]).toMatch(/^∴ 20 sec · >× ↑ +3s$/);
		}
	});
});

describe("vt420 transcript tools", () => {
	const output = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
	const bash = (running: boolean): TranscriptBlock =>
		new TranscriptBlock(1, {
			kind: "bash",
			bash: { command: "make", output, running, cancelled: false, excluded: false, startedAt: 0 },
		});
	const grep = (running: boolean): TranscriptBlock =>
		new TranscriptBlock(1, {
			kind: "tool",
			tool: { name: "grep", args: { pattern: "line" }, status: running ? "running" : "done", output, startedAt: 0 },
		});

	it("puts a command on one line, as much of it as fits", () => {
		const done = (command: string): string[] =>
			linesText(
				new TranscriptBlock(1, {
					kind: "tool",
					tool: { name: "bash", args: { command }, status: "done", output: "" },
				}).render(context()),
			);
		expect(done("make \\\n  -j4\nmake test")).toEqual([`> make -j4 make test${" ".repeat(19)}√`]);
		const long = done(
			`npm test -- --run \\\n${["a", "b", "c", "d"].map((name) => `  test/${name}.test.ts`).join("\n")}`,
		);
		expect(long).toEqual(["> npm test -- --run test/a.test.ts ... √"]);
		const typed = new TranscriptBlock(1, {
			kind: "bash",
			bash: {
				command: "make\nmake test",
				output: "",
				running: false,
				cancelled: false,
				excluded: true,
				startedAt: 0,
			},
		});
		expect(linesText(typed.render(context()))).toEqual([`!! make make test${" ".repeat(22)}√`]);
	});

	it("shows the whole call once expanded, the command with its line breaks and every argument", () => {
		const expanded = { ...context(), expandTools: true };
		const call = (name: string, args: Record<string, unknown>): string[] =>
			linesText(
				new TranscriptBlock(1, { kind: "tool", tool: { name, args, status: "done", output: "" } }).render(expanded),
			);
		expect(call("bash", { command: 'for f in *.ts; do\n  echo "$f"\ndone', timeout: 30 })).toEqual([
			`> for f in *.ts; do${" ".repeat(20)}√`,
			'    echo "$f"',
			"  done (timeout 30s)",
		]);
		expect(call("bash", { command: "echo one two three four five six seven eight nine ten" })).toEqual([
			`> echo one two three four five six${" ".repeat(5)}√`,
			"  seven eight nine ten",
		]);
		expect(call("grep", { pattern: "TODO", glob: "*.md", ignoreCase: true })).toEqual([
			`∼ TODO (glob *.md, ignore case)${" ".repeat(8)}√`,
		]);
		expect(call("find", { pattern: "*.ts", path: "/work/src", limit: 50 })).toEqual([
			`∇ *.ts in src (limit 50)${" ".repeat(15)}√`,
		]);
		expect(call("codemode", { code: "const a = 1;\nreturn a;", timeoutMs: 500 })).toEqual([
			`ƒ codemode${" ".repeat(29)}√`,
			"  code:",
			"    const a = 1;",
			"    return a;",
			"  timeoutMs: 500",
		]);
		const typed = new TranscriptBlock(1, {
			kind: "bash",
			bash: {
				command: "make\nmake test",
				output: "",
				running: false,
				cancelled: false,
				excluded: true,
				startedAt: 0,
			},
		});
		expect(linesText(typed.render(expanded))).toEqual([`!! make${" ".repeat(32)}√`, "   make test"]);
	});

	it("says how long a tool ran once that is a second or more", () => {
		const header = (tool: Partial<ToolState>): string | undefined =>
			linesText(
				new TranscriptBlock(1, {
					kind: "tool",
					tool: { name: "bash", args: { command: "make" }, status: "done", output: "", ...tool },
				}).render(context()),
			)[0];
		expect(header({ durationMs: 65_000 })).toBe(`> make${" ".repeat(26)}1m 05s √`);
		expect(header({ durationMs: 400 })).toBe(`> make${" ".repeat(33)}√`);
		const running = new TranscriptBlock(1, {
			kind: "tool",
			tool: { name: "bash", args: { command: "make" }, status: "running", output: "", startedAt: 0 },
		});
		// a heartbeat: a dot swelling to a diamond, and a rest, the time keeping its place
		const beats = [0, 1, 2, 3, 4].map((tick) => linesText(running.render({ ...context(), now: 65_000, tick }))[0]);
		expect(beats).toEqual(
			["·", "◆", "·", " ", " "].map((frame) => `> make${" ".repeat(26)}1m 05s ${frame}`.trimEnd()),
		);
		expect(header({ status: "error", durationMs: 2500 })).toBe(`> make${" ".repeat(30)}2s ×`);
		const edit = { name: "edit", args: { path: "/work/a.ts" }, details: { diff: "-old\n+new" }, durationMs: 3000 };
		expect(header(edit)).toBe(`Δ a.ts${" ".repeat(22)}+1 -1 · 3s √`);
		const content = Array.from({ length: 42 }, (_, i) => `line ${i + 1}\n`).join("");
		expect(header({ name: "write", args: { path: "/work/a.ts", content } })).toBe(`← a.ts${" ".repeat(29)}+42 √`);
		expect(header({ name: "read", args: { path: "/work/a.ts" }, output: content })).toBe(
			`↑ a.ts${" ".repeat(24)}42 lines √`,
		);
		const typed = new TranscriptBlock(1, {
			kind: "bash",
			bash: {
				command: "make",
				output: "",
				running: false,
				exitCode: 1,
				cancelled: false,
				excluded: false,
				startedAt: 0,
				durationMs: 3000,
			},
		});
		expect(linesText(typed.render(context()))[0]).toBe(`! make${" ".repeat(21)}exit 1 · 3s ×`);
	});

	it("expands the output of a tool still running, as of one done", () => {
		for (const block of [bash, grep]) {
			for (const running of [true, false]) {
				const collapsed = linesText(block(running).render(context()));
				expect(collapsed).toContain("  ┌ 7 earlier lines · PF2");
				const outputLine = (line: string): boolean => /line \d+$/.test(line);
				expect(collapsed.filter(outputLine)).toHaveLength(5);
				const expanded = linesText(block(running).render({ ...context(), expandTools: true }));
				expect(expanded.filter(outputLine)).toHaveLength(12);
			}
		}
	});
});
