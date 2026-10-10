# pi for the DEC VT420

A simplified pi CLI built for a real DEC VT420 on a serial line, or anything that emulates one closely
(`xterm -ti vt420`). It runs the same `AgentSession` as `pi`: same tools, models, credentials, sessions,
`AGENTS.md`, skills and prompt templates, so sessions move freely between the two. Only the frontend is new.

![pi-vt420 finding and fixing a failing test, amber phosphor](media/pi-vt420.webp)

The start-up animation, then a local model finds why a test fails and fixes it, in
[vt420](https://github.com/mrq1911/vt420), the VT420 in a browser window.

```bash
./pi-vt420.sh                 # from the repository root
./pi-vt420.sh -c              # continue the latest session here
./pi-vt420.sh --baud 19200 "explain src/main.ts"
```

## Install

`install.sh` makes a checkout the default `pi`: it installs the dependencies (`npm ci --ignore-scripts`), fetches the
model catalog, links `pi` and `pi-vt420` in `~/.local/bin` to `pi-vt420.sh`, and keeps an npm-installed pi reachable
as `pi-classic`.

```bash
git clone --branch vt420 https://github.com/mrq1911/pi.git ~/.local/share/pi-vt420
~/.local/share/pi-vt420/packages/coding-agent/src/experimental/vt420/install.sh
```

`pi-vt420-update` pulls the branch and runs the same steps again. In the fork, a nightly workflow
(`.github/workflows/vt420-sync.yml`) merges upstream `main` into `vt420` and pushes the merge only when the build,
`npm run check` and the vt420 tests pass; a failed merge opens an issue and leaves the branch as it was. Updating the
npm pi relinks `pi` to it, and `pi-vt420-update` puts it back.

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
- **Rolling thinking**: collapsed thinking fills two rows as tokens arrive, and each time the lower one is full the
  terminal smooth-scrolls the pair up a line (DECSCLM for that one scroll, inside its own DECSTBM margins), so the
  latest tokens are always in view and the text rolls on like paper, the holes in both its margins feeding up with it.
  Emulators, which do not scroll smoothly, get one line that scrolls left instead. Either way the newest word glows in
  bold. Once the model moves on, it settles on one line with how the thinking started. PF3 shows all of it.
- **Bandwidth**: a diff renderer with relative cursor moves, IND/RI hardware scrolling inside DECSTBM margins, DCH to
  scroll the emulators' thinking ticker in place, ECH and DECFRA for long rules. A frame goes to a DEC terminal in
  pieces of 96 bytes at most, each ending with a DSR request (DA1 where the terminal ignores DSR), and pieces go out
  only while those unanswered come to 200 bytes at most, which a VT420's input buffer of 254 holds even while it
  glides, so even a page never runs ahead of the terminal while small frames still follow each other without a pause,
  whatever the line speed, the buffers on the way, and whether flow control comes back over ssh too late or not at
  all; emulators get whole frames paced the same way. Limited transmit, which holds the terminal's answers to 150
  characters a second, is lifted for the session (DECXRLM) and put back on exit. When answers stop coming, lost on
  the line or held up by Set-Up, Hold Screen or flow control, only a DA1 probe goes out, less often each time, until
  one is answered, so a held terminal never gets a backlog to wade through. XON/XOFF stays on, so Hold Screen works. On a terminal set to smooth scroll, scrolls of more than two lines jump: gliding through a page takes
  seconds, and what arrives meanwhile would overflow it. The terminal layer, character sets and renderer are
  `@mrq/vt420`, which zellij-vt420 shares, and the tests draw on its emulated VT420, `@mrq/vt420-emu`, both from
  [mrq1911/vt420](https://github.com/mrq1911/vt420); the tests put it behind a model of the serial line: at 38400 baud, with the 254-character input
  buffer, glides that hold input up and a host that never heeds XOFF, the rain and a long answer on a terminal set up
  as the factory sets it lose nothing.
- **Screen saver**: a model can work for hours, and a CRT keeps a picture it shows that long, so after ten minutes
  without a key the screen goes dark, on a VT400-class DEC terminal only: an emulator (zellij-vt420 included) or a
  terminal that does not say what it is gets none, whatever the setting. `progress`, the default, shows one line of
  how the work goes (`π Working 1h 05m · 41.2 tok/s`, `π Waiting for you`, and just `π` once the work is done) in
  another place every half minute; `matrix` rains down the words the model generates, the whole screen moving down a line at a time with
  the terminal's smooth scroll and each word entering its column last letter first, bright (now and then the next one
  or two as well), so it reads top to bottom as it falls, new words mostly starting beside a stream already falling,
  anywhere across the screen, so the rain clumps, with bright glints hopping three rows down a stream every sixth
  line, half again the rain's speed, so streams seem to overtake each other (smooth scroll stays on while it rains;
  each line costs at most what a VT420 set to XOFF at 128 takes in while it glides the one before, 128 bytes,
  checked against what the renderer wrote, with drops already falling getting their letters first and some bytes
  kept for the glints, so the glides follow each other without a pause; and no more than two lines are out at once,
  so a key wakes the screen a glide or two later), a lone π falling while the model works without writing, and the π
  line once all is done; `blank` shows nothing; `off` turns it off. Any key wakes the screen and does nothing else.
  `/screensaver matrix` keeps the mode and starts it at once, as plain `/screensaver` and `/screensaver 0` do;
  `/screensaver blank 5` keeps the mode and minutes in `vt420.json` (`"screensaver"`, `"screensaverMinutes"`) for next
  time.
