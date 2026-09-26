# pi for the DEC VT420

A simplified pi CLI built for a real DEC VT420 on a serial line, or anything that emulates one closely
(`xterm -ti vt420`). It runs the same `AgentSession` as `pi`: same tools, models, credentials, sessions,
`AGENTS.md`, skills and prompt templates, so sessions move freely between the two. Only the frontend is new.

```bash
./pi-vt420.sh                 # from the repository root
./pi-vt420.sh -c              # continue the latest session here
./pi-vt420.sh --baud 19200 "explain src/main.ts"
```

## What it uses of the terminal

- **Start-up animation**, after the DEC animations on [vt100.net](https://vt100.net/dec/animation/): digits of π
  and DEC Technical symbols rain down a scrolling region (RI at the top margin), and the logo builds up from the
  bottom by pulling the region's bottom margin up a line at a time, the way xmas2 grows its tree. A DECSCNM flash
  marks the finished logo, a DECRARA band sweeps across it, and the tagline zooms in through DECDWL and DECDHL before
  the picture holds for a moment. Each frame ends with a DA1 request, and a frame goes out only while at most one
  other is unanswered, so line latency does not slow it down and it never gets more than a frame ahead of a terminal
  that is still drawing. It plays while the session loads; any key stops it, and `--no-intro` or `"intro": false`
  leaves it out.

  ![The start-up animation on a white phosphor VT420](media/intro-white.gif)

  Also in [green](media/intro-green.gif) and [amber](media/intro-amber.gif) phosphor. These are rendered from the
  frames the intro sends, played through the test emulator; a real terminal draws each frame as the bytes arrive.

- **Character sets**: G0 ASCII, G1 DEC Special Graphics, G2 DEC Technical, G3 DEC Supplemental or ISO Latin-1, reached
  with SO/SI, LS2/LS3 and SS2/SS3. Output is 7-bit clean; `--8bit` puts G3 in GR instead.
- **Special Graphics everywhere**: π prompt, boxes and tables in line drawing, ◆ bullets, ▒ gauges, a bouncing
  ⎺⎻─⎼⎽ scan-line spinner, scan-line sparklines, control pictures (␍ ␌ ␋) for stray controls in tool output, and ␤
  marking typed newlines in the editor.
- **DEC Technical**: ↑ ↓ token counters, ≃ live speed estimates, √ and × tool results, ∴ thinking, Δ edits, ≡ reads,
  Greek and mathematics from model output, and multi-row Σ, ∫, √, brackets and braces from the composite pieces
  (`/charset`).
- **Unicode transliteration**: everything else maps to the nearest glyph (heavy and rounded box drawing, typographic
  quotes, accents stripped where the supplemental set lacks them) or is dropped (emoji). Nothing from a model or tool
  can emit a control sequence.
- **Line attributes**: DECDHL for the banner and level-1 headings, DECDWL for level-2 headings.
- **Host-writable status line** (DECSSDT/DECSASD) for the footer, right-aligned under the prompt: ↑↓ tokens,
  generation speed in tok/s, ▒ context used/max and the working directory (its last component when long). Model and
  thinking level appear in the banner and in `/session`.
- **Thinking ticker**: collapsed thinking is one line that scrolls left as tokens arrive, so the latest ones are
  always in view; once the model moves on, the line settles on how the thinking started. PF3 shows all of it.
- **Bandwidth**: a diff renderer with relative cursor moves, IND/RI hardware scrolling inside DECSTBM margins, DCH to
  scroll the thinking ticker in place, ECH, DECFRA for long rules, and frame pacing to the line speed. XON/XOFF stays
  on, so Hold Screen works.
- **Probing and restore**: DA1/DA2, DECRQSS, DECRQM, DECRQUPSS, DECRQDE and CPR decide what to use; the modes, status
  line type and designations found at startup are restored on exit.
- **Emulators**: a terminal that decodes UTF-8 (found by printing é as two bytes and reading the cursor back) gets the
  same glyphs as Unicode, since emulators rarely implement DEC Technical even when they claim it. `--encoding dec` or
  `--encoding utf8` overrides the detection. Most emulators also ignore double-width and double-height lines, which
  shows when the cursor, sent far right on a DECDWL line, passes the middle of the screen; there the banner, help
  titles and intro tagline go out letter-spaced in the same place, headings stay at normal size, and the OAuth device
  code stays plain. `--double-size on|off` overrides the detection. Terminals without a status line keep the footer
  on the bottom row, and ones without rectangle operations do without the shine.

## Keys

| Key | Action |
| --- | --- |
| Return | send; steer while working |
| Do | queue a follow-up |
| Ctrl+J | new line |
| F6 Interrupt, F11 ESC | interrupt, close menus |
| F8 Cancel, Ctrl+C | clear input; twice to exit |
| F10 Exit, Ctrl+D | exit when the input is empty |
| F7 Resume | pick a session |
| F9 Main Screen, Select | back to the live view |
| F14 Additional Options | command menu |
| Help | keys and commands |
| PF1 / PF2 / PF3 / PF4 | thinking level / model / show thinking / expand tool output |
| Prev Screen, Next Screen, Find | page the transcript, jump to the top |
| F12 BS, F13 LF | start of line, delete word (as on VMS) |

Emacs control keys work in the editor. Every binding can be changed in `~/.pi/agent/vt420.json`:

```json
{ "keys": { "app.interrupt": ["f11", "escape"] }, "baud": 19200, "statusLine": "auto" }
```

## Commands

`/help`, `/model [name]`, `/thinking [level]`, `/new`, `/resume`, `/compact [focus]`, `/session`, `/name <name>`,
`/login [provider]`, `/logout <provider>`, `/export [path]`, `/reload`, `/charset`, `/redraw`, `/quit`.
Prompt templates and `/skill:name` work as in pi. `!cmd` runs a shell command; `!!cmd` keeps its output out of the context.

`/login` prints the sign-in address or device code (the code in double-height letters) for another device and
reads keys or pasted codes from the keyboard.

## Terminal setup

- Set-Up: VT400 mode with 7-bit controls, XON/XOFF, 8 bits no parity.
- A serial login: `agetty -L 19200 ttyUSB0 vt420`. On serial ports the line speed is read with `stty`; elsewhere pass
  `--baud` for pacing.
- `--columns 132` and `--lines 36|48` switch the terminal (DECSCPP/DECSNLS) and switch back on exit.

## Not included

Extensions, themes, images, mouse, session tree navigation and forking. Use `pi` for those; the sessions are shared.
