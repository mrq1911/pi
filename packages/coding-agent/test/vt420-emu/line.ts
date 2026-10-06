// vt420-term's src/emu/line.ts (github.com/mrq1911/vt420-term), copied for these tests: change it there, then copy it here.
/**
 * The serial line between a host and the VT420, and the terminal's end of it (Appendix B of the programmer
 * reference): characters ten bit times apart each way; a 254-character input buffer that sends XOFF at Set-Up's
 * first point (64 or 128), again at 220 and at every character that finds it full (which is lost), and XON once it
 * is down to 32; input waiting while the terminal glides a line or Hold Screen holds it; and answers sent back at
 * the line's speed, or 150 to 180 characters a second with limited transmit.
 *
 * The host stops some characters after an XOFF reaches it, or never, as a tty without ixon (one ssh took it from)
 * does. Time comes from a clock: the real one, or a manual one that tests move a step at a time.
 */

import { type SmoothScroll, TIMING, type Vt420 } from "./vt420.ts";

export interface Clock {
	/** Milliseconds. */
	now(): number;
	after(ms: number, run: () => void): void;
}

export const realClock: Clock = {
	now: () => performance.now(),
	after: (ms, run) => {
		setTimeout(run, Math.max(0, ms));
	},
};

/** A clock that moves only when told to, running what comes due on the way. */
export class ManualClock implements Clock {
	private time = 0;
	private timers: Array<{ at: number; order: number; run: () => void }> = [];
	private order = 0;

	now(): number {
		return this.time;
	}

	after(ms: number, run: () => void): void {
		this.timers.push({ at: this.time + Math.max(0, ms), order: this.order++, run });
	}

	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			this.timers.sort((a, b) => a.at - b.at || a.order - b.order);
			const next = this.timers[0];
			if (!next || next.at > end) break;
			this.timers.shift();
			this.time = next.at;
			next.run();
		}
		this.time = end;
	}

	/** Advance until nothing is due any more, or `limit` ms have passed. */
	settle(limit = 600_000): void {
		const end = this.time + limit;
		while (this.timers.length > 0 && this.time < end) {
			const next = Math.min(...this.timers.map((timer) => timer.at));
			this.advance(Math.max(0, Math.min(next, end) - this.time));
		}
	}
}

export interface LineOptions {
	/** Bits a second each way; a character is ten bits (8N1). */
	baud: number;
	/**
	 * Characters the host still sends after an XOFF reaches it: an FTDI adapter with ixon stops within a character
	 * or two. Undefined for a host that never stops, as a tty that ssh took ixon from.
	 */
	hostStopsAfter?: number;
	/** How long a smooth scroll takes to glide a line, the terminal taking nothing in meanwhile; a VT420's by default. */
	glideMs?: number;
	/** False takes everything in at once but the glides, rather than at the terminal's own pace (see TIMING). */
	timing?: boolean;
	clock?: Clock;
	/** What reaches the host: answers and typed keys, as bytes in a latin1 string. XON and XOFF go to `onFlow`. */
	onHost?: (bytes: string) => void;
	/** XOFF (true) or XON reaching the host. */
	onFlow?: (xoff: boolean) => void;
	/** A line glides, taking `ms`. */
	onGlide?: (event: SmoothScroll, ms: number) => void;
}

export interface LineStats {
	/** The most characters the input buffer held. */
	peak: number;
	/** Characters lost to a full input buffer. */
	lost: number;
	xoffs: number;
	xons: number;
	glides: number;
	/** Characters that crossed from the host. */
	received: number;
}

/** The input buffer's size, and where flow control acts in it (Appendix B). */
const BUFFER = 254;
const SECOND_XOFF = 220;
const XON_POINT = 32;
const XON = 0x11;
const XOFF = 0x13;
/** Limited transmit: 150 to 180 characters a second, evenly spaced. */
const LIMITED_MS = 1000 / 165;

