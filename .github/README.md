# pi-vt420

pi for the DEC VT420. This fork of [pi](https://github.com/earendil-works/pi) adds a frontend for a real VT420 on a
serial line, or anything that emulates one closely. It runs the same agent session as pi (tools, models,
credentials, sessions, `AGENTS.md`, skills), so sessions move freely between the two; only the frontend is new.

![pi-vt420 finding and fixing a failing test, amber phosphor](../packages/coding-agent/src/experimental/vt420/media/pi-vt420.webp)

- **The frontend**: [`packages/coding-agent/src/experimental/vt420`](../packages/coding-agent/src/experimental/vt420),
  and its [README](../packages/coding-agent/src/experimental/vt420/README.md): keys, commands, terminal setup.
- **The terminal layer**, and the VT420 its tests draw on: [`@mrq/vt420`](https://github.com/mrq1911/vt420), shared
  with [zellij-vt420](https://github.com/mrq1911/vt420-term).
- **Everything else** is upstream pi, merged into the `vt420` branch nightly; its own README is
  [README.md](../README.md).

```bash
git clone --branch vt420 https://github.com/mrq1911/pi.git ~/.local/share/pi-vt420
~/.local/share/pi-vt420/packages/coding-agent/src/experimental/vt420/install.sh
```
