![Logo](admin/fakeroku.png)

# ioBroker.fakeroku

![Number of Installations](https://iobroker.live/badges/fakeroku-installed.svg)
![Number of Installations](https://iobroker.live/badges/fakeroku-stable.svg)

Emulates one or more **Roku devices** on your LAN so that ECP/SSDP remotes — a
Logitech Harmony Hub, a Sofabaton X1, the Roku mobile app — can trigger events in
ioBroker. It is the **input** counterpart to the Logitech Harmony adapter: a button
on the remote becomes a datapoint in ioBroker.

Unlike the classic fake-Roku, this build answers the full Roku control surface
including `/query/device-info` with a **current** Roku version — the part modern
remotes check at pairing time, so it works beyond a classic Harmony hub.

## Installation

Install the adapter from the ioBroker admin.

## Configuration

- **Network interface** — the network card the emulated Rokus bind to and advertise
  on. Pick your LAN address; do not leave it on "all interfaces".
- **Emulated Roku devices** — a table of devices, each with a **name** and an
  **ECP port** (default `8060`, the real Roku port). You can emulate several Rokus
  from one instance.

To add the emulated Roku to a Harmony hub, add a "Roku" device in the Harmony app
and point it at the ioBroker host.

## Objects

For every emulated Roku (`fakeroku.0.<name>`):

| Datapoint | Type | Meaning |
|---|---|---|
| `.command` | string, read-only | The last command as plain text (`Home`, `Lit_a`, `launch:12`, `search:news`). One datapoint for everything — no object-per-character sprawl. |
| `.commandType` | string, read-only | `keypress` / `keydown` / `keyup` / `launch` / `install` / `input` / `search`. |
| `.keys.<Key>` | boolean, read-only | One state per standard remote key (Home, Play, arrows, Volume*, Power, HDMI inputs …), all created up front. A keypress pulses it `true` for a moment; keydown/keyup hold it. |

Free keyboard input (`Lit_x`) and app launches show up in `.command` only — they do
not get their own objects.

> Note: the Roku remote sends the **same** `Play` command for play and pause, so
> play and pause cannot be told apart here — that is a protocol limitation, not an
> adapter one.

## Usage

In a script or Blockly rule, react to a key — e.g. when `fakeroku.0.<name>.keys.Play`
becomes `true`, or watch `.command` for the last button as text.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
- Complete rewrite in TypeScript with the full Roku control surface including `device-info` — works with modern remotes (Sofabaton X1, Roku app), not just a classic Harmony hub
- New clean data model: a `command` datapoint plus fixed `keys.<Key>` states, all created up front instead of appearing only after the first keypress
- Discovery binds to the chosen network interface, command handling is restricted to the local network

### 0.4.0 (2026-03-07)
- Adapter requires node.js >= 20, admin >= 7.7.22, js-controller >= 6.0.11

[Older changelogs can be found here](CHANGELOG_OLD.md)

## Credits

This adapter would not exist without [Pmant](https://github.com/Pmant), who built the
original fakeroku on ioBroker back in 2017 and proved the idea works. The code has
since been rewritten from the ground up — but the idea, and the proof that it works,
are his.

## License

The MIT License (MIT)

Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
