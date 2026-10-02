import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import type { LlamaModelInfo } from "../src/extensions/llama/client.ts";
import { dialogLlamaUi } from "../src/extensions/llama/dialogs.ts";

/** A context whose dialogs answer from a script, recording what they were asked. */
function context(answers: Array<string | undefined>) {
	const asked: string[] = [];
	const statuses: Array<string | undefined> = [];
	const ui = {
		select: async (title: string, options: string[]) => {
			asked.push(`${title} [${options.join(" | ")}]`);
			const answer = answers.shift();
			return answer === undefined ? undefined : options.find((option) => option.startsWith(answer));
		},
		confirm: async () => answers.shift() === "yes",
		input: async (title: string) => {
			asked.push(title);
			return answers.shift();
		},
		notify: (message: string) => asked.push(`notice: ${message}`),
		setStatus: (_key: string, text: string | undefined) => statuses.push(text),
	};
	return { ctx: { ui } as unknown as ExtensionCommandContext, asked, statuses };
}

const model = (id: string, status: string): LlamaModelInfo => ({ id, status: { value: status } }) as LlamaModelInfo;

describe("llama.cpp dialogs", () => {
	it("lists loaded models first, then a download entry, and maps the choice back", async () => {
		const { ctx, asked } = context(["b-model", "Download"]);
		const ui = dialogLlamaUi(ctx);
		const models = [model("a-model", "unloaded"), model("b-model", "loaded")];
		expect(await ui.showModels("http://router", models)).toEqual({ type: "model", model: models[1] });
		expect(asked[0]).toMatch(
			/^llama\.cpp models\nhttp:\/\/router \[b-model · loaded \| a-model.* \| Download model…\]$/,
		);
		expect(await ui.showModels("http://router", models)).toEqual({ type: "download" });
	});

	it("takes an exact repository as typed, or searches and picks from the results", async () => {
		const exact = context(["owner/repo:Q4_K_M"]);
		expect(await dialogLlamaUi(exact.ctx).searchModels(async () => [])).toBe("owner/repo:Q4_K_M");
		const searched = context(["qwen coder", "org/qwen-coder"]);
		const found = await dialogLlamaUi(searched.ctx).searchModels(async (query) =>
			query === "qwen coder" ? [{ id: "org/qwen-coder", downloads: 12_345 }] : [],
		);
		expect(found).toBe("org/qwen-coder");
		expect(searched.asked).toContain("Models matching qwen coder [org/qwen-coder · 12.3k downloads]");
	});

	it("shows progress on the status line", () => {
		const { ctx, statuses } = context([]);
		const ui = dialogLlamaUi(ctx);
		void ui.progress({ title: "Loading", model: "m", message: "warming up", ratio: 0.5 });
		ui.updateProgress({ title: "Loading", model: "m", message: "ready", ratio: 1 });
		expect(statuses).toEqual(["Loading m: warming up 50%", "Loading m: ready 100%"]);
	});
});
