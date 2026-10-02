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
		const rows = treeRows(tree, "c2");
		expect(rows.map((row) => `${row.prefix}${row.onPath ? "* " : ""}${row.text}`)).toEqual([
			"* user: first",
			"* assistant: one",
			"├─ * user: third",
			"│  * assistant: three",
			"└─ user: second",
			"   assistant: two",
		]);
	});
});
