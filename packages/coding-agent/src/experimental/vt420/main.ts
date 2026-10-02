#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { setupCli } from "../../cli/setup.ts";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, VERSION } from "../../config.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../core/agent-session-runtime.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import { refreshModelCatalogs } from "../../modes/interactive/model-catalog-refresh.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { Vt420App } from "./app.ts";
import type { SupplementalSet } from "./charset.ts";
import { startIntro } from "./intro.ts";
import { Keymap, type Vt420KeyOverrides } from "./keys.ts";
import { Vt420Terminal } from "./terminal.ts";

interface Vt420Config {
	keys?: Vt420KeyOverrides;
	encoding?: "auto" | "dec" | "utf8";
	statusLine?: "auto" | "on" | "off";
	doubleSize?: "auto" | "on" | "off";
	supplemental?: "auto" | SupplementalSet;
	eightBit?: boolean;
	flowControl?: boolean;
	baud?: number;
	columns?: 80 | 132;
	lines?: 24 | 36 | 48;
	largeHeadings?: boolean;
	pasteWindowMs?: number;
	escapeTimeoutMs?: number;
	/** The start-up animation. */
	intro?: boolean;
}

interface Args {
	continue: boolean;
	resume: boolean;
	noSession: boolean;
	session?: string;
	model?: string;
	thinking?: ThinkingLevel;
	approve?: boolean;
	offline: boolean;
	log?: string;
	help: boolean;
	version: boolean;
	config: Vt420Config;
	prompt: string[];
}

const USAGE = `pi for the DEC VT420

Usage: pi-vt420 [options] [prompt]

Session
  -c, --continue            continue the most recent session in this directory
  -r, --resume              choose a session to resume
      --session <path|id>   open a session file or session id
      --no-session          do not save the session
  -m, --model <pattern>     model, e.g. anthropic/claude-sonnet-4-5 or gpt-5:high
      --thinking <level>    off, minimal, low, medium, high, xhigh, max
  -a, --approve             trust project resources in .pi for this run
      --no-approve          ignore project resources in .pi
      --offline             do not refresh model catalogs

Terminal
      --columns 80|132      switch the terminal to 80 or 132 columns (DECSCPP)
      --lines 24|36|48      switch the number of screen lines (DECSNLS)
      --status-line <mode>  auto, on or off: footer on the host-writable status line
      --double-size <mode>  auto, on or off: double-width and double-height lines (letter-spaced when off)
      --encoding <mode>     auto, dec or utf8: DEC character sets, or Unicode for emulators
      --latin1, --dec-mcs   supplemental set for G3 (default: the terminal's preference)
      --8bit                send supplemental glyphs as 8-bit GR codes
      --baud <n>            line speed for output pacing (detected on serial ports)
      --no-flow-control     do not keep XON/XOFF enabled
      --no-intro            skip the start-up animation (any key skips it too)
      --log <file>          append terminal output and stray console output to a file

Settings are read from ~/.pi/agent/vt420.json; keys there override the defaults, e.g.
  { "keys": { "app.interrupt": ["f11", "escape"] }, "baud": 19200 }
`;

function fail(message: string): never {
	process.stderr.write(`pi-vt420: ${message}\n`);
	process.exit(1);
}

