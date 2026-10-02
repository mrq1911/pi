/**
 * /loop: run a prompt again and again, like Claude Code's.
 *
 *   /loop 5m check the build    every five minutes; a run that comes due while another turn runs waits for it
 *   /loop keep the tests green  again as each run ends; the model picks the wait before the next, or ends the loop,
 *                               with the loop_next tool, which is only active while a loop runs
 *   /loop                       what is looping
 *   /loop stop                  end it; interrupting a run ends it too
 *
 * The prompt can be a slash command or a prompt template. Installed by pi-vt420's install.sh into
 * ~/.pi/agent/extensions, so pi and pi-vt420 both load it.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/index.ts";

const TOOL = "loop_next";
/** Shortest wait between self-paced runs, so a loop that does nothing cannot spin. */
const MIN_DELAY_MS = 1000;
/** A run whose prompt starts no turn (a command that only does something) ends after this long. */
const START_GRACE_MS = 500;

interface Loop {
	prompt: string;
	/** Fixed interval; undefined runs again as each run ends. */
	intervalMs?: number;
	runs: number;
	/** A loop run is going: the prompt went out, its turn has not ended. */
	running: boolean;
	started: boolean;
	/** The wait the model asked for before the next self-paced run. */
	nextDelayMs: number;
	/** Set when the model ended the loop, with its reason. */
	stopReason?: string;
	/** An interval run came due while another turn ran. */
	due: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/** "30s", "5m", "2h" or "1h30m"; a unit is needed, so a prompt that starts with a number stays a prompt. */
export function parseInterval(text: string): number | undefined {
	const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
	if (!match || !/\d/.test(text)) return undefined;
	const [, hours, minutes, seconds] = match;
	const ms = ((Number(hours ?? 0) * 60 + Number(minutes ?? 0)) * 60 + Number(seconds ?? 0)) * 1000;
	return ms > 0 ? ms : undefined;
}

export function formatInterval(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 ? `${minutes}m${seconds % 60}s` : `${minutes}m`;
	return minutes % 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${Math.floor(minutes / 60)}h`;
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
		const pace = loop.intervalMs ? `every ${formatInterval(loop.intervalMs)}` : "self-paced";
		context?.ui.setStatus("loop", `loop ${pace} · ${loop.runs} run${loop.runs === 1 ? "" : "s"}`);
	};

	const stop = (message?: string): void => {
		if (!loop) return;
		clearTimeout(loop.timer);
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
			const delay = Math.max(MIN_DELAY_MS, current.nextDelayMs);
			current.nextDelayMs = 0;
			current.timer = setTimeout(run, delay);
		} else if (current.due) setTimeout(run, 0);
	};

	const every = (ms: number): void => {
		if (!loop) return;
		loop.timer = setTimeout(() => {
			run();
			every(ms);
		}, ms);
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
				Type.Number({ minimum: 0, maximum: 86_400, description: "Seconds to wait before the next run" }),
			),
			stop: Type.Optional(Type.Boolean({ description: "End the loop after this run" })),
			reason: Type.Optional(Type.String({ description: "Why, for the user" })),
		}),
		async execute(_toolCallId, params) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (!loop) return reply("No loop is running.");
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
			loop = { prompt, intervalMs, runs: 0, running: false, started: false, nextDelayMs: 0, due: false };
			toolActive(true);
			run();
			if (intervalMs) every(intervalMs);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		// the tool only belongs to a running loop
		if (!loop) toolActive(false);
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
