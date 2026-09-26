/**
 * Key bindings for the VT420 frontend.
 *
 * Defaults follow the LK401 legends DEC printed on the function-key strip: F6 Interrupt, F7 Resume,
 * F8 Cancel, F9 Main Screen, F10 Exit, F11 ESC, F12 BS, F13 LF, F14 Additional Options, Help and Do.
 * PF1-PF4 carry the frequent toggles. Emacs-style control keys work as well.
 */

export interface Vt420KeyBinding {
	keys: readonly string[];
	description: string;
}

export const VT420_KEYBINDINGS = {
	"editor.submit": { keys: ["return"], description: "Send; steer while working" },
	"editor.newline": { keys: ["ctrl+j"], description: "Insert a new line" },
	"editor.left": { keys: ["left", "ctrl+b"], description: "Cursor left" },
	"editor.right": { keys: ["right", "ctrl+f"], description: "Cursor right" },
	"editor.up": { keys: ["up"], description: "Cursor up / previous prompt" },
	"editor.down": { keys: ["down"], description: "Cursor down / next prompt" },
	"editor.wordLeft": { keys: ["alt+b", "ctrl+left", "alt+left"], description: "Word left" },
	"editor.wordRight": { keys: ["alt+f", "ctrl+right", "alt+right"], description: "Word right" },
	"editor.lineStart": { keys: ["ctrl+a", "home", "f12"], description: "Start of line" },
	"editor.lineEnd": { keys: ["ctrl+e", "end"], description: "End of line" },
	"editor.backspace": { keys: ["backspace"], description: "Delete left" },
	"editor.delete": { keys: ["remove", "ctrl+d"], description: "Delete right" },
	"editor.deleteWordBackward": { keys: ["ctrl+w", "alt+backspace", "f13"], description: "Delete word left" },
	"editor.deleteWordForward": { keys: ["alt+d"], description: "Delete word right" },
	"editor.deleteToLineStart": { keys: ["ctrl+u"], description: "Delete to start of line" },
	"editor.deleteToLineEnd": { keys: ["ctrl+k"], description: "Delete to end of line" },
	"editor.yank": { keys: ["ctrl+y", "insert"], description: "Paste deleted text" },
	"editor.complete": { keys: ["tab"], description: "Complete command" },
	"app.interrupt": { keys: ["f6", "f11", "escape"], description: "Interrupt / close" },
	"app.clear": { keys: ["ctrl+c", "f8"], description: "Cancel input" },
	"app.exit": { keys: ["ctrl+d", "f10"], description: "Exit (empty input)" },
	"app.followUp": { keys: ["do"], description: "Queue follow-up" },
	"app.help": { keys: ["help", "shift+help"], description: "Key help" },
	"app.menu": { keys: ["f14"], description: "Command menu" },
	"app.resume": { keys: ["f7"], description: "Resume session" },
	"app.mainScreen": { keys: ["f9"], description: "Back to live view" },
	"app.redraw": { keys: ["ctrl+l"], description: "Redraw screen" },
	"app.thinking.cycle": { keys: ["pf1"], description: "Thinking level" },
	"app.model.select": { keys: ["pf2", "f17"], description: "Select model" },
	"app.model.cycle": { keys: ["ctrl+p", "f18"], description: "Next model" },
	"app.thinking.toggle": { keys: ["pf3", "ctrl+t"], description: "Show thinking" },
	"app.tools.expand": { keys: ["pf4", "ctrl+o"], description: "Expand tool output" },
	"app.scroll.pageUp": { keys: ["prev"], description: "Page up" },
	"app.scroll.pageDown": { keys: ["next"], description: "Page down" },
	"app.scroll.top": { keys: ["find"], description: "Top of transcript" },
	"app.scroll.bottom": { keys: ["select"], description: "Bottom of transcript" },
	"select.up": { keys: ["up", "ctrl+p"], description: "Previous item" },
	"select.down": { keys: ["down", "ctrl+n"], description: "Next item" },
	"select.pageUp": { keys: ["prev"], description: "Previous page" },
	"select.pageDown": { keys: ["next"], description: "Next page" },
	"select.confirm": { keys: ["return", "do", "select", "kpenter"], description: "Choose" },
	"select.cancel": { keys: ["f11", "escape", "f8", "ctrl+c", "f9", "f6"], description: "Cancel" },
} as const satisfies Record<string, Vt420KeyBinding>;

export type Vt420Action = keyof typeof VT420_KEYBINDINGS;

const ALIASES: Record<string, string> = {
	enter: "return",
	cr: "return",
	lf: "ctrl+j",
	linefeed: "ctrl+j",
	del: "backspace",
	rubout: "backspace",
	bs: "backspace",
	esc: "escape",
	delete: "remove",
	pageup: "prev",
	pagedown: "next",
	prevscreen: "prev",
	nextscreen: "next",
	inserthere: "insert",
	f15: "help",
	f16: "do",
	gold: "pf1",
};

const MODIFIER_ORDER = ["ctrl", "alt", "shift"];

/** Canonical form: lowercase, aliases resolved, modifiers ordered ctrl, alt, shift. */
export function normalizeKey(spec: string): string {
	const parts = spec.toLowerCase().trim().split("+");
	const base = parts.pop() ?? "";
	const modifiers = parts.map((part) => (part === "control" ? "ctrl" : part === "meta" ? "alt" : part));
	modifiers.sort((left, right) => MODIFIER_ORDER.indexOf(left) - MODIFIER_ORDER.indexOf(right));
	const key = ALIASES[base] ?? (base === "" ? "+" : base);
	return [...new Set(modifiers), key].join("+");
}

const LABELS: Record<string, string> = {
	return: "Return",
	backspace: "<X]",
	escape: "Esc",
	tab: "Tab",
	find: "Find",
	insert: "Insert Here",
	remove: "Remove",
	select: "Select",
	prev: "Prev Screen",
	next: "Next Screen",
	help: "Help",
	do: "Do",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	home: "Home",
	end: "End",
	kpenter: "Enter",
};

export function keyLabel(key: string): string {
	const parts = key.split("+");
	const base = parts.pop()!;
	const label =
		LABELS[base] ?? (/^(f\d+|pf\d)$/.test(base) ? base.toUpperCase() : base.length === 1 ? base.toUpperCase() : base);
	return [...parts.map((part) => part[0]!.toUpperCase() + part.slice(1)), label].join("+");
}

export type Vt420KeyOverrides = Partial<Record<Vt420Action, string | readonly string[]>>;

export class Keymap {
	private readonly bindings = new Map<Vt420Action, string[]>();

	constructor(overrides: Vt420KeyOverrides = {}) {
		for (const [action, binding] of Object.entries(VT420_KEYBINDINGS) as Array<[Vt420Action, Vt420KeyBinding]>) {
			const override = overrides[action];
			const keys = override === undefined ? binding.keys : typeof override === "string" ? [override] : override;
			this.bindings.set(action, keys.map(normalizeKey));
		}
	}

	matches(key: string, action: Vt420Action): boolean {
		return this.bindings.get(action)?.includes(key) ?? false;
	}

	/** The first action in `actions` bound to `key`. */
	find<T extends Vt420Action>(key: string, actions: readonly T[]): T | undefined {
		return actions.find((action) => this.matches(key, action));
	}

	keys(action: Vt420Action): readonly string[] {
		return this.bindings.get(action) ?? [];
	}

	/** Display label of the first key bound to `action`, e.g. "PF1" or "Ctrl+C". */
	label(action: Vt420Action): string {
		const key = this.keys(action)[0];
		return key ? keyLabel(key) : "unbound";
	}
}
