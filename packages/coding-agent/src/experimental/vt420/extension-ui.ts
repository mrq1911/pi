/**
 * What extensions get to show on a VT420: the frontend's lists, yes or no, a line of text, notices and the separator
 * row. Whatever needs pi's own TUI components (widgets, headers, footers, custom components, themes) does nothing,
 * the way pi's RPC mode answers it, so an extension that checks `ctx.mode` falls back to its dialogs.
 */

import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../core/extensions/index.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "./text.ts";

export interface ExtensionUIHost {
	/** The index of the option picked, undefined when cancelled or `signal` ends it. */
	select(title: string, options: readonly string[], signal: AbortSignal): Promise<number | undefined>;
	input(title: string, initial: string, signal: AbortSignal): Promise<string | undefined>;
	notice(level: "info" | "warning" | "error", text: string): void;
	status(text: string | undefined): void;
	/** The word for the separator row while the agent works, or the default. */
	working(message: string | undefined): void;
	editorText(): string;
	setEditorText(text: string): void;
	insertText(text: string): void;
	toolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
}

/** A dialog's signal: the caller's, also ended by its timeout. */
function dialogSignal(options: ExtensionUIDialogOptions | undefined): { signal: AbortSignal; done(): void } {
	const controller = new AbortController();
	const timer = options?.timeout ? setTimeout(() => controller.abort(), options.timeout) : undefined;
	const forward = (): void => controller.abort();
	if (options?.signal?.aborted) controller.abort();
	else options?.signal?.addEventListener("abort", forward, { once: true });
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", forward);
		},
	};
}

async function dialog<T>(
	options: ExtensionUIDialogOptions | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const { signal, done } = dialogSignal(options);
	try {
		return await run(signal);
	} finally {
		done();
	}
}

export function createExtensionUI(host: ExtensionUIHost): ExtensionUIContext {
	const statuses = new Map<string, string>();
	// an object literal: the extension runner spreads it to wrap the dialogs
	return {
		select: (title, options, opts) =>
			dialog(opts, async (signal) => {
				const index = await host.select(stripAnsi(title), options.map(stripAnsi), signal);
				return index === undefined ? undefined : options[index];
			}),
		confirm: (title, message, opts) =>
			dialog(
				opts,
				async (signal) =>
					(await host.select(`${stripAnsi(title)}\n${stripAnsi(message)}`, ["Yes", "No"], signal)) === 0,
			),
		input: (title, placeholder, opts) =>
			dialog(opts, (signal) =>
				host.input(placeholder ? `${stripAnsi(title)} (${stripAnsi(placeholder)})` : stripAnsi(title), "", signal),
			),
		notify: (message, type) => host.notice(type ?? "info", stripAnsi(message)),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, stripAnsi(text));
			host.status([...statuses.values()].join(" · ") || undefined);
		},
		setWorkingMessage: (message) => host.working(message === undefined ? undefined : stripAnsi(message)),
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: (text) => host.insertText(text),
		setEditorText: (text) => host.setEditorText(text),
		getEditorText: () => host.editorText(),
		// one line is what the VT420 editor's prompt takes
		editor: (title, prefill) => host.input(stripAnsi(title), prefill ?? "", new AbortController().signal),
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Themes do not apply on a VT420" }),
		getToolsExpanded: () => host.toolsExpanded(),
		setToolsExpanded: (expanded) => host.setToolsExpanded(expanded),
	};
}
