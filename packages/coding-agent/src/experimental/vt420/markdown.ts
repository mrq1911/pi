/**
 * Markdown for a monochrome VT420.
 *
 * Emphasis maps to the attributes the terminal has: bold for strong text and inline code, underline for
 * emphasis. Headings use the double-height and double-width line attributes; code blocks, quotes and tables
 * are drawn with DEC Special Graphics line-drawing glyphs.
 */

import { Marked, type Token, type Tokens } from "@earendil-works/pi-tui";
import {
	ATTR_BOLD,
	ATTR_UNDERLINE,
	LINE_DOUBLE_BOTTOM,
	LINE_DOUBLE_TOP,
	LINE_DOUBLE_WIDTH,
	LINE_SINGLE,
	type Line,
} from "./cells.ts";
import type { Charset } from "./charset.ts";
import {
	decodeEntities,
	expandTabs,
	hardWrap,
	NEWLINE,
	padCells,
	prefixRows,
	spaces,
	splitCells,
	stripAnsi,
	toLines,
	wrapCells,
} from "./text.ts";

export interface MarkdownOptions {
	width: number;
	charset: Charset;
	/** Use DECDHL for level-1 and DECDWL for level-2 headings when they fit. */
	largeHeadings: boolean;
}

const parser = new Marked();
const BULLETS = ["◆", "·", "-"];

export function renderMarkdown(markdown: string, options: MarkdownOptions): Line[] {
	const tokens = parser.lexer(expandTabs(markdown));
	return new MarkdownRenderer(options).blocks(tokens, Math.max(8, options.width), 0, false);
}

class MarkdownRenderer {
	private readonly options: MarkdownOptions;

	constructor(options: MarkdownOptions) {
		this.options = options;
	}

	private cells(text: string, attrs = 0): number[] {
		return this.options.charset.cells(text, attrs);
	}

	blocks(tokens: readonly Token[], width: number, depth: number, tight: boolean): Line[] {
		const out: Line[] = [];
		for (const token of tokens) {
			if (token.type === "space") continue;
			const lines = this.block(token, width, depth);
			if (lines.length === 0) continue;
			if (out.length > 0 && !tight) out.push({ cells: [], attr: LINE_SINGLE });
			out.push(...lines);
		}
		return out;
	}

	private block(token: Token, width: number, depth: number): Line[] {
		switch (token.type) {
			case "heading":
				return this.heading(token as Tokens.Heading, width, depth);
			case "paragraph":
			case "text":
				return this.paragraph(token as Tokens.Paragraph | Tokens.Text, width);
			case "code":
				return this.code(token as Tokens.Code, width);
			case "blockquote":
				return this.quote(token as Tokens.Blockquote, width, depth);
			case "list":
				return this.list(token as Tokens.List, width, depth);
			case "table":
				return this.table(token as Tokens.Table, width);
			case "hr":
				return [{ cells: this.cells("─".repeat(width)), attr: LINE_SINGLE }];
			case "html": {
				const text = (token as Tokens.HTML).text.replace(/<[^>]*>/g, "").trim();
				return text
					? toLines(splitCells(this.text(decodeEntities(text))).flatMap((row) => wrapCells(row, width)))
					: [];
			}
			default: {
				const text = "text" in token && typeof token.text === "string" ? token.text : "";
				return text ? toLines(wrapCells(this.text(text), width)) : [];
			}
		}
	}

	private heading(token: Tokens.Heading, width: number, depth: number): Line[] {
		const cells = splitCells(this.inline(token.tokens, ATTR_BOLD)).flat();
		const half = Math.floor(width / 2);
		if (this.options.largeHeadings && depth === 0 && cells.length <= half) {
			if (token.depth === 1) {
				return [
					{ cells, attr: LINE_DOUBLE_TOP },
					{ cells: [...cells], attr: LINE_DOUBLE_BOTTOM },
				];
			}
			if (token.depth === 2) return [{ cells, attr: LINE_DOUBLE_WIDTH }];
		}
		const attrs = token.depth <= 3 ? ATTR_UNDERLINE : 0;
		return toLines(
			wrapCells(
				cells.map((cell) => cell | attrs),
				width,
			),
		);
	}

	private paragraph(token: Tokens.Paragraph | Tokens.Text, width: number): Line[] {
		const inline = "tokens" in token && token.tokens ? this.inline(token.tokens) : this.text(token.text);
		return toLines(splitCells(inline).flatMap((row) => wrapCells(row, width)));
	}

	private code(token: Tokens.Code, width: number): Line[] {
		const label = token.lang ? ` ${token.lang.split(/\s/)[0]} ` : "";
		const top = [
			...this.cells("┌─"),
			...this.cells(label),
			...this.cells("─".repeat(Math.max(0, width - 2 - label.length))),
		];
		const lines: Line[] = [{ cells: top.slice(0, width), attr: LINE_SINGLE }];
		const gutter = this.cells("│ ");
		for (const source of stripAnsi(token.text).split("\n")) {
			for (const row of hardWrap(this.cells(source), width - gutter.length)) {
				lines.push({ cells: [...gutter, ...row], attr: LINE_SINGLE });
			}
		}
		lines.push({ cells: this.cells(`└${"─".repeat(Math.max(0, width - 1))}`), attr: LINE_SINGLE });
		return lines;
	}

	private quote(token: Tokens.Blockquote, width: number, depth: number): Line[] {
		const bar = this.cells("│ ");
		return this.blocks(token.tokens, width - bar.length, depth + 1, false).map((line) => ({
			cells: [...bar, ...line.cells],
			attr: LINE_SINGLE,
		}));
	}

