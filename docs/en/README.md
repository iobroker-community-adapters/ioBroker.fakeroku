# fakeroku — emulated Roku devices for your remote

This adapter makes ioBroker look like one or more **Roku streaming devices** on your
local network. A remote control that speaks Roku's protocol — a Logitech Harmony hub
or a Sofabaton X1/X2 — finds the emulated device, and every button you press on it
becomes a datapoint in ioBroker that your scripts and visualisations can react to.

It is the **input** counterpart to the Logitech Harmony adapter: instead of ioBroker
controlling a device, a device controls ioBroker.

> **The official Roku mobile app does not work with this adapter.** The app talks to
> real Rokus over a proprietary, encrypted channel that cannot be reproduced. Use a
> Harmony hub or a Sofabaton — those speak the open protocol this adapter serves.

## Requirements

- Node.js 22 or newer
- js-controller 7.2.2 or newer
- admin 8.0.11 or newer
- A remote or hub on the **same local network** as your ioBroker host

## Setting it up

### 1. Create the instance

Install the adapter and create one instance. It works out of the box: the instance
comes with one emulated Roku already configured, named "Roku" on port 8060.

### 2. Choose the network interface (usually: don't)

Leave **Network interface** on "all interfaces". The adapter then detects the
routable address of your ioBroker host by itself and announces that.

Pick a specific address only if your ioBroker host sits on **several networks** and
the remote is reachable on just one of them.

### 3. Add or edit the emulated Rokus

Each card under **Emulated Roku devices** is one Roku your remote can find.

- **Name** — appears as the device name on the remote and as the folder in the
  object tree. Pick something you will recognise, for example the room.
- **ECP port** — the network port this Roku answers on. `8060` is the port a real
  Roku uses. Each emulated Roku needs **its own** port; the dialog pre-selects a free
  one and refuses a port already taken.
- **Type**
  - **Player** (a streaming box) offers the 16 standard navigation and playback keys.
  - **TV** offers those plus volume, power, channel and input keys. Choose it only if
    you actually want those extra buttons as triggers in ioBroker.

### 4. Teach your remote

**Logitech Harmony:** add a device in the Harmony app, choose **Roku** as the
manufacturer, and point it at your ioBroker host. The hub finds the emulated Roku on
its own and reads the port from the announcement — you do not have to enter it.

**Sofabaton X1/X2:** add a Roku device in the Sofabaton app while the app is on the
same network. The adapter reports a current Roku version, which is what these remotes
check before they accept a device.

## What you get in the object tree

At instance level:

| Datapoint         | Type               | Meaning                                                                                                                                                                                                                      |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info.connection` | boolean, read-only | True only while **every** configured Roku is actually listening. If one of them cannot start — almost always because its port is already in use — the instance stays disconnected and the log names the device and the port. |

For each emulated Roku, below `fakeroku.0.<name>`:

| Datapoint     | Type               | Meaning                                                                                                                                           |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`     | string, read-only  | The last command as readable text: `Home`, `Lit_a`, `launch:12`, `search:news`.                                                                   |
| `commandType` | string, read-only  | What kind of command it was: `keypress`, `keydown`, `keyup`, `launch`, `install`, `input` or `search`.                                            |
| `keys.<Key>`  | boolean, read-only | One datapoint per remote key. A key press sets it to `true` for a moment and back to `false`; holding a key keeps it `true` until it is released. |

Typing on the remote's keyboard (`Lit_a`) and app launches appear in `command` only —
they do not get datapoints of their own.

## Using it in a script

The usual way is to react to a key becoming `true`:

```javascript
on({ id: "fakeroku.0.Living_room.keys.Play", val: true }, () => {
  // your action
});
```

Or watch `command` if you want to handle several buttons in one place:

```javascript
on({ id: "fakeroku.0.Living_room.command" }, obj => {
  log("Remote sent: " + obj.state.val);
});
```

The key datapoints are reset to `false` every time the adapter starts, so a key that
was left pressed when ioBroker stopped cannot block your rule afterwards.

## Ports the adapter uses

- **TCP 8060** (one per emulated Roku, configurable) — the control protocol. Your
  remote sends its key presses here.
- **UDP 1900** (multicast) — device discovery, so the remote finds the emulated
  Rokus. This port is fixed by the standard and shared by all of them.

Only devices on your own local network are answered. A request from the internet is
refused, and a discovery search from outside is ignored.

## Troubleshooting

**The remote does not find any device.**
Check that the hub and the ioBroker host are on the same network and that no
firewall blocks UDP port 1900. On a host with several network cards, select the
right one under **Network interface**. If discovery is unavailable the adapter says
so in the log and keeps working for remotes that were already paired.

**The remote finds nothing, and the log says "advertising on 172.17.x.x".**
That address belongs to a Docker bridge on the host, not to your home network — no
remote can reach it. The adapter prefers a real network address on its own, so this
only shows up when the host has nothing else to offer at that moment. Pick the correct
card under **Network interface** and restart the instance.

**The instance stays "not connected".**
At least one configured Roku could not start. The log names the device and its port —
almost always the port is already used by something else (including another emulated
Roku with the same port). Give it a free port.

**I press a button and nothing happens in ioBroker.**
Set the instance log level to `debug` for a moment. Every received command is logged
with the key name and the address it came from. If nothing appears, the remote is not
reaching the adapter; if it appears, the command arrived and the problem is in the
script reading the datapoint.

**Play and pause do the same thing.**
That is the Roku protocol, not the adapter: the remote sends the _same_ command for
play and for pause, so the two cannot be told apart here.

**The app buttons on my Harmony do nothing.**
Harmony's app buttons (Netflix, YouTube …) are bound to Harmony activities and are
never sent to the device, so the adapter never sees them.

## Privacy

The adapter talks only to devices on your local network. It contacts no cloud
service and sends no data anywhere. Optional error reporting via Sentry is off
unless you enabled diagnostics in the ioBroker system settings; it transmits an
anonymous installation id and the error itself, no personal data.
