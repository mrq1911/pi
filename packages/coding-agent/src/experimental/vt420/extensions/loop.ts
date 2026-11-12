/**
 * /loop: run a prompt again and again.
 *
 *   /loop 5m check the build    every five minutes (units s, m, h and d, as in 1d or 2h30m); a run that comes due
 *                               while another turn runs waits for it
 *   /loop keep the tests green  again as each run ends; the model picks the wait before the next, or ends the loop,
 *                               with the loop_next tool, which is only active while a loop runs; each run tells it
 *                               so, and a run that does not call it ends the loop rather than going again at once
 *   /loop                       what is looping
 *   /loop stop                  end it; interrupting a run ends it too
 *
 * The prompt can be a slash command or a prompt template. Installed by pi-vt420's install.sh into
 * ~/.pi/agent/extensions, so pi and pi-vt420 both load it.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/index.ts";

const TOOL = "loop_next";
/** The note beside each run's prompt; its details carry the /loop as typed, which a frontend can show for the run. */
export const LOOP_NOTE = "loop";
export interface LoopNoteDetails {
	command: string;
}
/** Shortest wait between self-paced runs, so a loop that does nothing cannot spin. */
const MIN_DELAY_MS = 1000;
/** Longest wait the model can ask for between self-paced runs. */
const MAX_DELAY_SECONDS = 30 * 86_400;
/**
 * Waits go in steps of at most this long, measured against the wall clock: setTimeout cannot wait 25 days or more
 * (longer goes off at once), and its clock stops while the machine sleeps, which would push a daily run later each day.
 */
const STEP_MS = 60_000;
/** A run whose prompt starts no turn (a command that only does something) ends after this long. */
const START_GRACE_MS = 500;

interface Loop {
	/** The /loop as typed. */
	command: string;
	prompt: string;
	/** Fixed interval; undefined runs again as each run ends. */
	intervalMs?: number;
	runs: number;
	/** A loop run is going: the prompt went out, its turn has not ended. */
	running: boolean;
	started: boolean;
	/** The wait the model asked for before the next self-paced run. */
	nextDelayMs: number;
	/** The model called loop_next during this run. */
	paced: boolean;
	/** Set when the model ended the loop, with its reason. */
	stopReason?: string;
	/** An interval run came due while another turn ran. */
	due: boolean;
	timer?: ReturnType<typeof setTimeout>;
	/** When the loop began, for how long it has gone on. */
	since: number;
	/** Brings the status up to date a second at a time. */
	ticker: ReturnType<typeof setInterval>;
}

/** "30s", "5m", "2h", "1h30m" or "1d"; a unit is needed, so a prompt that starts with a number stays a prompt. */
export function parseInterval(text: string): number | undefined {
	const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
	if (!match || !/\d/.test(text)) return undefined;
	const [, days, hours, minutes, seconds] = match;
	const ms =
		(((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes ?? 0)) * 60 + Number(seconds ?? 0)) * 1000;
	return ms > 0 ? ms : undefined;
}

const UNITS = [
	["d", 86_400],
	["h", 3600],
	["m", 60],
	["s", 1],
] as const;

/** The largest unit and the next one down, as /loop takes them: "30s", "5m30s", "1h30m", "1d12h". */
export function formatInterval(ms: number): string {
	const seconds = Math.round(ms / 1000);
	const index = UNITS.findIndex(([, size]) => seconds >= size);
	if (index < 0) return "0s";
	const [unit, size] = UNITS[index];
	const next = UNITS[index + 1];
	const rest = next ? Math.floor((seconds % size) / next[1]) : 0;
	return `${Math.floor(seconds / size)}${unit}${rest && next ? `${rest}${next[0]}` : ""}`;
}