	private list(token: Tokens.List, width: number, depth: number): Line[] {
		const out: Line[] = [];
		const start = typeof token.start === "number" ? token.start : 1;
		const numberWidth = token.ordered ? String(start + token.items.length - 1).length + 1 : 0;
		token.items.forEach((item, index) => {
			let marker: string;
			if (item.task) marker = item.checked ? "[√]" : "[ ]";
			else if (token.ordered) marker = `${start + index}.`.padStart(numberWidth);
			else marker = BULLETS[depth % BULLETS.length]!;
			const markerCells = this.cells(`${marker} `);
			const children = item.tokens.filter((child) => child.type !== "checkbox");
			const inner = this.blocks(children, width - markerCells.length, depth + 1, !token.loose);
			if (token.loose && index > 0) out.push({ cells: [], attr: LINE_SINGLE });
			if (inner.length === 0) inner.push({ cells: [], attr: LINE_SINGLE });
			const rows = prefixRows(
				inner.map((line) => line.cells),
				markerCells,
				spaces(markerCells.length),
			);
			for (const cells of rows) out.push({ cells, attr: LINE_SINGLE });
		});
		return out;
	}

	private table(token: Tokens.Table, width: number): Line[] {
		const count = token.header.length;
		const header = token.header.map((cell) => splitCells(this.inline(cell.tokens, ATTR_BOLD)).flat());
		const rows = token.rows.map((row) => row.map((cell) => splitCells(this.inline(cell.tokens)).flat()));
		const available = width - (3 * count + 1);
		if (count === 0 || available < count * 2) {
			const flat = [header, ...rows].map((row) =>
				row.flatMap((cell, index) => (index === 0 ? cell : [...this.cells(" · "), ...cell])),
			);
			return toLines(flat.flatMap((row) => wrapCells(row, width)));
		}
		const widths = header.map((cell, column) =>
			Math.max(1, cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
		);
		while (widths.reduce((sum, value) => sum + value, 0) > available) {
			let widest = 0;
			for (let column = 1; column < count; column++) if (widths[column]! > widths[widest]!) widest = column;
			widths[widest]!--;
		}
		const rule = (left: string, middle: string, right: string): Line => ({
			cells: this.cells(left + widths.map((value) => "─".repeat(value + 2)).join(middle) + right),
			attr: LINE_SINGLE,
		});
		const renderRow = (cells: number[][]): Line[] => {
			const wrapped = widths.map((value, column) => wrapCells(cells[column] ?? [], value));
			const height = Math.max(1, ...wrapped.map((lines) => lines.length));
			const out: Line[] = [];
			for (let line = 0; line < height; line++) {
				const row: number[] = [...this.cells("│")];
				widths.forEach((value, column) => {
					const content = wrapped[column]![line] ?? [];
					const pad = value - content.length;
					const align = token.align[column];
					const left = align === "right" ? pad : align === "center" ? Math.floor(pad / 2) : 0;
					row.push(...spaces(1 + left), ...content, ...spaces(1 + pad - left), ...this.cells("│"));
				});
				out.push({ cells: row, attr: LINE_SINGLE });
			}
			return out;
		};
		return [
			rule("┌", "┬", "┐"),
			...renderRow(header),
			rule("├", "┼", "┤"),
			...rows.flatMap((row) => renderRow(row)),
			rule("└", "┴", "┘"),
		];
	}

	private text(text: string, attrs = 0): number[] {
		const out: number[] = [];
		const parts = text.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) out.push(NEWLINE);
			out.push(...this.cells(part, attrs));
		});
		return out;
	}

	private inline(tokens: readonly Token[] | undefined, attrs = 0): number[] {
		const out: number[] = [];
		for (const token of tokens ?? []) {
			switch (token.type) {
				case "text": {
					const text = token as Tokens.Text;
					if (text.tokens && text.tokens.length > 0) out.push(...this.inline(text.tokens, attrs));
					else out.push(...this.text(decodeEntities(text.text), attrs));
					break;
				}
				case "escape":
					out.push(...this.text((token as Tokens.Escape).text, attrs));
					break;
				case "strong":
					out.push(...this.inline((token as Tokens.Strong).tokens, attrs | ATTR_BOLD));
					break;
				case "em":
					out.push(...this.inline((token as Tokens.Em).tokens, attrs | ATTR_UNDERLINE));
					break;
				case "codespan":
					out.push(...this.cells((token as Tokens.Codespan).text.replace(/\n/g, " "), attrs | ATTR_BOLD));
					break;
				case "del":
					out.push(...this.inline((token as Tokens.Del).tokens, attrs));
					break;
				case "link": {
					const link = token as Tokens.Link;
					out.push(...this.inline(link.tokens, attrs | ATTR_UNDERLINE));
					const href = link.href.startsWith("mailto:") ? link.href.slice(7) : link.href;
					if (link.text !== link.href && link.text !== href) out.push(...this.cells(` (${link.href})`, attrs));
					break;
				}
				case "image": {
					const image = token as Tokens.Image;
					out.push(...this.cells(`[image: ${image.text || image.href}]`, attrs));
					break;
				}
				case "br":
					out.push(NEWLINE);
					break;
				case "html":
					out.push(...this.text((token as Tokens.HTML).text, attrs));
					break;
				case "checkbox":
					break;
				default:
					if ("tokens" in token && Array.isArray(token.tokens)) out.push(...this.inline(token.tokens, attrs));
					else if ("text" in token && typeof token.text === "string") out.push(...this.text(token.text, attrs));
			}
		}
		return out;
	}
}

export function padLine(line: Line, width: number): Line {
	return { cells: padCells(line.cells, width), attr: line.attr };
}