- **Probing and restore**: DA1/DA2, DECRQSS, DECRQM, DECRQUPSS, DECRQDE and CPR decide what to use; the modes, status
  line type and designations found at startup are restored on exit.
- **Emulators**: a terminal that decodes UTF-8 (found by printing é as two bytes and reading the cursor back) gets the
  same glyphs as Unicode, since emulators rarely implement DEC Technical even when they claim it. `--encoding dec` or
  `--encoding utf8` overrides the detection. Most emulators also ignore double-width and double-height lines, which
  shows when the cursor, sent far right on a DECDWL line, passes the middle of the screen; there the banner, help
  titles and intro tagline go out letter-spaced in the same place, headings stay at normal size, and the OAuth device
  code stays plain. `--double-size on|off` overrides the detection. Terminals without a status line keep the footer
  on the bottom row, and ones without rectangle operations do without the shine. An emulator is never named after
  the DEC terminal its DA2 claims (zellij and xterm.js say VT100); under
  [vt420-term](https://github.com/mrq1911/vt420-term), which sets `VT420_TERM` (and `LC_VT420_TERM`, which ssh passes on
  where the server has `AcceptEnv LC_VT420_TERM`), the banner names the terminal at the end of the line, and where pi
  draws on an emulator in between, such as a zellij pane, the footer goes in the window title, π first, and its row
  to the transcript: vt420-term shows that title on the VT420's status line, over zellij's bar while zellij is in
  normal mode.

## Keys

| Key | Action |
| --- | --- |
| Return | send; steer while working |
| Do (F5 elsewhere) | queue a follow-up |
| Ctrl+J | new line |
| F6 Interrupt, F11 ESC | interrupt, close menus |
| F8 Cancel, Ctrl+C | clear input; twice to exit |
| F10 Exit, Ctrl+D | exit when the input is empty |
| F7 Resume | pick a session |
| F9 Main Screen, Select | back to the live view |
| F14 Additional Options | command menu |
| Help | keys and commands |
| F20 | Matrix rain at once, whatever the screen saver is set to, on a VT400-class terminal; any key ends it |
| PF1 / PF2 / PF3 / PF4 | thinking level / model / show thinking / expand tool output |
| Prev Screen, Next Screen, Find | page the transcript, jump to the top |
| F12 BS, F13 LF | start of line, delete word (as on VMS) |

Emacs control keys work in the editor. xterm's F13 to F20 (Shift with F1 to F8), which is how vt420-term passes
the LK401's F14 to F20, Help and Do on, count as those keys. Every binding can be changed in `~/.pi/agent/vt420.json`:

```json
{ "keys": { "app.interrupt": ["f11", "escape"] }, "baud": 19200, "statusLine": "auto" }
```

## Commands

`/help` (or `/hotkeys`), `/model [name]`, `/thinking [level]`, `/new`, `/resume`, `/tree`, `/fork`, `/clone`,
`/import <file.jsonl>`,
`/compact [focus]`, `/session`, `/name [name]`, `/settings`, `/scoped-models`, `/login [provider]`,
`/logout [provider]`, `/trust`, `/copy`, `/share`, `/bug [what went wrong]`,
`/export [path]` (HTML, or JSONL for a `.jsonl` path), `/changelog`, `/reload`, `/charset`, `/redraw`,
`/screensaver [off|blank|progress|matrix] [minutes]`, `/quit` (or `/q`). `/copy` uses OSC 52 on an emulator and the desktop
clipboard on a host that has one; a VT420 has neither. `/settings` has pi's settings that apply here (auto-compact,
steering and follow-up modes, thinking per model, transport, HTTP idle timeout, cache warming, images, skill commands,
project trust, telemetry) and the screen saver's; `/scoped-models` picks the models next-model goes through, at once
for the session and, with Save, for the next start. `/share` and `/bug` work as in pi (Radius, or a secret gist
through `gh`; the bug report's consents, upload or a zip in the current directory), with their progress on the
separator row, where interrupt cancels it.

Extension commands work as in pi, pi's own and yours (`--no-extensions` leaves yours out): they get the frontend's
lists, yes-or-no questions, one-line prompts, notices and the separator row for their status, and appear in Tab
completion, the command menu and help, with skills as `/skill:name`. What needs pi's TUI components (widgets, custom
components) does nothing, as in RPC mode. `/llama` manages a llama.cpp router the same way, as a series of lists and
prompts with its progress on the separator row.