/**
 * How long a loop has gone on, as pi-vt420 says times: "45s", "3m 07s", "12m", "1h 05m", "2d 03h". Its own, since an
 * extension loaded through the link in ~/.pi/agent/extensions resolves imports from there.
 */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 10) return seconds % 60 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${minutes}m`;
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d ${String(hours % 24).padStart(2, "0")}h` : `${days}d`;
}

export default function loopExtension(pi: ExtensionAPI) {
	let loop: Loop | undefined;
	let context: ExtensionContext | undefined;

	const toolActive = (active: boolean): void => {
		const others = pi.getActiveTools().filter((name) => name !== TOOL);
		pi.setActiveTools(active ? [...others, TOOL] : others);
	};

	const status = (): void => {
		if (!loop) {
			context?.ui.setStatus("loop", undefined);
			return;
		}
		context?.ui.setStatus("loop", `∞ ${formatElapsed(Date.now() - loop.since)}`);
	};

	/** Calls `then` once the wall clock reaches `dueAt`, unless the loop stops first. */
	const at = (current: Loop, dueAt: number, then: () => void): void => {
		current.timer = setTimeout(
			() => (Date.now() >= dueAt ? then() : at(current, dueAt, then)),
			Math.max(0, Math.min(dueAt - Date.now(), STEP_MS)),
		);
	};

	const stop = (message?: string): void => {
		if (!loop) return;
		clearTimeout(loop.timer);
		clearInterval(loop.ticker);
		loop = undefined;
		toolActive(false);
		status();
		if (message) context?.ui.notify(message, "info");
	};

	const run = (): void => {
		const current = loop;
		if (!current || !context) return;
		if (current.running || !context.isIdle()) {
			current.due = true;
			return;
		}
		current.due = false;
		current.running = true;
		current.started = false;
		current.paced = false;
		current.runs++;
		status();
		pi.sendUserMessage(current.prompt, { expandPromptTemplates: true });
		setTimeout(() => {
			if (loop === current && current.running && !current.started && context?.isIdle()) finish(false);
		}, START_GRACE_MS);
	};

	/** A loop run ended: go on as the loop's pace says, unless it was interrupted or the model ended it. */
	const finish = (aborted: boolean): void => {
		const current = loop;
		if (!current) return;
		current.running = false;
		if (aborted) {
			stop("Loop stopped: the run was interrupted");
			return;
		}
		if (current.stopReason !== undefined) {
			stop(`Loop done${current.stopReason ? `: ${current.stopReason}` : ""}`);
			return;
		}
		if (!current.intervalMs) {
			if (!current.paced) {
				stop(`Loop ended: run ${current.runs} did not say when to run again`);
				return;
			}
			const delay = Math.max(MIN_DELAY_MS, current.nextDelayMs);
			current.nextDelayMs = 0;
			at(current, Date.now() + delay, run);
		} else if (current.due) setTimeout(run, 0);
	};

	/** Runs at `dueAt` and every `ms` after; runs missed while the machine slept make one run, on the same beat. */
	const every = (current: Loop, dueAt: number, ms: number): void => {
		at(current, dueAt, () => {
			run();
			let next = dueAt + ms;
			while (next <= Date.now()) next += ms;
			every(current, next, ms);
		});
	};

	pi.registerTool({
		name: TOOL,
		label: "Loop",
		description:
			"While /loop runs its prompt: choose when the prompt runs again, or end the loop because its work is done or cannot go on.",
		promptSnippet: "Pace a /loop: when its prompt runs next, or end the loop",
		promptGuidelines: [
			"When a turn comes from /loop, call loop_next once near its end: delaySeconds for how long to wait before the next run (0 to go again at once, more when waiting for something slow), or stop: true with a reason once the work is done or blocked.",
		],
		parameters: Type.Object({
			delaySeconds: Type.Optional(
				Type.Number({
					minimum: 0,
					maximum: MAX_DELAY_SECONDS,
					description: "Seconds to wait before the next run, up to 30 days",
				}),
			),
			stop: Type.Optional(Type.Boolean({ description: "End the loop after this run" })),
			reason: Type.Optional(Type.String({ description: "Why, for the user" })),
		}),
		async execute(_toolCallId, params) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (!loop) return reply("No loop is running.");
			loop.paced = true;
			if (params.stop) {
				loop.stopReason = params.reason ?? "";
				return reply("The loop ends after this run.");
			}
			if (loop.intervalMs) {
				return reply(`This loop runs every ${formatInterval(loop.intervalMs)}; the next run keeps to that.`);
			}
			loop.nextDelayMs = Math.round((params.delaySeconds ?? 0) * 1000);
			return reply(
				loop.nextDelayMs > 0
					? `The next run starts ${formatInterval(loop.nextDelayMs)} after this one ends.`
					: "The next run starts as soon as this one ends.",
			);
		},
	});

	pi.registerCommand("loop", {
		description: "run a prompt every interval (/loop 5m <prompt>) or again as each run ends (/loop <prompt>)",
		handler: async (args, ctx) => {
			context = ctx;
			const text = args.trim();
			if (!text) {
				if (!loop) {
					ctx.ui.notify(
						"No loop is running. /loop 5m <prompt> runs it every five minutes; /loop <prompt> runs it again as each run ends.",
						"info",
					);
					return;
				}
				const pace = loop.intervalMs ? `every ${formatInterval(loop.intervalMs)}` : "again as each run ends";
				ctx.ui.notify(
					`Looping ${pace}, ${loop.runs} run${loop.runs === 1 ? "" : "s"} so far: ${loop.prompt}`,
					"info",
				);
				return;
			}
			if (text === "stop" || text === "off") {
				if (loop) stop("Loop stopped");
				else ctx.ui.notify("No loop is running", "info");
				return;
			}
			const first = text.split(/\s+/)[0]!;
			const intervalMs = parseInterval(first);
			const prompt = intervalMs ? text.slice(first.length).trim() : text;
			if (!prompt) {
				ctx.ui.notify("Usage: /loop [interval] <prompt>, e.g. /loop 5m check the build", "warning");
				return;
			}
			stop();
			const started: Loop = {
				command: `/loop ${text}`,
				prompt,
				intervalMs,
				runs: 0,
				running: false,
				started: false,
				nextDelayMs: 0,
				paced: false,
				due: false,
				since: Date.now(),
				ticker: setInterval(status, 1000),
			};
			loop = started;
			toolActive(true);
			run();
			if (intervalMs) every(started, started.since + intervalMs, intervalMs);
			status();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		// the tool only belongs to a running loop
		if (!loop) toolActive(false);
	});

	// the run's prompt is the user's own; a note beside it, which the transcript does not show, says what it is part of
	pi.on("before_agent_start", () => {
		const current = loop;
		if (!current?.running || current.started) return undefined;
		const content = current.intervalMs
			? `This turn is run ${current.runs} of a /loop that repeats the prompt every ${formatInterval(current.intervalMs)}.`
			: `This turn is run ${current.runs} of a self-paced /loop that repeats the prompt. Before you finish, call ${TOOL}: delaySeconds for how long to wait before the next run (0 to go again at once, more when waiting on something slow), or stop: true with a reason once the work is done or cannot go on. Without that call the loop ends.`;
		const details: LoopNoteDetails = { command: current.command };
		return { message: { customType: LOOP_NOTE, content, display: false, details } };
	});

	pi.on("agent_start", (_event, ctx) => {
		context = ctx;
		if (loop?.running) loop.started = true;
	});

	pi.on("agent_end", (event, ctx) => {
		context = ctx;
		if (!loop) return;
		if (!loop.running) {
			// a run that came due while the user's own turn ran
			if (loop.due) setTimeout(run, 0);
			return;
		}
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		finish(last?.role === "assistant" && last.stopReason === "aborted");
	});

	pi.on("session_shutdown", () => {
		stop();
		context = undefined;
	});
}
