import { BLANK, isSpace, LINE_SINGLE, type Line, type LineAttr } from "./cells.ts";

const ANSI_SEQUENCE =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]*[0-~]|\x9b[0-?]*[ -/]*[@-~]/g;

/** Remove terminal escape sequences a tool or model may have produced. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_SEQUENCE, "");
}

/** Expand tabs to the next multiple of `tabWidth` within each line. */
export function expandTabs(text: string, tabWidth = 4): string {
	if (!text.includes("\t")) return text;
	let result = "";
	let column = 0;
	for (const char of text) {
		if (char === "\t") {
			const spaces = tabWidth - (column % tabWidth);
			result += " ".repeat(spaces);
			column += spaces;
		} else if (char === "\n") {
			result += char;
			column = 0;
		} else {
			result += char;
			column++;
		}
	}
	return result;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name: string) => {
		const lower = name.toLowerCase();
		if (ENTITIES[lower] !== undefined) return ENTITIES[lower]!;
		if (lower.startsWith("#x")) return safeCodePoint(Number.parseInt(lower.slice(2), 16)) ?? match;
		if (lower.startsWith("#")) return safeCodePoint(Number.parseInt(lower.slice(1), 10)) ?? match;
		return match;
	});
}

function safeCodePoint(value: number): string | undefined {
	return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : undefined;
}

/** Greedy word wrap. Continuation lines drop the spaces they would start with. */
export function wrapCells(cells: readonly number[], width: number): number[][] {
	if (width <= 0) return [cells.slice()];
	const out: number[][] = [];
	let line: number[] = [];
	for (const cell of cells) {
		if (line.length === 0 && out.length > 0 && isSpace(cell)) continue;
		line.push(cell);
		if (line.length <= width) continue;
		let breakAt = -1;
		for (let index = line.length - 1; index > 0; index--) {
			if (isSpace(line[index]!)) {
				breakAt = index;
				break;
			}
		}
		if (breakAt > 0) {
			out.push(trimEnd(line.slice(0, breakAt)));
			line = line.slice(breakAt + 1);
			while (line.length > 0 && isSpace(line[0]!)) line.shift();
		} else {
			out.push(line.slice(0, width));
			line = line.slice(width);
		}
	}
	out.push(trimEnd(line));
	return out;
}

/** Break at exactly `width` cells, keeping spaces; used for code and tool output. */
export function hardWrap(cells: readonly number[], width: number): number[][] {
	if (width <= 0 || cells.length <= width) return [cells.slice()];
	const out: number[][] = [];
	for (let start = 0; start < cells.length; start += width) out.push(cells.slice(start, start + width));
	return out;
}

export function trimEnd(cells: number[]): number[] {
	let end = cells.length;
	while (end > 0 && cells[end - 1] === BLANK) end--;
	return end === cells.length ? cells : cells.slice(0, end);
}

export function truncateCells(cells: readonly number[], width: number, ellipsis: readonly number[]): number[] {
	if (cells.length <= width) return cells.slice();
	if (width <= ellipsis.length) return cells.slice(0, width);
	return [...cells.slice(0, width - ellipsis.length), ...ellipsis];
}

export function padCells(cells: readonly number[], width: number, fill = BLANK): number[] {
	if (cells.length >= width) return cells.slice(0, width);
	return [...cells, ...new Array(width - cells.length).fill(fill)];
}

export function spaces(count: number, attrs = 0): number[] {
	return new Array(Math.max(0, count)).fill(BLANK | attrs);
}

export function toLines(rows: number[][], attr: LineAttr = LINE_SINGLE): Line[] {
	return rows.map((cells) => ({ cells, attr }));
}

/** Prefix the first row with `first` and every other row with `rest`. */
export function prefixRows(rows: number[][], first: readonly number[], rest: readonly number[]): number[][] {
	return rows.map((row, index) => [...(index === 0 ? first : rest), ...row]);
}

/** Split cells at newline markers produced by `NEWLINE`. */
export const NEWLINE = -1;

export function splitCells(cells: readonly number[]): number[][] {
	const rows: number[][] = [[]];
	for (const cell of cells) {
		if (cell === NEWLINE) rows.push([]);
		else rows[rows.length - 1]!.push(cell);
	}
	return rows;
}

/** "45s", "3m 07s" or "1h 05m": seconds tick while it is short, minutes once it runs for hours. */
/** How long ago `date` was, in words: "just now", "5 min ago", "3 hours ago", "yesterday", "2 weeks ago". */
export function formatAge(date: Date, now: Date = new Date()): string {
	const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
	// by the calendar, so last night is yesterday
	const midnight = (day: Date): number => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
	const days = Math.max(1, Math.round((midnight(now) - midnight(date)) / 86_400_000));
	const ago = (count: number, unit: string): string => (count === 1 ? `a ${unit} ago` : `${count} ${unit}s ago`);
	if (days === 1) return "yesterday";
	if (days < 7) return ago(days, "day");
	if (days < 30) return ago(Math.floor(days / 7), "week");
	if (days < 365) return ago(Math.floor(days / 30), "month");
	return ago(Math.floor(days / 365), "year");
}

export function formatDuration(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	if (whole < 60) return `${whole}s`;
	const minutes = Math.floor(whole / 60);
	if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
