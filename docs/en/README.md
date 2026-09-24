# fakeroku — emulated Roku devices for your remote

This adapter makes ioBroker look like one or more **Roku streaming devices** on your
local network. A remote control or controller that speaks Roku's protocol — a Logitech
Harmony hub, a Sofabaton X1/X2, Home Assistant's Roku integration, openHAB — finds the
emulated device, and every button you press on it becomes a datapoint in ioBroker that
your scripts and visualisations can react to.

It is the **input** counterpart to the Logitech Harmony adapter: instead of ioBroker
controlling a device, a device controls ioBroker.

> **The official Roku mobile app does not work with this adapter.** The app talks to
> real Rokus over Roku's proprietary, undocumented ECP-2 WebSocket channel, which this
> emulator does not implement. Use a Harmony hub or a Sofabaton — those speak the open
> protocol this adapter serves.

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

Leave **Network interface** on "all interfaces". The adapter then serves every network
your ioBroker host sits in, and answers a remote in each of them with the host's own
address in that network — a remote in a separate VLAN gets the address it can reach.

Pick a specific address only if the emulated Rokus should exist in **one network
only**. Then everything stays in that network: only remotes from it are answered, and
nothing is offered on the others. If that address does not exist on the host when the
instance starts, the adapter waits up to two minutes for it (a network that comes up
after ioBroker), then says so in the log and starts nothing — it never falls back to
another network.

### 3. Add or edit the emulated Rokus

Each card under **Emulated Roku devices** is one Roku your remote can find.

- **Name** — the name of the device in ioBroker and in the device information the
  emulated Roku gives out. Whether a remote shows it depends on the remote: a Harmony
  names the device itself. Pick something you will recognise, for example the room.
  **Renaming a card later keeps its datapoints** — the folder in the object tree, its
  room and function assignments and its history settings stay where they are; only the
  displayed name changes.
- **ECP port** — the network port this Roku answers on. `8060` is the port a real
  Roku uses. Each emulated Roku needs **its own** port; the dialog pre-selects a free
  one and does not let you confirm a port that is already taken. A Harmony or Sofabaton
  reads the port from the discovery; **Home Assistant and Homey always use 8060**, so
  give 8060 to the Roku they should control.
- **Type**
  - **Player** (a streaming box) offers the 16 standard navigation and playback keys.
  - **TV** offers those plus volume, power, channel and input keys (`VolumeUp`,
    `PowerOn`, `PowerOff`, `Power`, `Sleep`, `ChannelUp`, `InputTuner`, `InputHDMI1` …).
    Choose it only if you actually want those extra buttons as triggers in ioBroker.

### 4. Teach your remote

**Logitech Harmony:** add a device in the Harmony app, choose **Roku** as the
manufacturer, and point it at your ioBroker host. The hub finds the emulated Roku on
its own and reads the port from the announcement — you do not have to enter it.

**Sofabaton X1/X2:** add a Roku device in the Sofabaton app while the app is on the
same network; it finds the emulated Roku through discovery.

**Home Assistant:** add the Roku integration — it discovers the emulated Roku, or you
enter the ioBroker host. Home Assistant always talks to port 8060 (see above).

## What you get in the object tree

At instance level:

| Datapoint         | Type               | Meaning                                                                                                                                                                                                                                                      |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `info.connection` | boolean, read-only | True only while **every** configured Roku is actually listening. If one of them cannot start — almost always because its port is already in use — the log names the device and the port, and the adapter retries that device every minute until it comes up. |

For each emulated Roku, below `fakeroku.0.<name>`:

