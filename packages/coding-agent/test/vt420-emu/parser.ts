// vt420-term's src/emu/parser.ts (github.com/mrq1911/vt420-term), copied for these tests: change it there, then copy it here.
/**
 * The VT420's input parser: bytes in, graphic characters, controls and complete control functions out.
 *
 * A state machine after the DEC STD 070 / VT500 one (vt100.net/emu/dec_ansi_parser), with the VT420's own rules:
 * CAN and SUB cancel a sequence (SUB showing the error character), ESC starts over, C0 controls inside a sequence
 * still act, any C1 control interrupts whatever is in progress, and OSC, PM, APC and SOS strings are ignored until
 * ST, SUB or another C1 control (a BEL does not end them). Without `utf8`, bytes 0x80-0x9F are C1 controls and
 * 0xA0-0xFF graphic characters from GR; with it they are UTF-8, as on a modern emulator.
 */

export interface ParserHandler {
	/** A graphic character: a byte 0x20-0x7F or 0xA0-0xFF, or with `utf8` a code point from 0x80 up. */
	print(code: number): void;
	/** A C0 control other than ESC, CAN and SUB, or a C1 control that is not a string or sequence introducer. */
	execute(code: number): void;
	esc(intermediates: string, final: number): void;
	/** `params` holds 0 where a parameter was left out; `prefix` is a private marker (`?`, `>`, `=`, `<`) or empty. */
	csi(prefix: string, params: number[], intermediates: string, final: number): void;
	/** A whole device control string, its data as bytes in a latin1 string. */
	dcs(prefix: string, params: number[], intermediates: string, final: number, data: string): void;
	/** SUB: whatever was in progress cancelled, and the error character shown. */
	substitute(): void;
	/** An application program command (APC) ended by ST, which the VT420 ignores; its printable text. */
	apc?(data: string): void;
}

const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI_PARAM = 3;
const CSI_INTERMEDIATE = 4;
const CSI_IGNORE = 5;
const DCS_PARAM = 6;
const DCS_INTERMEDIATE = 7;
const DCS_IGNORE = 8;
const DCS_DATA = 9;
/** OSC, PM, APC or SOS: everything ignored until it ends. */
const IGNORED_STRING = 10;
/** ESC inside a string: ESC \ ends it, and any other 7-bit C1 ends it as well, then acts. */
const STRING_ESCAPE = 11;

const MAX_PARAMS = 16;
const MAX_PARAM = 65535;
/** A soft font of 96 characters 16 rows high is under 8 KB in sixels; macros take at most 6 KB. */
const MAX_DCS = 64 * 1024;

export class Parser {
	utf8: boolean;
	private readonly handler: ParserHandler;
	private state = GROUND;
	private prefix = "";
	private intermediates = "";
	private params: number[] = [];
	/** The parameter being read, -1 before its first digit. */
	private param = -1;
	private final = 0;
	private data = "";
	private overflow = false;
	/** Whether the string an ESC interrupted was a DCS, which is passed on when it ends. */
	private escapedDcs = false;
	/** The text of an APC string being read, which is passed on if ST ends it. */
	private apc: string | undefined;
	private utf8Need = 0;
	private utf8Code = 0;

	constructor(handler: ParserHandler, utf8 = false) {
		this.handler = handler;
		this.utf8 = utf8;
	}

	/** In a sequence or string, where the next byte does not stand on its own. */
	get busy(): boolean {
		return this.state !== GROUND || this.utf8Need > 0;
	}

	reset(): void {
		this.state = GROUND;
		this.utf8Need = 0;
	}

	feed(bytes: Uint8Array, start = 0, end = bytes.length): void {
		for (let i = start; i < end; i++) this.byte(bytes[i]!);
	}

