/**
 * Generation speed of replies: output tokens over the time from the first streamed token to the end of the reply,
 * so prompt processing does not count. While a reply streams, the rate is estimated from the characters received
 * and refreshed at most once a second, which keeps status line traffic low on a serial line.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Characters streamed so far; roughly four per token. */
function streamedChars(message: AssistantMessage): number {
	let chars = 0;
	for (const content of message.content) {
		if (content.type === "text") chars += content.text.length;
		else if (content.type === "thinking") chars += content.thinking.length;
		else if (content.type === "toolCall") chars += JSON.stringify(content.arguments ?? {}).length;
	}
	return chars;
}

export class SpeedMeter {
	private firstTokenAt: number | undefined;
	private chars = 0;
	private liveRate: number | undefined;
	private liveAt = 0;
	private lastRate: number | undefined;

	/** A new reply started. */
	start(): void {
		this.firstTokenAt = undefined;
		this.chars = 0;
		this.liveRate = undefined;
		this.liveAt = 0;
	}

	update(message: AssistantMessage, now: number): void {
		const chars = streamedChars(message);
		if (chars === 0) return;
		this.firstTokenAt ??= now;
		this.chars = chars;
		const seconds = (now - this.firstTokenAt) / 1000;
		if (seconds >= 1 && now - this.liveAt >= 1000) {
			this.liveRate = chars / 4 / seconds;
			this.liveAt = now;
		}
	}

	finish(message: AssistantMessage, now: number): void {
		const seconds = this.firstTokenAt === undefined ? 0 : (now - this.firstTokenAt) / 1000;
		const tokens = message.usage?.output || this.chars / 4;
		const completed = message.stopReason !== "error" && message.stopReason !== "aborted";
		if (completed && seconds >= 0.25 && tokens > 0) this.lastRate = tokens / seconds;
		this.firstTokenAt = undefined;
		this.liveRate = undefined;
	}

	/** Tokens per second of the last completed reply. */
	get last(): number | undefined {
		return this.lastRate;
	}

	/** The rate to show: the estimate while a reply streams, otherwise the last measurement. */
	get display(): { rate: number; approximate: boolean } | undefined {
		if (this.liveRate !== undefined) return { rate: this.liveRate, approximate: true };
		return this.lastRate === undefined ? undefined : { rate: this.lastRate, approximate: false };
	}
}
