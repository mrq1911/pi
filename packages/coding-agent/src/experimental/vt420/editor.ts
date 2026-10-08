/**
 * Multi-line input editor.
 *
 * Text is a list of lines of Unicode characters. Layout wraps at character boundaries: the first row
 * starts with the π prompt, rows after a typed newline start with the DEC "NL" glyph (␤), and wrapped
 * rows are indented.
 */

import { ATTR_BOLD } from "@mrq/vt420/cells.js";
import type { Charset } from "@mrq/vt420/charset.js";

export interface EditorLayout {
	rows: number[][];
	cursorRow: number;
	cursorCol: number;
}

export class LineEditor {
	private lines: string[][] = [[]];
	private row = 0;
	private col = 0;
	private history: string[] = [];
	private historyIndex = -1;
	private draft: string | undefined;
	private killed = "";
	/** Render characters as middle dots, for secrets. */
	secret = false;

	get text(): string {
		return this.lines.map((line) => line.join("")).join("\n");
	}

	get empty(): boolean {
		return this.lines.length === 1 && this.lines[0]!.length === 0;
	}

	setText(text: string): void {
		this.lines = text.split("\n").map((line) => [...line]);
		this.row = this.lines.length - 1;
		this.col = this.lines[this.row]!.length;
	}

	clear(): void {
		this.setText("");
		this.historyIndex = -1;
		this.draft = undefined;
	}

	insert(text: string): void {
		const parts = text.replace(/\r\n?/g, "\n").split("\n");
		parts.forEach((part, index) => {
			if (index > 0) this.newline();
			const chars = [...part].filter((char) => char >= " " || char === "\t");
			this.lines[this.row]!.splice(this.col, 0, ...chars);
			this.col += chars.length;
		});
	}

	newline(): void {
		const line = this.lines[this.row]!;
		const rest = line.splice(this.col);
		this.lines.splice(this.row + 1, 0, rest);
		this.row++;
		this.col = 0;
	}

	backspace(): void {
		if (this.col > 0) {
			this.lines[this.row]!.splice(--this.col, 1);
		} else if (this.row > 0) {
			const line = this.lines.splice(this.row, 1)[0]!;
			this.row--;
			this.col = this.lines[this.row]!.length;
			this.lines[this.row]!.push(...line);
		}
	}

	deleteForward(): void {
		const line = this.lines[this.row]!;
		if (this.col < line.length) line.splice(this.col, 1);
		else if (this.row < this.lines.length - 1) line.push(...this.lines.splice(this.row + 1, 1)[0]!);
	}

	left(): void {
		if (this.col > 0) this.col--;
		else if (this.row > 0) {
			this.row--;
			this.col = this.lines[this.row]!.length;
		}
	}

	right(): void {
		if (this.col < this.lines[this.row]!.length) this.col++;
		else if (this.row < this.lines.length - 1) {
			this.row++;
			this.col = 0;
		}
	}

	/** Move up a line; returns false at the first line so the caller can recall history. */
	up(): boolean {
		if (this.row === 0) return false;
		this.row--;
		this.col = Math.min(this.col, this.lines[this.row]!.length);
		return true;
	}

	down(): boolean {
		if (this.row === this.lines.length - 1) return false;
		this.row++;
		this.col = Math.min(this.col, this.lines[this.row]!.length);
		return true;
	}

	lineStart(): void {
		this.col = 0;
	}

	lineEnd(): void {
		this.col = this.lines[this.row]!.length;
	}

	wordLeft(): void {
		const line = this.lines[this.row]!;
		if (this.col === 0) {
			this.left();
			return;
		}
		while (this.col > 0 && !isWord(line[this.col - 1]!)) this.col--;
		while (this.col > 0 && isWord(line[this.col - 1]!)) this.col--;
	}

	wordRight(): void {
		const line = this.lines[this.row]!;
		if (this.col === line.length) {
			this.right();
			return;
		}
		while (this.col < line.length && !isWord(line[this.col]!)) this.col++;
		while (this.col < line.length && isWord(line[this.col]!)) this.col++;
	}

	deleteWordBackward(): void {
		if (this.col === 0) {
			this.backspace();
			return;
		}
		const end = this.col;
		this.wordLeft();
		this.killed = this.lines[this.row]!.splice(this.col, end - this.col).join("");
	}

	deleteWordForward(): void {
		const start = this.col;
		const line = this.lines[this.row]!;
		if (start === line.length) {
			this.deleteForward();
			return;
		}
		this.wordRight();
		this.killed = line.splice(start, this.col - start).join("");
		this.col = start;
	}

	deleteToLineStart(): void {
		this.killed = this.lines[this.row]!.splice(0, this.col).join("");
		this.col = 0;
	}

	deleteToLineEnd(): void {
		const line = this.lines[this.row]!;
		if (this.col === line.length) {
			this.deleteForward();
			return;
		}
		this.killed = line.splice(this.col).join("");
	}

	yank(): void {
		if (this.killed) this.insert(this.killed);
	}

	addToHistory(text: string): void {
		if (!text.trim() || this.history.at(-1) === text) return;
		this.history.push(text);
		if (this.history.length > 200) this.history.shift();
	}

	/** Start the history over with these, oldest first, as a session's prompts. */
	resetHistory(texts: readonly string[]): void {
		this.history = [];
		this.historyIndex = -1;
		this.draft = undefined;
		for (const text of texts) this.addToHistory(text);
	}

	historyPrevious(): void {
		if (this.history.length === 0) return;
		if (this.historyIndex === -1) {
			this.draft = this.text;
			this.historyIndex = this.history.length - 1;
		} else if (this.historyIndex > 0) this.historyIndex--;
		else return;
		this.setText(this.history[this.historyIndex]!);
	}

	historyNext(): void {
		if (this.historyIndex === -1) return;
		if (this.historyIndex < this.history.length - 1) {
			this.historyIndex++;
			this.setText(this.history[this.historyIndex]!);
		} else {
			this.historyIndex = -1;
			this.setText(this.draft ?? "");
			this.draft = undefined;
		}
	}

	/** Lay out for `width` columns. The prompt occupies the first cells of the first row. */
	layout(width: number, charset: Charset, prompt: readonly number[]): EditorLayout {
		const rows: number[][] = [];
		const indent = prompt.length;
		const newlineMark = [charset.cell("␤"), ...charset.cells(" ".repeat(Math.max(0, indent - 1)))];
		const wrapIndent = charset.cells(" ".repeat(indent));
		let cursorRow = 0;
		let cursorCol = indent;
		const secretCell = charset.cell("·", ATTR_BOLD);
		this.lines.forEach((line, lineIndex) => {
			let row = [...(lineIndex === 0 ? prompt : newlineMark)];
			for (let index = 0; index <= line.length; index++) {
				if (lineIndex === this.row && index === this.col) {
					if (row.length >= width) {
						rows.push(row);
						row = [...wrapIndent];
					}
					cursorRow = rows.length;
					cursorCol = row.length;
				}
				if (index === line.length) break;
				const char = line[index]!;
				const cells = this.secret ? [secretCell] : charset.cells(char === "\t" ? " " : char);
				for (const cell of cells) {
					if (row.length >= width) {
						rows.push(row);
						row = [...wrapIndent];
					}
					row.push(cell);
				}
			}
			rows.push(row);
		});
		return { rows, cursorRow, cursorCol };
	}
}

function isWord(char: string): boolean {
	return /[\p{L}\p{N}_]/u.test(char);
}
