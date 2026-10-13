import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionTreeNode } from "../src/core/session-manager.ts";
import { treeRows } from "../src/experimental/vt420/tree.ts";

let clock = 0;
function node(entry: Partial<SessionEntry> & { id: string }, children: SessionTreeNode[] = []): SessionTreeNode {
	const full = { parentId: null, timestamp: new Date(clock++).toISOString(), ...entry } as SessionEntry;
	for (const child of children) (child.entry as { parentId: string | null }).parentId = full.id;
	return { entry: full, children };
}
const user = (id: string, text: string, children: SessionTreeNode[] = []) =>
	node({ id, type: "message", message: { role: "user", content: text, timestamp: 0 } } as never, children);
const assistant = (id: string, text: string, children: SessionTreeNode[] = []) =>
	node(
		{
			id,
			type: "message",
			message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason: "stop" },
		} as never,
		children,
	);

const result = (id: string, call: string, tool: string, children: SessionTreeNode[] = []) =>
	node(
		{
			id,
			type: "message",
			message: { role: "toolResult", toolCallId: call, toolName: tool, content: [], isError: false },
		} as never,
		children,
	);
const CONTEXT = { cwd: "/work", home: "/home/user" };

describe("vt420 session tree", () => {
	it("lists the branch it stands on first, with line drawing where it splits and a mark on its path", () => {
		const tree = [
			user("a", "first", [
				assistant("a1", "one", [
					node({ id: "m", type: "model_change", provider: "p", modelId: "x" } as never, [
						user("b", "second", [assistant("b1", "two")]),
					]),
					user("c", "third", [assistant("c1", "", [assistant("c2", "three")])]),
				]),
			]),
		];
		const rows = treeRows(tree, "c2", CONTEXT);
		expect(rows.map((row) => `${row.prefix}${row.onPath ? "* " : ""}${row.text}`)).toEqual([
			"* user: first",
			"* assistant: one",
			"├─ * user: third",
			"│  * assistant: three",
			"└─ user: second",
			"   assistant: two",
		]);
	});

	it("shows what each tool worked on, from the call that asked for it", () => {
		const calls = node(
			{
				id: "t",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "c1",
							name: "read",
							arguments: { path: "/work/src/app.ts", offset: 10, limit: 5 },
						},
						{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test\nnpm run check" } },
						{
							type: "toolCall",
							id: "c3",
							name: "grep",
							arguments: { pattern: "TODO", path: "/home/user/notes" },
						},
						{ type: "toolCall", id: "c4", name: "search", arguments: { query: "vt420" } },
					],
					stopReason: "toolUse",
				},
			} as never,
			[
				result("r1", "c1", "read", [
					result("r2", "c2", "bash", [
						result("r3", "c3", "grep", [result("r4", "c4", "search", [result("r5", "gone", "write")])]),
					]),
				]),
			],
		);
		const rows = treeRows([user("u", "go", [calls])], "r5", CONTEXT);
		expect(rows.map((row) => row.text)).toEqual([
			"user: go",
			"[read]: src/app.ts:10-14",
			"[bash]: npm test npm run check",
			"[grep]: TODO in ~/notes",
			'[search]: {"query":"vt420"}',
			"[write]",
		]);
	});
});