| Datapoint     | Type               | Meaning                                                                                                                                           |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`     | string, read-only  | The last command as readable text: `Home`, `Lit_a`, `launch:12`, `search:news`.                                                                   |
| `commandType` | string, read-only  | What kind of command it was: `keypress`, `keydown`, `keyup`, `launch`, `install`, `input` or `search`.                                            |
| `keys.<Key>`  | boolean, read-only | One datapoint per remote key. A key press sets it to `true` for a moment and back to `false`; holding a key keeps it `true` until it is released. |

Typing on the remote's keyboard (`Lit_a`) and app launches appear in `command` only —
they do not get datapoints of their own. An app button of a remote that sends app
launches (a Sofabaton, Home Assistant) arrives as `launch:<id>`, with its parameters if
it carries any (`launch:12?contentId=…`). Key names are read in any case: `home` and
`HOME` are the key `Home`.

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
was left pressed when ioBroker stopped cannot block your rule afterwards. Releasing a key
you are actually holding is never dropped, not even while the adapter is shedding a flood
of commands — otherwise the flood protection would be the thing that left a key stuck.

## Ports the adapter uses

- **TCP 8060** (one per emulated Roku, configurable) — the control protocol. Your
  remote sends its key presses here.
- **UDP 1900** (multicast) — device discovery, so the remote finds the emulated
  Rokus. This port is fixed by the standard and shared by all of them.

Only devices in one of the ioBroker host's own networks are answered — with a chosen
network interface only devices in that interface's network. A request from anywhere
else (the internet, another VLAN, a VPN) is refused, and a discovery search from there
is ignored.

When you stop the instance, the emulated Rokus announce their departure. A controller
that keeps its device list from discovery drops them instead of keeping them for up to
an hour; a Harmony, which remembers a paired device by itself, is not affected.

You can run more than one instance on the same machine — give each one its own ECP
ports. They share UDP 1900: the adapter opens it with address reuse, so every instance
receives the discovery searches and answers for its own devices. Only if some other
program holds that port exclusively does an instance start without discovery — it says so
in the log, and remotes already paired with it still get through.

The adapter also runs in ioBroker's compact mode, where several adapters share one
process instead of each starting their own. On a small box that saves memory and
startup time. You switch it on in the instance settings; nothing here needs changing.

## Troubleshooting

**The remote does not find any device.**
Check that the hub and the ioBroker host are on the same network and that no
firewall blocks UDP port 1900. On a host with several network cards, select the
right one under **Network interface**. If discovery is unavailable the adapter says
so in the log and keeps working for remotes that were already paired.

**The remote finds nothing, and ioBroker runs in Docker.**
In Docker's default bridge network the container only has an internal address no
remote can reach, and discovery searches from your home network never arrive. Run the
ioBroker container with `network_mode: host`, or give it an address in your home
network with a `macvlan` network. The adapter recognises Docker, libvirt, VirtualBox
and WSL bridges on the host itself and does not announce them.

**The log says "The network interface address … does not exist on this host".**
The interface address chosen in the settings is not on the host any more — a new
network card, a changed DHCP address, a restored backup on other hardware. Choose the
current interface (or "all interfaces") and save; the instance restarts.

**Home Assistant cannot reach one of several emulated Rokus.**
Home Assistant always uses port 8060. Give 8060 to the emulated Roku it should
control.

**The instance stays "not connected".**
At least one configured Roku could not start. The log names the device and its port —
almost always the port is already used by something else (including another emulated
Roku with the same port). Give it a free port.
The adapter keeps trying such a device once a minute and says so in the log when it
comes up, so a port that was still held by the previous process after a restart sorts
itself out without you doing anything.

**I press a button and nothing happens in ioBroker.**
Set the instance log level to `debug` for a moment. Every command the adapter _applied_
is logged with the address it came from and, for a key, the key name (`launch`, `input`
and `search` log what was launched or typed instead). If the line appears, the command
arrived and the problem is in the script reading the datapoint.

If nothing appears, look for a warning about more than 25 commands per second first:
commands dropped by that cap are not logged individually, so an overly chatty remote
looks exactly like one that is not reaching the adapter at all. Without such a warning,
the remote really is not getting through — check the network and the ECP port.

**Play and pause do the same thing.**
That is the Roku protocol, not the adapter: the remote sends the _same_ command for
play and for pause, so the two cannot be told apart here.

**The app buttons on my Harmony do nothing.**
A Harmony Hub did not send its app buttons (Netflix, YouTube …) to the emulated Roku —
they are bound to Harmony activities, so the adapter never sees them. Remotes that do
send app launches (a Sofabaton, Home Assistant) show them in `command` as `launch:<id>`.

## Privacy

The adapter talks only to devices in your own networks. It contacts no cloud
service and sends no data anywhere. Optional error reporting via Sentry is off
unless you enabled diagnostics in the ioBroker system settings; it transmits an
anonymous installation id and the error itself, no personal data.
