/**
 * The session tree as rows for the selector, as pi's /tree lists it: depth first with the branch that holds the
 * current point first, line drawing where the tree splits, and a dot on the path the session stands on. Bookkeeping
 * entries (model and thinking changes, labels, usage) and assistant turns that only called tools stay out of it.
 */

import { contentText } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";

export interface TreeRow {
	id: string;
	/** Line drawing for where the row sits in the tree. */
	prefix: string;
	text: string;
	/** On the path from the root to where the session stands. */
	onPath: boolean;
	label?: string;
}

const HIDDEN = new Set([
	"label",
	"context_edit",
	"custom",
	"model_change",
	"thinking_level_change",
	"session_info",
	"usage",
]);

/** Whitespace as single spaces, at most 200 characters. */
function flat(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function visible(entry: SessionEntry, leafId: string | null): boolean {
	if (entry.id === leafId) return true;
	if (HIDDEN.has(entry.type)) return false;
	if (entry.type !== "message" || entry.message.role !== "assistant") return true;
	const message = entry.message;
	return (
		contentText(message.content, "").trim() !== "" ||
		(message.stopReason !== "stop" && message.stopReason !== "toolUse")
	);
}

function rowText(entry: SessionEntry): string {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			switch (message.role) {
				case "user":
					return `user: ${flat(contentText(message.content, " "))}`;
				case "assistant": {
					const text = flat(contentText(message.content, " "));
					if (text) return `assistant: ${text}`;
					if (message.stopReason === "aborted") return "assistant: (aborted)";
					return message.errorMessage
						? `assistant: ${flat(message.errorMessage).slice(0, 80)}`
						: "assistant: (no content)";
				}
				case "toolResult":
					return `[${message.toolName}]`;
				case "bashExecution":
					return `[bash]: ${flat(message.command)}`;
				default:
					return `[${message.role}]`;
			}
		}
		case "compaction":
			return `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`;
		case "branch_summary":
			return `[branch summary]: ${flat(entry.summary)}`;
		case "custom_message":
			return `[${entry.customType}]: ${flat(contentText(entry.content, " "))}`;
		case "model_change":
			return `[model: ${entry.modelId}]`;
		case "thinking_level_change":
			return `[thinking: ${entry.thinkingLevel}]`;
		default:
			return `[${entry.type}]`;
	}
}

export function treeRows(roots: readonly SessionTreeNode[], leafId: string | null): TreeRow[] {
	const parents = new Map<string, string | null>();
	const pending = [...roots];
	for (let node = pending.pop(); node; node = pending.pop()) {
		parents.set(node.entry.id, node.entry.parentId);
		pending.push(...node.children);
	}
	const path = new Set<string>();
	for (let id = leafId; id !== null && !path.has(id); id = parents.get(id) ?? null) path.add(id);
	// the branch holding the current point first, the rest in the order they were made
	const ordered = (nodes: readonly SessionTreeNode[]): SessionTreeNode[] =>
		[...nodes].sort((left, right) => Number(path.has(right.entry.id)) - Number(path.has(left.entry.id)));

	const rows: TreeRow[] = [];
	// depth first without recursion, since a long session is one long chain
	const stack: Array<{ node: SessionTreeNode; prefix: string; connector: string }> = [];
	const pushAll = (nodes: readonly SessionTreeNode[], prefix: string): void => {
		const children = ordered(nodes);
		const split = children.length > 1;
		for (let index = children.length - 1; index >= 0; index--) {
			const last = index === children.length - 1;
			stack.push({ node: children[index]!, prefix, connector: split ? (last ? "└─ " : "├─ ") : "" });
		}
	};
	pushAll(roots, "");
	for (let item = stack.pop(); item; item = stack.pop()) {
		const { node, prefix, connector } = item;
		// a hidden entry with one child leaves it its place in the tree
		if (!visible(node.entry, leafId) && node.children.length === 1) {
			stack.push({ node: node.children[0]!, prefix, connector });
			continue;
		}
		if (visible(node.entry, leafId)) {
			rows.push({
				id: node.entry.id,
				prefix: prefix + connector,
				text: rowText(node.entry),
				onPath: path.has(node.entry.id),
				...(node.label ? { label: node.label } : {}),
			});
		}
		pushAll(node.children, prefix + (connector === "├─ " ? "│  " : connector === "└─ " ? "   " : ""));
	}
	return rows;
}