export class SerialLine {
	readonly stats: LineStats = { peak: 0, lost: 0, xoffs: 0, xons: 0, glides: 0, received: 0 };
	private readonly options: LineOptions;
	private readonly clock: Clock;
	private readonly charMs: number;
	private term: Vt420 | undefined;
	/** Simulated time, which catches up with the clock at each pump. */
	private time: number;
	// the host's side
	private readonly toTerminal: number[] = [];
	/** When each of those was written: nothing goes out before it was written. */
	private readonly writtenAt: number[] = [];
	private hostArrival: number | undefined;
	private hostStopping: number | undefined;
	private hostStopped = false;
	// the terminal's side
	private readonly buffer: number[] = [];
	private busyUntil: number | undefined;
	private held = false;
	private lastFlow: number | undefined;
	private sentFirstXoff = false;
	private sentSecondXoff = false;
	private transmitStopped = false;
	private readonly toHost: number[] = [];
	private readonly flowToHost: number[] = [];
	private sendArrival: number | undefined;
	private pumpAt: number | undefined;
	/** Inside a step, where what the terminal or the host does in answer happens at the step's time. */
	private stepping = false;

	constructor(options: LineOptions) {
		this.options = options;
		this.clock = options.clock ?? realClock;
		this.charMs = 10_000 / options.baud;
		this.time = this.clock.now();
	}

	/** The terminal at this end; its `onResponse` goes to `answer`. */
	attach(term: Vt420): void {
		this.term = term;
	}

	/** The terminal's answers, sent back over the line. */
	readonly answer = (bytes: string): void => {
		this.catchUp();
		for (let i = 0; i < bytes.length; i++) this.toHost.push(bytes.charCodeAt(i) & 0xff);
		this.startSending();
		this.schedule();
	};

	/**
	 * The host writes. Queued before the line catches up, since catching up can hand the host an answer it writes
	 * more for, which comes after this.
	 */
	write(data: string | Uint8Array): void {
		const at = this.stepping ? this.time : this.clock.now();
		const bytes = typeof data === "string" ? Array.from(data, (char) => char.charCodeAt(0) & 0xff) : [...data];
		for (const byte of bytes) {
			this.toTerminal.push(byte);
			this.writtenAt.push(at);
		}
		this.catchUp();
		this.startHost();
		this.schedule();
	}

	/** Keys typed at the terminal. */
	type(bytes: string): void {
		this.answer(bytes);
	}

	/** Hold Screen: the terminal takes nothing in until it is let go. */
	hold(on: boolean): void {
		this.catchUp();
		this.held = on;
		if (!on) this.process();
		this.schedule();
	}

	/** Characters still to cross or be taken in, either way. */
	get pending(): number {
		return this.toTerminal.length + this.buffer.length + this.toHost.length + this.flowToHost.length;
	}

	/** In the input buffer now. */
	get buffered(): number {
		return this.buffer.length;
	}

	private catchUp(): void {
		if (this.stepping) return;
		const now = this.clock.now();
		this.stepping = true;
		try {
			for (;;) {
				const next = this.nextEvent();
				if (next === undefined || next > now) break;
				this.time = Math.max(this.time, next);
				this.step();
			}
		} finally {
			this.stepping = false;
		}
		this.time = Math.max(this.time, now);
	}

	private nextEvent(): number | undefined {
		const times = [this.hostArrival, this.busyUntil, this.sendArrival].filter((t): t is number => t !== undefined);
		return times.length === 0 ? undefined : Math.min(...times);
	}

	/** Whatever is due at `time`: a glide ends, a character arrives either way. */
	private step(): void {
		if (this.busyUntil !== undefined && this.busyUntil <= this.time) {
			this.busyUntil = undefined;
			this.process();
		}
		if (this.hostArrival !== undefined && this.hostArrival <= this.time) {
			this.hostArrival = undefined;
			const byte = this.toTerminal.shift();
			this.writtenAt.shift();
			if (byte !== undefined) this.receive(byte);
			this.startHost(this.time);
		}
		if (this.sendArrival !== undefined && this.sendArrival <= this.time) {
			this.sendArrival = undefined;
			this.deliver();
			this.startSending(this.time);
		}
	}

	private schedule(): void {
		const next = this.nextEvent();
		if (next === undefined) return;
		if (this.pumpAt !== undefined && this.pumpAt <= next) return;
		this.pumpAt = next;
		this.clock.after(next - this.clock.now(), () => {
			this.pumpAt = undefined;
			this.catchUp();
			this.schedule();
		});
	}