`/loop` runs a prompt again and again: `/loop 5m check the build` every five minutes (a run that
comes due while another turn runs waits for it), `/loop keep the tests green` again as each run ends, the model
choosing the wait before the next or ending the loop with a `loop_next` tool that is only active meanwhile. `/loop`
shows what loops, `/loop stop` ends it, and so does interrupting a run. It is an extension
(`extensions/loop.ts`) that `install.sh` links into `~/.pi/agent/extensions`, so the npm pi loads it too, as it
does `/rename`, another name for `/name`, for fingers trained on other agents.
Prompt templates and `/skill:name` work as in pi. `!cmd` runs a shell command; `!!cmd` keeps its output out of the context.

`/login` prints the sign-in address or device code (the code in double-height letters) for another device and
reads keys or pasted codes from the keyboard.

## Terminal setup

VT420 Set-Up, saved:

| Screen | Setting | Why |
|---|---|---|
| Communications | Transmit 38400, Receive=Transmit | The serial port's speed; both ends must match |
| | 8 bits, no parity, 1 stop bit | |
| | Data Leads Only | With Modem Control and no DSR from the other end the terminal stops sending and lights Wait |
| | XOFF at 128 | Takes in a whole line of the screen saver's rain while it glides; at 64 the rain stutters. No XOFF also disables Hold Screen |
| | Unlimited Transmit | pi lifts Limited Transmit for its session anyway (DECXRLM); Unlimited lets the shell outside it answer at full speed too |
| | Local echo off, Auto Answerback off | |
| Display | Jump Scroll | pi turns smooth scroll on only where it glides (thinking, rain) and jumps long scrolls; with Smooth set, a shell's output glides too, slowly |
| | 80 columns, 24 lines | `--columns 132`, `--lines 36\|48` switch for a session |
| | 6 pages of 24 lines | One page as tall as the screen, which pi draws on; a 48-line screen needs 3 pages of 48 (36: 4 of 36), or its lower lines stay blank |
| | Status line: any | pi makes it host-writable and puts it back on exit |
| | Dark screen | pi turns reverse video off while the screen saver runs anyway |
| General | VT400 mode, 7-bit controls | pi sets 7-bit controls itself |
| | Terminal ID VT420 | How pi knows it; another one shows as "VT400-class terminal" |
| | User Defined Keys Locked | pi and zellij-vt420 use the keys as the terminal sends them; locked, nothing printed to the screen can reprogram Shift+F6 to F20 |
| | User-preferred supplemental: DEC or ISO Latin-1 | pi asks which |
| Global | One session | The XOFF points above are a single session's |

- A serial login: `agetty -L 38400,19200 ttyUSB0 vt420`; Break at the login prompt steps down to 19200. The line
  speed is read with `stty` on serial ports and over ssh from a client on one; elsewhere `--baud` sets it, for the
  animation and timeouts. Pacing does not need it.
- Pacing keeps the terminal from overflowing on its own, and a serial port that honours XOFF itself keeps the screen
  saver's rain gliding: with `ixon`, an FTDI adapter stops in the chip, a character after the terminal asks. ssh
  clears `ixon` on the tty it runs on, so set it again once logged in through it (`stty -F /dev/ttyUSB0 ixon`). An
  FTDI adapter's `latency_timer` of 1 ms instead of 16 gets answers and keys to the host sooner; a udev rule keeps it:
  `ACTION=="add", SUBSYSTEM=="usb-serial", DRIVER=="ftdi_sio", ATTR{latency_timer}="1"`.
- `--columns 132` and `--lines 36|48` switch the terminal (DECSCPP/DECSNLS) and switch back on exit; the page size
  stays as Set-Up has it.

## Not included

Themes, images, mouse, and extension widgets, headers, footers and custom components. Use `pi` for those; the
sessions are shared.
