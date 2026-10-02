/**
 * /llama as plain dialogs (lists, yes or no, a line of text and a status line) for frontends without pi's TUI
 * components, such as RPC clients and the VT420 frontend.
 */

import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { LlamaModelInfo } from "./client.ts";
import { type LlamaUi, modelDescription, type ProgressState } from "./ui.ts";

/** A Hugging Face repository, with its quantization or without, as typed. */
const EXACT_MODEL = /^[^/\s]+\/[^:\s]+(?::[^\s:]+)?$/u;

function compactCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function progressText(state: ProgressState): string {
	const percent = state.ratio === undefined ? "" : ` ${Math.round(state.ratio * 100)}%`;
	return `${state.title} ${state.model}: ${state.message}${percent}${state.detail ? ` (${state.detail})` : ""}`;
}

export function dialogLlamaUi(ctx: ExtensionCommandContext): LlamaUi {
	const ui = ctx.ui;
	return {
		async showModels(serverUrl, models) {
			const sorted = [...models].sort(
				(left, right) =>
					Number(right.status.value === "loaded") - Number(left.status.value === "loaded") ||
					left.id.localeCompare(right.id),
			);
			const label = (model: LlamaModelInfo): string => {
				const description = modelDescription(model);
				return description ? `${model.id} · ${description}` : model.id;
			};
			const labels = [...sorted.map(label), "Download model…"];
			const choice = await ui.select(`llama.cpp models\n${serverUrl}`, labels);
			if (choice === undefined) return { type: "close" };
			const model = sorted[labels.indexOf(choice)];
			return model ? { type: "model", model } : { type: "download" };
		},
		select: (title, options) => ui.select(title, options),
		confirm: (title, message) => ui.confirm(title, message),
		async connectionError(serverUrl, message) {
			const choice = await ui.select(`llama.cpp unavailable\n${serverUrl}\n${message}`, ["Retry", "Close"]);
			return choice === "Retry" ? "retry" : "close";
		},
		async searchModels(search) {
			for (;;) {
				const query = (await ui.input("Download model", "owner/repository[:quant], or words to search"))?.trim();
				if (!query) return undefined;
				if (EXACT_MODEL.test(query)) return query;
				let results: Awaited<ReturnType<typeof search>>;
				try {
					results = await search(query, AbortSignal.timeout(30_000));
				} catch (error) {
					ui.notify(error instanceof Error ? error.message : String(error), "error");
					continue;
				}
				if (results.length === 0) {
					ui.notify(`No models found for ${query}`, "warning");
					continue;
				}
				const labels = results.map((model) => `${model.id} · ${compactCount(model.downloads)} downloads`);
				const choice = await ui.select(`Models matching ${query}`, labels);
				if (choice !== undefined) return results[labels.indexOf(choice)]?.id;
			}
		},
		showStatus: (title, message) => ui.setStatus("llama", `${title}: ${message}`),
		// a dialog cannot be stopped while it waits, so the work runs until it is done
		progress(state) {
			ui.setStatus("llama", progressText(state));
			return new Promise(() => {});
		},
		updateProgress: (state) => ui.setStatus("llama", progressText(state)),
	};
}

export async function showLlamaDialogs(
	ctx: ExtensionCommandContext,
	run: (ui: LlamaUi) => Promise<void>,
): Promise<void> {
	try {
		await run(dialogLlamaUi(ctx));
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		ctx.ui.setStatus("llama", undefined);
	}
}