	// ---- host to terminal

	private startHost(from = this.time): void {
		if (this.hostArrival !== undefined || this.toTerminal.length === 0 || this.hostStopped) return;
		if (this.hostStopping !== undefined) {
			if (this.hostStopping <= 0) {
				this.hostStopping = undefined;
				this.hostStopped = true;
				return;
			}
			this.hostStopping--;
		}
		this.hostArrival = Math.max(from, this.writtenAt[0] ?? from) + this.charMs;
	}

	private receive(byte: number): void {
		this.stats.received++;
		const flow = this.term?.setup.xoff ?? 0;
		// with XON/XOFF on, the terminal takes the host's flow control characters for itself
		if (flow > 0 && (byte === XOFF || byte === XON)) {
			this.transmitStopped = byte === XOFF;
			if (!this.transmitStopped) this.startSending();
			return;
		}
		if (this.buffer.length >= BUFFER) {
			this.stats.lost++;
			if (this.term) this.term.integrity = "error";
			if (flow > 0) this.sendFlow(XOFF);
			return;
		}
		this.buffer.push(byte);
		this.stats.peak = Math.max(this.stats.peak, this.buffer.length);
		if (flow > 0) {
			if (this.buffer.length >= flow && !this.sentFirstXoff) {
				this.sentFirstXoff = true;
				this.sendFlow(XOFF);
			} else if (this.buffer.length >= SECOND_XOFF && !this.sentSecondXoff) {
				this.sentSecondXoff = true;
				this.sendFlow(XOFF);
			}
		}
		this.process();
	}

	/** Take in what the buffer holds, a character at a time as the terminal gets through its work. */
	private process(): void {
		const term = this.term;
		if (!term) return;
		const timed = this.options.timing !== false;
		const glideMs = this.options.glideMs ?? TIMING.glideMs;
		while (this.busyUntil === undefined && !this.held && this.buffer.length > 0) {
			const bytes = Uint8Array.from(this.buffer);
			term.busyMs = 0;
			const used = term.write(bytes, 0, timed ? 1 : bytes.length, glideMs > 0);
			this.buffer.splice(0, used);
			const work = timed ? term.busyMs : 0;
			const event = term.smoothScrollEvent;
			if (event) {
				term.smoothScrollEvent = undefined;
				this.stats.glides++;
				this.busyUntil = this.time + glideMs + work;
				this.options.onGlide?.(event, glideMs);
			} else if (work > 0) this.busyUntil = this.time + work;
			if (used === 0) break;
		}
		if (this.buffer.length <= XON_POINT && this.lastFlow === XOFF) {
			this.sentFirstXoff = false;
			this.sentSecondXoff = false;
			this.sendFlow(XON);
		}
	}

	// ---- terminal to host

	private sendFlow(byte: number): void {
		this.lastFlow = byte;
		if (byte === XOFF) this.stats.xoffs++;
		else this.stats.xons++;
		this.flowToHost.push(byte);
		this.startSending();
	}

	private startSending(from = this.time): void {
		if (this.sendArrival !== undefined) return;
		if (this.flowToHost.length > 0) {
			this.sendArrival = from + this.charMs;
			return;
		}
		if (this.toHost.length === 0 || this.transmitStopped) return;
		this.sendArrival = from + (this.term?.transmitLimited ? LIMITED_MS : this.charMs);
	}

	private deliver(): void {
		const flow = this.flowToHost.shift();
		if (flow !== undefined) {
			const xoff = flow === XOFF;
			if (xoff) {
				if (this.options.hostStopsAfter !== undefined) {
					if (this.options.hostStopsAfter <= 0) this.hostStopped = true;
					else this.hostStopping ??= this.options.hostStopsAfter;
				}
			} else {
				this.hostStopping = undefined;
				if (this.hostStopped) {
					this.hostStopped = false;
					this.startHost();
				}
			}
			this.options.onFlow?.(xoff);
			return;
		}
		const byte = this.toHost.shift();
		if (byte !== undefined) this.options.onHost?.(String.fromCharCode(byte));
	}
}