	byte(code: number): void {
		if (code >= 0x80) {
			if (this.utf8) {
				this.utf8Byte(code);
				return;
			}
			if (code < 0xa0) {
				this.c1(code);
				return;
			}
			if (this.state === GROUND) {
				this.handler.print(code);
				return;
			}
			if (this.state === DCS_DATA) {
				this.put(code);
				return;
			}
			if (this.state === IGNORED_STRING) return;
			// in a sequence a GR byte counts as its GL counterpart
			code &= 0x7f;
		} else if (this.utf8Need > 0) {
			this.utf8Need = 0;
			this.handler.print(0xfffd);
		}
		if (code === 0x18 || code === 0x1a) {
			this.state = GROUND;
			this.escapedDcs = false;
			this.apc = undefined;
			if (code === 0x1a) this.handler.substitute();
			return;
		}
		if (code === 0x1b) {
			if (this.state === DCS_DATA || this.state === IGNORED_STRING) {
				this.escapedDcs = this.state === DCS_DATA;
				this.state = STRING_ESCAPE;
				return;
			}
			if (this.state === STRING_ESCAPE) this.endString();
			this.state = ESCAPE;
			this.intermediates = "";
			return;
		}
		switch (this.state) {
			case GROUND:
				if (code < 0x20) this.handler.execute(code);
				else this.handler.print(code);
				return;
			case ESCAPE:
				this.escapeByte(code);
				return;
			case ESCAPE_INTERMEDIATE:
				if (code < 0x20) this.handler.execute(code);
				else if (code < 0x30) this.intermediates += String.fromCharCode(code);
				else if (code < 0x7f) {
					this.state = GROUND;
					this.handler.esc(this.intermediates, code);
				}
				return;
			case CSI_PARAM:
			case CSI_INTERMEDIATE:
			case CSI_IGNORE:
				this.csiByte(code);
				return;
			case DCS_PARAM:
			case DCS_INTERMEDIATE:
			case DCS_IGNORE:
				this.dcsHeaderByte(code);
				return;
			case DCS_DATA:
				if (code !== 0x7f) this.put(code);
				return;
			case IGNORED_STRING:
				if (this.apc !== undefined && code >= 0x20 && code < 0x7f && this.apc.length < 256) {
					this.apc += String.fromCharCode(code);
				}
				return;
			case STRING_ESCAPE: {
				const apc = this.apc;
				this.apc = undefined;
				this.endString();
				if (code === 0x5c) {
					this.state = GROUND;
					if (apc !== undefined) this.handler.apc?.(apc);
					return;
				}
				this.state = ESCAPE;
				this.intermediates = "";
				this.escapeByte(code);
				return;
			}
		}
	}

	private endString(): void {
		if (this.escapedDcs) this.finishDcs();
		this.escapedDcs = false;
		this.state = GROUND;
	}

	private escapeByte(code: number): void {
		if (code < 0x20) {
			this.handler.execute(code);
			return;
		}
		if (code < 0x30) {
			this.intermediates = String.fromCharCode(code);
			this.state = ESCAPE_INTERMEDIATE;
			return;
		}
		if (code === 0x7f) return;
		switch (code) {
			case 0x5b: // [
				this.enterSequence(CSI_PARAM);
				return;
			case 0x50: // P
				this.enterSequence(DCS_PARAM);
				return;
			case 0x5d: // ]
			case 0x5e: // ^
			case 0x5f: // _
			case 0x58: // X
				this.state = IGNORED_STRING;
				this.apc = code === 0x5f ? "" : undefined;
				return;
			case 0x5c: // a lone ST
				this.state = GROUND;
				return;
		}
		this.state = GROUND;
		this.handler.esc("", code);
	}

	private c1(code: number): void {
		const apc = this.state === IGNORED_STRING && code === 0x9c ? this.apc : undefined;
		this.apc = undefined;
		if (this.state === DCS_DATA || this.state === STRING_ESCAPE) {
			if (this.state === DCS_DATA) this.escapedDcs = true;
			this.endString();
		}
		this.state = GROUND;
		switch (code) {
			case 0x9b:
				this.enterSequence(CSI_PARAM);
				return;
			case 0x90:
				this.enterSequence(DCS_PARAM);
				return;
			case 0x9d:
			case 0x9e:
			case 0x9f:
			case 0x98:
				this.state = IGNORED_STRING;
				if (code === 0x9f) this.apc = "";
				return;
			case 0x9c:
				if (apc !== undefined) this.handler.apc?.(apc);
				return;
		}
		this.handler.execute(code);
	}

