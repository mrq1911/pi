import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "../../core/model-runtime.ts";

export type ModelState = "running" | "idle" | "offline";

let builtinIds: ReadonlySet<string> | undefined;

export async function modelStates(
	runtime: ModelRuntime,
	models: readonly Model<Api>[],
	timeoutMs = 1000,
): Promise<Map<string, ModelState>> {
	builtinIds ??= new Set(builtinProviders().map((provider) => provider.id));
	const servers = new Map<string, Model<Api>[]>();
	for (const model of models) {
		if (builtinIds.has(model.provider)) continue;
		if (model.api !== "openai-completions" && model.api !== "openai-responses") continue;
		const key = `${model.provider} ${model.baseUrl}`;
		servers.set(key, [...(servers.get(key) ?? []), model]);
	}
	const states = new Map<string, ModelState>();
	await Promise.all(
		[...servers.values()].map(async (group) => {
			const served = await servedIds(runtime, group[0]!, timeoutMs);
			if (served === undefined) return;
			for (const model of group) {
				const running = served !== "offline" && served.some((id) => id === model.id || id.endsWith(`/${model.id}`));
				states.set(
					`${model.provider}/${model.id}`,
					served === "offline" ? "offline" : running ? "running" : "idle",
				);
			}
		}),
	);
	return states;
}

async function servedIds(
	runtime: ModelRuntime,
	model: Model<Api>,
	timeoutMs: number,
): Promise<string[] | "offline" | undefined> {
	const auth = (await runtime.getAuth(model).catch(() => undefined))?.auth;
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(auth?.headers ?? {})) if (value !== null) headers[name] = value;
	if (auth?.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
	const baseUrl = (auth?.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		// a busy server can be slow to answer; only a refused or unreachable one is offline
		return error instanceof Error && error.name === "TimeoutError" ? undefined : "offline";
	}
	if (!response.ok) return undefined;
	const body = (await response.json().catch(() => undefined)) as { data?: Array<{ id?: unknown }> } | undefined;
	return Array.isArray(body?.data) ? body.data.map((entry) => String(entry.id)) : undefined;
}
