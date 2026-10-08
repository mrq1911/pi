import {
	ATTR_BOLD,
	ATTR_UNDERLINE,
	GLYPH_MASK,
	LINE_DOUBLE_BOTTOM,
	LINE_DOUBLE_TOP,
	LINE_DOUBLE_WIDTH,
	LINE_SINGLE,
} from "@mrq/vt420/cells.js";
import { Charset } from "@mrq/vt420/charset.js";
import { cellsText, linesText } from "@mrq/vt420-emu/emulator.js";
import { describe, expect, it } from "vitest";
import { LineEditor } from "../src/experimental/vt420/editor.ts";
import { renderMarkdown } from "../src/experimental/vt420/markdown.ts";

const charset = new Charset({ technical: true, supplemental: "dec", eightBit: false });

function render(markdown: string, width = 40) {
	return renderMarkdown(markdown, { width, charset, largeHeadings: true });
}

function attrsOf(cells: readonly number[], text: string, within: string): number {
	const index = within.indexOf(text);
	return (cells[index] ?? 0) & ~GLYPH_MASK;
}

describe("vt420 markdown", () => {
	it("renders short level-1 headings double height and level-2 double width", () => {
		const lines = render("# Title\n\n## Section\n\n### Detail");
		expect(lines.map((line) => line.attr)).toEqual([
			LINE_DOUBLE_TOP,
			LINE_DOUBLE_BOTTOM,
			LINE_SINGLE,
			LINE_DOUBLE_WIDTH,
			LINE_SINGLE,
			LINE_SINGLE,
		]);
		expect(linesText(lines)).toEqual(["Title", "Title", "", "Section", "", "Detail"]);
		expect(lines[5]!.cells[0]! & ~GLYPH_MASK).toBe(ATTR_BOLD | ATTR_UNDERLINE);
	});

	it("falls back to underlined bold text when a heading is too wide to double", () => {
		const lines = render("# A heading that is far too long to double", 40);
		expect(lines.every((line) => line.attr === LINE_SINGLE)).toBe(true);
		expect(lines[0]!.cells[0]! & ATTR_UNDERLINE).toBe(ATTR_UNDERLINE);
	});

	it("wraps paragraphs and maps emphasis to VT420 attributes", () => {
		const lines = render("Plain **bold** *emphasis* and `code` in a sentence that wraps", 30);
		const text = linesText(lines);
		expect(text).toEqual(["Plain bold emphasis and code", "in a sentence that wraps"]);
		const first = lines[0]!.cells;
		expect(attrsOf(first, "bold", text[0]!)).toBe(ATTR_BOLD);
		expect(attrsOf(first, "emphasis", text[0]!)).toBe(ATTR_UNDERLINE);
		expect(attrsOf(first, "code", text[0]!)).toBe(ATTR_BOLD);
	});

	it("draws lists with DEC bullets, numbers and task boxes", () => {
		expect(linesText(render("- one\n  - nested\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo"))).toEqual([
			"◆ one",
			"  · nested",
			"◆ two",
			"",
			"1. first",
			"2. second",
			"",
			"[√] done",
			"[ ] todo",
		]);
	});

	it("boxes code blocks with line drawing and keeps their spacing", () => {
		expect(linesText(render("```ts\nif (x) {\n\treturn 1;\n}\n```", 24))).toEqual([
			"┌─ ts ──────────────────",
			"│ if (x) {",
			"│     return 1;",
			"│ }",
			"└───────────────────────",
		]);
	});

	it("draws tables with box glyphs and aligned columns", () => {
		expect(linesText(render("| Name | Qty |\n|------|----:|\n| π | 3 |\n| ≤ | 12 |"))).toEqual([
			"┌──────┬─────┐",
			"│ Name │ Qty │",
			"├──────┼─────┤",
			"│ π    │   3 │",
			"│ ≤    │  12 │",
			"└──────┴─────┘",
		]);
	});

	it("renders quotes, rules and links", () => {
		expect(linesText(render("> quoted\n\n---\n\n[pi](https://pi.dev) and <https://x.y>", 20))).toEqual([
			"│ quoted",
			"",
			"────────────────────",
			"",
			"pi (https://pi.dev)",
			"and https://x.y",
		]);
	});
});

describe("vt420 editor", () => {
	const prompt = charset.cells("π ");

	it("edits across lines", () => {
		const editor = new LineEditor();
		editor.insert("hello world");
		editor.wordLeft();
		editor.deleteWordForward();
		editor.insert("there");
		editor.newline();
		editor.insert("second");
		expect(editor.text).toBe("hello there\nsecond");
		editor.lineStart();
		editor.backspace();
		expect(editor.text).toBe("hello theresecond");
		editor.deleteToLineEnd();
		editor.yank();
		expect(editor.text).toBe("hello theresecond");
	});

	it("recalls history at the first and last line", () => {
		const editor = new LineEditor();
		editor.addToHistory("first");
		editor.addToHistory("second");
		editor.insert("draft");
		editor.historyPrevious();
		expect(editor.text).toBe("second");
		editor.historyPrevious();
		expect(editor.text).toBe("first");
		editor.historyNext();
		editor.historyNext();
		expect(editor.text).toBe("draft");
	});

	it("wraps at the width, marks typed newlines with ␤ and tracks the cursor", () => {
		const editor = new LineEditor();
		editor.insert("abcdefghij\nxyz");
		const layout = editor.layout(8, charset, prompt);
		expect(layout.rows.map((row) => cellsText(row))).toEqual(["π abcdef", "  ghij", "␤ xyz"]);
		expect({ row: layout.cursorRow, col: layout.cursorCol }).toEqual({ row: 2, col: 5 });
	});

	it("masks secrets", () => {
		const editor = new LineEditor();
		editor.secret = true;
		editor.insert("sk-123");
		expect(cellsText(editor.layout(40, charset, prompt).rows[0]!)).toBe("π ······");
	});
});
