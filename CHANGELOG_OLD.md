# Older changes
## 1.7.0 (2026-09-16)

- (krobipd) Fixed: button datapoints keep their value and their room and function assignment when the adapter starts.
- (krobipd) Fixed: after an emulated Roku drops out, its port is free again instead of staying blocked until ioBroker restarts.
- (krobipd) Fixed: stopping the instance no longer leaves it reported as connected.
- (krobipd) Fixed: a key you hold right after a short press stays pressed instead of being released early.
- (krobipd) Fixed: the device dialog now also refuses a name that would collide with an existing device in the object tree.
- (krobipd) Improved: after the host gets a new IP address, remotes find the emulated Rokus again without restarting the instance.
- (krobipd) Changed: the network interface setting moved to the standard settings key (bind); the instance restarts once after this update.

## 1.6.1 (2026-09-07) — stable

- (krobipd) Changed: installing straight from GitHub is no longer offered — the adapter is built before publishing, so it is installed from the ioBroker repository instead.

## 1.6.0 (2026-09-07)

- (krobipd) Fixed: saving a device in the admin could change its identity on the network, so a paired Harmony or Sofabaton lost it.
- (krobipd) Fixed: with the device list open twice, editing or deleting a card could hit a different emulated Roku than the one clicked.
- (krobipd) Fixed: releasing a key was dropped while the adapter shed a flood of commands, so the key could stay pressed for half a minute.
- (krobipd) Fixed: an ECP port still held after a restart left that device dead until you restarted the instance; it is retried every minute now.
- (krobipd) Fixed: stopping the instance now takes the emulated Rokus out of the remote's list instead of leaving them there for up to an hour.
- (krobipd) Fixed: an emulated Roku whose server died is no longer offered for discovery.
- (krobipd) Fixed: a configured port no server can bind falls back to 8060 instead of leaving the device unstarted.
- (krobipd) Changed: the device dialog refuses a reserved or colliding name right away instead of reporting it after saving.
- (krobipd) Changed: the adapter can now run in compact mode, sharing one process with other adapters instead of claiming its own.
- (krobipd) Changed: more than one instance may run on the same machine again; only the ports have to differ.

## 1.5.0 (2026-09-03)

- (krobipd) Fixed: deleting the last emulated Roku left all of its datapoints behind for good. They are now removed whenever the configuration says a device is gone.
- (krobipd) Fixed: on a host running Docker the adapter could announce itself under a container address no remote can reach. A real network address is preferred now.
- (krobipd) Fixed: an emulated Roku whose server died while running left the instance showing "connected". It now reports the failure and names the device.

## 1.4.0 (2026-09-03)
- (krobipd) Fixed: renaming an emulated Roku could change its identity on the network, so a paired Harmony or Sofabaton lost the device and had to be set up again.
- (krobipd) Fixed: a remote key that was pressed when the adapter stopped stayed on for good. All key datapoints are now released at start-up, so the next press works again.
- (krobipd) Fixed: a device named "info" entered by hand into the configuration replaced the instance's own status channel. The name is refused now and leftovers are removed.
- (krobipd) Changed: every datapoint now carries a translated name and, where useful, a short description — in all eleven languages, in existing installations as well.
- (krobipd) Improved: a remote with a globally routable IPv6 address is accepted when it sits in the same network as the ioBroker host, not just on the reserved IPv6 ranges.
- (krobipd) New: user documentation in English and German, shown in the ioBroker documentation portal.

## 1.3.0 (2026-09-01)
- (krobipd) Fixed: a malformed keyboard keypress from a remote (a bad %-escape in the URL) could crash the adapter.
- (krobipd) Fixed: remotes on an IPv6-only local network were refused; link-local and unique-local IPv6 addresses now count as LAN.
- (krobipd) Fixed: the adapter icon in the admin is now the same one shown on GitHub.
- (krobipd) Changed: requires admin >= 8.0.11.
- (krobipd) Improved: discovery answers only searches from your own network, and the device dialog in the admin keeps working after the device list was edited by hand.
- (krobipd) Improved: the emulated Roku reports Roku OS 15.0 (was 14.1), and the command-type datapoint lists its possible values so the admin shows them as labels.
- (krobipd) New: a misbehaving device on your network can no longer flood ioBroker — more than 25 commands per second per emulated Roku are dropped and reported in the log.