	private enterSequence(state: number): void {
		this.state = state;
		this.prefix = "";
		this.intermediates = "";
		this.params = [];
		this.param = -1;
	}

	/** The bytes before a final: digits and separators, a private marker first, intermediates last. */
	private header(code: number, intermediate: number): "final" | "more" | "ignore" {
		if (code >= 0x30 && code <= 0x39) {
			if (this.state === intermediate) return "ignore";
			this.param = Math.min(MAX_PARAM, Math.max(0, this.param) * 10 + code - 0x30);
			return "more";
		}
		if (code === 0x3b) {
			if (this.state === intermediate) return "ignore";
			if (this.params.length < MAX_PARAMS) this.params.push(Math.max(0, this.param));
			this.param = -1;
			return "more";
		}
		if (code >= 0x3c && code <= 0x3f) {
			if (this.prefix !== "" || this.params.length > 0 || this.param >= 0 || this.intermediates !== "") {
				return "ignore";
			}
			this.prefix = String.fromCharCode(code);
			return "more";
		}
		if (code === 0x3a) return "ignore";
		if (code < 0x30) {
			this.intermediates += String.fromCharCode(code);
			return "more";
		}
		if ((this.param >= 0 || this.params.length > 0) && this.params.length < MAX_PARAMS) {
			this.params.push(Math.max(0, this.param));
		}
		return "final";
	}

	private csiByte(code: number): void {
		if (code < 0x20) {
			this.handler.execute(code);
			return;
		}
		if (code === 0x7f) return;
		if (this.state === CSI_IGNORE) {
			if (code >= 0x40) this.state = GROUND;
			return;
		}
		const step = this.header(code, CSI_INTERMEDIATE);
		if (step === "ignore") this.state = CSI_IGNORE;
		else if (step === "more") this.state = this.intermediates === "" ? CSI_PARAM : CSI_INTERMEDIATE;
		else {
			this.state = GROUND;
			this.handler.csi(this.prefix, this.params, this.intermediates, code);
		}
	}

	private dcsHeaderByte(code: number): void {
		if (code < 0x20 || code === 0x7f || this.state === DCS_IGNORE) return;
		const step = this.header(code, DCS_INTERMEDIATE);
		if (step === "ignore") this.state = DCS_IGNORE;
		else if (step === "more") this.state = this.intermediates === "" ? DCS_PARAM : DCS_INTERMEDIATE;
		else {
			this.final = code;
			this.data = "";
			this.overflow = false;
			this.state = DCS_DATA;
		}
	}

	private put(code: number): void {
		if (this.data.length < MAX_DCS) this.data += String.fromCharCode(code);
		else this.overflow = true;
	}

	private finishDcs(): void {
		const data = this.data;
		this.data = "";
		if (!this.overflow) this.handler.dcs(this.prefix, this.params, this.intermediates, this.final, data);
	}

	private utf8Byte(code: number): void {
		if (this.state !== GROUND) {
			// a modern emulator takes no C1 controls from bytes, so inside a sequence they are data or nothing
			if (this.state === DCS_DATA) this.put(code);
			return;
		}
		if (code >= 0xc0) {
			if (this.utf8Need > 0) this.handler.print(0xfffd);
			this.utf8Need = code >= 0xf0 ? 3 : code >= 0xe0 ? 2 : 1;
			this.utf8Code = code & (code >= 0xf0 ? 0x07 : code >= 0xe0 ? 0x0f : 0x1f);
			return;
		}
		if (this.utf8Need === 0) {
			this.handler.print(0xfffd);
			return;
		}
		this.utf8Code = (this.utf8Code << 6) | (code & 0x3f);
		if (--this.utf8Need === 0) this.handler.print(this.utf8Code);
	}
}