function loadConfig(path: string): Vt420Config {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Vt420Config;
	} catch (error) {
		fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseArgs(argv: readonly string[], config: Vt420Config): Args {
	const args: Args = {
		continue: false,
		resume: false,
		noSession: false,
		offline: process.env.PI_OFFLINE === "1",
		help: false,
		version: false,
		config: { ...config },
		prompt: [],
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const value = (): string => {
			const next = argv[++index];
			if (next === undefined) fail(`${arg} needs a value`);
			return next;
		};
		switch (arg) {
			case "-c":
			case "--continue":
				args.continue = true;
				break;
			case "-r":
			case "--resume":
				args.resume = true;
				break;
			case "--no-session":
				args.noSession = true;
				break;
			case "--session":
				args.session = value();
				break;
			case "-m":
			case "--model":
				args.model = value();
				break;
			case "--thinking": {
				const level = value();
				if (!isValidThinkingLevel(level)) fail(`invalid thinking level ${level}`);
				args.thinking = level;
				break;
			}
			case "-a":
			case "--approve":
				args.approve = true;
				break;
			case "--no-approve":
				args.approve = false;
				break;
			case "--offline":
				args.offline = true;
				break;
			case "--columns": {
				const columns = Number(value());
				if (columns !== 80 && columns !== 132) fail("--columns must be 80 or 132");
				args.config.columns = columns;
				break;
			}
			case "--lines": {
				const lines = Number(value());
				if (lines !== 24 && lines !== 36 && lines !== 48) fail("--lines must be 24, 36 or 48");
				args.config.lines = lines;
				break;
			}
			case "--status-line": {
				const mode = value();
				if (mode !== "auto" && mode !== "on" && mode !== "off") fail("--status-line must be auto, on or off");
				args.config.statusLine = mode;
				break;
			}
			case "--double-size": {
				const mode = value();
				if (mode !== "auto" && mode !== "on" && mode !== "off") fail("--double-size must be auto, on or off");
				args.config.doubleSize = mode;
				break;
			}
			case "--encoding": {
				const mode = value();
				if (mode !== "auto" && mode !== "dec" && mode !== "utf8") fail("--encoding must be auto, dec or utf8");
				args.config.encoding = mode;
				break;
			}
			case "--latin1":
				args.config.supplemental = "latin1";
				break;
			case "--dec-mcs":
				args.config.supplemental = "dec";
				break;
			case "--8bit":
				args.config.eightBit = true;
				break;
			case "--baud": {
				const baud = Number(value());
				if (!Number.isFinite(baud) || baud <= 0) fail("--baud needs a positive number");
				args.config.baud = baud;
				break;
			}
			case "--no-flow-control":
				args.config.flowControl = false;
				break;
			case "--no-intro":
				args.config.intro = false;
				break;
			case "--log":
				args.log = resolve(value());
				break;
			case "-h":
			case "--help":
				args.help = true;
				break;
			case "-v":
			case "--version":
				args.version = true;
				break;
			default:
				if (arg.startsWith("-") && arg !== "-") fail(`unknown option ${arg}`);
				args.prompt.push(arg);
		}
	}
	return args;
}

async function openSessionManager(args: Args, cwd: string, sessionDir: string | undefined): Promise<SessionManager> {
	if (args.noSession) return SessionManager.inMemory(cwd);
	if (args.session) {
		if (args.session.includes("/") || args.session.endsWith(".jsonl")) {
			return SessionManager.open(resolve(cwd, args.session), sessionDir);
		}
		const sessions = await SessionManager.list(cwd, sessionDir);
		const match =
			sessions.find((info) => info.id === args.session) ??
			sessions.find((info) => info.id.startsWith(args.session!));
		if (!match) fail(`no session matches ${args.session}`);
		return SessionManager.open(match.path, sessionDir);
	}
	if (args.continue) return SessionManager.continueRecent(cwd, sessionDir);
	return SessionManager.create(cwd, sessionDir);
}

async function main(): Promise<void> {
	setupCli();
	const agentDir = getAgentDir();
	const args = parseArgs(process.argv.slice(2), loadConfig(join(agentDir, "vt420.json")));
	if (args.help) {
		process.stdout.write(USAGE);
		return;
	}
	if (args.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	if (args.offline) process.env.PI_OFFLINE = "1";

	const cwd = process.cwd();
	const startupSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(startupSettings.getGlobalSettings().httpProxy);
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir = envSessionDir ? expandTildePath(envSessionDir) : startupSettings.getSessionDir();
	const sessionManager = await openSessionManager(args, cwd, sessionDir);
	const trustStore = new ProjectTrustStore(agentDir);

	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const needsTrust = hasTrustRequiringProjectResources(options.cwd);
		const defaultTrust = startupSettings.getDefaultProjectTrust();
		const projectTrusted =
			args.approve ?? (!needsTrust || trustStore.get(options.cwd) === true || defaultTrust === "always");
		const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			resourceLoaderOptions: { noExtensions: true, noThemes: true },
		});
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [...services.diagnostics];
		if (needsTrust && !projectTrusted) {
			diagnostics.push({
				type: "warning",
				message:
					"Project resources in .pi were not loaded because this folder is not trusted. Start with -a to trust it.",
			});
		}
		const resolved = resolveCliModel({
			cliModel: args.model,
			cliThinking: args.thinking,
			modelRuntime: services.modelRuntime,
		});
		if (resolved.warning) diagnostics.push({ type: "warning", message: resolved.warning });
		if (resolved.error) diagnostics.push({ type: "error", message: resolved.error });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			model: resolved.model,
			thinkingLevel: args.thinking ?? resolved.thinkingLevel,
		});
		if (created.modelFallbackMessage) diagnostics.push({ type: "warning", message: created.modelFallbackMessage });
		return { ...created, services, diagnostics };
	};

	const config = args.config;
	const terminal = await Vt420Terminal.open({
		statusLine: config.statusLine ?? "auto",
		doubleSize: config.doubleSize ?? "auto",
		encoding: config.encoding ?? "auto",
		supplemental: config.supplemental ?? "auto",
		eightBit: config.eightBit ?? false,
		columns: config.columns,
		lines: config.lines,
		flowControl: config.flowControl ?? true,
		baud: config.baud,
		escapeTimeoutMs:
			config.escapeTimeoutMs ??
			(process.env.PI_VT420_ESC_TIMEOUT ? Number(process.env.PI_VT420_ESC_TIMEOUT) : undefined),
		probeTimeoutMs: 1500,
		logPath: args.log ?? process.env.PI_VT420_LOG,
	});
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	// the intro plays while the session loads
	const intro = config.intro === false ? undefined : startIntro(terminal, VERSION);
	const shutdown = async (code: number, message?: string): Promise<never> => {
		killTrackedDetachedChildren();
		intro?.stop();
		terminal.close();
		if (message) process.stderr.write(`pi-vt420: ${message}\n`);
		await runtime?.dispose().catch(() => {});
		process.exit(code);
	};
	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => void shutdown(signal === "SIGHUP" ? 129 : 143));
	}
	process.on("uncaughtException", (error) => void shutdown(1, error.stack ?? error.message));

	runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	}).catch((error: unknown) => shutdown(1, error instanceof Error ? error.message : String(error)));
	const errors = runtime.diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length > 0) await shutdown(1, errors.map((diagnostic) => diagnostic.message).join("\n"));
	configureHttpDispatcher(runtime.services.settingsManager.getHttpIdleTimeoutMs());

	if (!args.offline) {
		void refreshModelCatalogs(runtime.session.modelRuntime, AbortSignal.timeout(15_000)).catch(() => {});
	}
	await intro?.done;
	const app = new Vt420App({
		runtime,
		io: terminal,
		keymap: new Keymap(config.keys),
		version: VERSION,
		sessionDir,
		largeHeadings: config.largeHeadings,
		pasteWindowMs: config.pasteWindowMs,
	});
	try {
		await app.run({
			prompt: args.prompt.length > 0 ? args.prompt.join(" ") : undefined,
			resume: args.resume,
			notices: runtime.diagnostics
				.filter((diagnostic) => diagnostic.type === "warning")
				.map((diagnostic) => diagnostic.message),
		});
	} catch (error) {
		await shutdown(1, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
	await shutdown(0);
}

await main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