## 1.2.0 (2026-08-27)
- (krobipd) Changed: the instance now reports "not connected" while a configured Roku is missing — a device whose port is taken no longer hides behind the ones that did start.
- (krobipd) Improved: shutdown now waits for its last write to land before reporting done, so the connection state cannot be lost on a slow or busy system.
- (krobipd) New: optional error reporting via Sentry — only active if you enabled diagnostics in ioBroker, and it transmits no personal data.

## 1.1.0 (2026-08-10) — stable
- (krobipd) Several emulated Rokus are now independent at start-up: if one is set to a port already in use, the others still start instead of the whole instance failing.
- (krobipd) The adapter keeps serving already-paired remotes, and reports its status correctly, even when network discovery cannot start or later drops out.
- (krobipd) Discovery now covers every network interface on a host that has more than one, so a remote on any of your local networks can find the emulated Rokus.
- (krobipd) The device dialog now refuses a name that would clash with another device or a reserved name, preventing a naming conflict.
- (krobipd) The adapter description now reads correctly in the non-English and non-German admin languages.

## 1.0.0 (2026-08-05)
- (krobipd) First stable release — version 1.0.0 marks the complete rewrite as the mature, supported version of the adapter.
- (krobipd) Upgrading from an older version now shows a one-time notice that the button data points changed from text to real boolean values, so scripts and visualizations can be checked.

## 0.9.0 (2026-08-03)
- (krobipd) Device cards drop the redundant "Roku" manufacturer line — an emulator's maker is always Roku, so a card now shows just the model (Player/TV) and the ECP port

## 0.8.0 (2026-08-01)
- (krobipd) Devices from the old fakeroku keep working after updating — the emulated Roku's identity and network binding are carried over, so a paired remote stays paired without re-pairing
- (krobipd) Adding a device now pre-selects a free port and refuses a name or port already in use, so two Rokus can't collide; each device card shows the port on its own line

## 0.7.1 (2026-07-31)
- (krobipd) Fixed the device management from 0.7.0: your emulated Rokus now show up as cards again and the button to add a new one works — both were missing before

## 0.7.0 (2026-07-31)
- (krobipd) Each emulated Roku can now be a Player or a TV — a TV additionally exposes volume, power, channel and input keys, a Player the 16 standard keys
- (krobipd) Devices are now managed as cards with add/edit/delete dialogs instead of a table, and the settings page gained a network section and support links

## 0.6.0 (2026-08-05)
- (krobipd) Complete rewrite. The adapter now answers the full Roku control surface — including device-info with a current Roku version — so Logitech Harmony and Sofabaton remotes pair and work reliably.
- (krobipd) Works out of the box: it detects the network address to advertise on its own, no manual interface picking.
- (krobipd) Manage multiple emulated Rokus from the admin UI, each as a Player or a TV.
- (krobipd) Cleaner object tree — one datapoint per remote button with the correct types, plus a last-command datapoint; leftover objects from older versions are removed on start.

## 0.5.1 (2026-08-05)
- (mcm1957) Adapter requires Node.js >= 22 now
- (mcm1957) Dependencies have been updated

## 0.5.0 (2026-07-30)
- (krobipd) Complete rewrite with the full Roku control surface, including `device-info` with a current Roku version — the part modern remotes check at pairing, beyond what a classic Harmony hub needs
- (krobipd) New clean data model: a `command` datapoint plus fixed `keys.<Key>` states, all created up front instead of appearing only after the first keypress
- (krobipd) Discovery binds to the chosen network interface, command handling is restricted to the local network

## 0.4.0 (2026-03-07)
- (mcm1957) Adapter requires node.js >= 20, admin >= 7.7.22, js-controller >= 6.0.11

## 0.3.0 (2024-06-11)
- (mcm1957) Adapter requires node.js >= 18 and js-controller >= 5 now
- (mcm1957) Dependencies have been updated

## 0.2.3 (2024-06-11)
- (mcm1957) Adapter requires node.js >= 18 and js-controller >= 5 now
- (mcm1957) Dependencies have been updated

## 0.2.2 (2023-07-24)
- (Apollon77) fixed issues with controller v5

## 0.2.1
- (Pmant) fix jQuery error in admin
- (ykuendig) add translations

## 0.2.0
- (Pmant) run multiple fakeroku's in one instance

## 0.1.1
- (Pmant) fix package.json

## 0.1.0
- (Pmant) initial release
