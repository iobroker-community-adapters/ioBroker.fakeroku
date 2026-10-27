# CLAUDE.md — ioBroker.fakeroku

Adapter-spezifischer Kontext. Globale Dev-Standards: `../CLAUDE.md` + `../CLAUDE_*.md`; generische ioBroker-Mechanik steht dort, nicht hier.

## Projekt

Roku-Emulator im LAN: eine Logitech Harmony (höchstens noch eine Sofabaton) findet einen emulierten Roku und löst über Tastendrücke Ereignisse in ioBroker aus — die **Eingabe-Seite**, Gegenstück zum harmony-Adapter (Ausgabe). Community-Adapter (`iobroker-community-adapters`), Neubau des `fakeroku` von Pmant (2017), krobi Maintainer. Version: `io-package.json`.

## Architektur (`src/`)

- **`main.ts`** — Lifecycle: `I18n.init` zuerst, dann der Gerätemanager; `repairInstanceObject` (Flotten-Helfer `migrateNativeKeys`, EIN Schreibvorgang); EIN Objekt-Abzug (`KnownObjects`, `knownTree`) und EIN Zustands-Abzug (`StatusBoard.primeStates`) beim Start; `persistDeviceRows` (Erststart: eigene Kennung; Zeile vor 0.7.0: Typ und Port einmal festschreiben); Interface-Regel über den Flotten-Master `network-address` (`chosenAddress`, `carriesAddress` → fehlende gewählte Adresse = alle Adressen + `bindMissing`, `isOwnPeer` als Vertrauensgrenze); je Gerät ein `DeviceRuntime`-Datensatz (Id, Name, Advert, Typ, Tasten, Server), `running` und `healthy` daraus abgeleitet; der Minuten-Neuversuch `retryPendingDevices` für ausgefallene Rokus und die Erkennung; `updateConnection` reicht den Laufzeitzustand an `StatusBoard.show`; Waisen-Durchgang; `onUnload` schreibt zuletzt (`.finally`).
- **`status-board.ts`** — `StatusBoard` (Host = der Adapter): die eine Schreibstelle aller Anzeigen — je Roku `info.online` + `info.error`, die drei Summen und `info.connection` in einem Durchgang, geschrieben nur bei Unterschied zum Zustands-Abzug (`writeIndicator`); `markOffline` als Start- und Ende-Stempel; `UNKNOWN_REASON`.
- **`discovery/discovery-lifecycle.ts`** — `DiscoveryLifecycle`: Start, Neustart und Ende des SSDP-Responders samt NOTIFY-Takt und `byebye`; `onSsdpFatal` schließt den Rest und meldet über `hooks.onDown` an den Adapter; Wiederholung eines Ausfalls auf debug.
- **`command-handler.ts`** — Befehl → Zustand: `command`, Impuls (50 ms), Halten mit 30-s-Wächter, Ratenbegrenzung je Gerät; besitzt seine Zeitgeber, `dispose()` im `onUnload`; die Zeitgeber im `CommandHost` sind als Eigenschaften mit Funktionstyp deklariert, nicht als Methoden-Signatur (der Prüfbot liest `setTimeout(` am Zeilenanfang als blanken Aufruf, S5005).
- **`device-management.ts`** — Gerätemanager (dm-utils): Karten je Gerät (Id = Identität, Status live aus `info.online` + `info.error` über `stateId`), Dialog mit `applyDisabledRule`, liest/schreibt `native.devices` über `lib/device-config`.
- **`discovery/ssdp-responder.ts`** — handgebauter `dgram`-SSDP-Responder (0.0.0.0:1900, `reuseAddr`): Beitritt einmal je Interface, eigene Geräteliste, Antwort mit der Adresse aus dem Netz des Suchenden, NOTIFY/byebye je Interface. ⚠️ `node-ssdp` taugt nicht: es hängt `::device` ans USN.
- **`discovery/ssdp-messages.ts`** — reine Datagramme (Suchantwort, alive, byebye, Suchziel), `usnOf`, `ROKU_DEVICE_TYPE`.
- **`ecp/ecp-http-server.ts`** — ein `node:http` je Gerät (`maxConnections` 32): Description, SCPD, device-info, apps, icon; POST → `CommandEvent`, protokolliert nach der Ratenbegrenzung; Vertrauensgrenze über `isClientAllowed`; abgewiesene und verworfene Verbindungen nur gedrosselt auf debug (`log-throttle`).
- **`ecp/device-info.ts`** — Profile Player/TV, `SOFTWARE_VERSION`, `DEFAULT_APPS`, die Abfrage-Antworten. **`ecp/ecp-command.ts`** — Parser POST-URL → `CommandEvent`. **`ecp/state-model.ts`** — `canonicalKey`, `commandToStateWrite`; die Tastenlisten `BASE_KEYS` + `TV_KEYS` stehen in `lib/roku-keys.ts`.
- **`lib/`** — `device-config` (EINE Lesestelle für `native.devices`, feste `objectId`), `device-identity`, `detect-ip` (Beitritte, Erstadresse, Adresse im Netz des Suchenden — auf dem Master), `rate-gate`, `log-throttle` (Ratenwarnung K21 und die debug-Ausdünnung im ECP-Server), `object-cleanup`, `pure-helpers`, `roku-keys`, `device-icons` (Piktogramm je Gerätetyp aus `admin/icons/` als Inline-SVG-URI), `constants` (`LANGUAGES`, `instanceObjectId`, `RESERVED_IDS`, `OWN_INFO_IDS`, `DEFAULT_ECP_PORT`, `DEVICE_ONLINE_ID`/`DEVICE_ERROR_ID`, `RETRY_INTERVAL_MS`/`RETRY_NOTE`), `i18n`, `logger`; Flotten-Master byte-gleich: `err-text`, `known-objects`, `log-once` (SSDP-Responder), `native-key-migration`, `network-address`, dazu `test/network-hook.js`, `test/fleet-suites.js`, `test/resource-probe.js`. Die Einstellungs-Typen: `src/types/adapter-config.d.ts`.

<!-- core-decisions:begin (generated from the sealed register — change only through the Werkbank) -->

## Core decisions (sealed)

krobi's decisions for this adapter. The register with his verbatim words lives in the locked Werkbank tool tree; a change is a request to the Werkbank, never an edit here. Each guarded rule has a test under `src/decisions/`.

- **F-00** fakeroku provides a virtual Roku that a remote such as Logitech Harmony finds; there one puts Roku keys on own buttons and triggers ioBroker scripts with them. Beyond that at most Sofabaton, for which there may be more functions. No Home Assistant, no invented cases.
- **F-01** Every emulated Roku has a rate limit for commands; what goes beyond it is dropped.
- **F-02** Two presses of the same key within 50 ms stay as they are: the second pulse is not lengthened.
- **F-03** The symbol is the existing admin/fakeroku.svg, for icon, extIcon and the README head; it is not drawn anew.
- **F-04** fakeroku accepts commands and searches only from its own networks, over IPv6 too with an address from the own network; everything else stays out.
- **F-07** The app list stays fixed; fakeroku does not become a dynamic adapter with apps to set.
- **F-08** Green means everything runs. Yellow means something is wrong and a part runs. Red means nothing runs. Every problem gets one log line with its likely cause when it first occurs, repeats only at debug, and one info line when it works again. No Roku configured or none running: yellow with one error line (with no Roku, the request to add a device), the instance keeps running. Every Roku has `<roku>.info.online` (true while its ECP server listens) and `<roku>.info.error` (the cause; `Unknown` while the adapter is off or not started yet; empty while the Roku runs); the device shows the symbol in the object tree through `statusStates.onlineId`, the card in the device manager shows online/offline and the error text. Plus `info.devicesTotal`, `info.devicesOnline` and `info.devicesAllOnline` in the fleet form.
- **F-09** The ECP port is a free field per Roku, default 8060; there is no automatic assignment.
- **F-11** Every emulated Roku is either a player or a TV; only the TV has the keys for volume, power, channel and input.
- **K2** A Roku keeps its identity when renamed; the remote does not have to learn it again.
- **K3** A Roku's object id is fixed; renaming changes only the displayed name.
- **K4** A device without a type (from a version before 0.7.0) gets its type written into the settings once, derived from its existing tree (TV keys make it a TV).
- **K5** The old settings of the 2017 adapter in the instance object (`HTTP_PORT`, `MULTICAST_IP`, `UUID`, `BIND`, `license`, `singletonHost`) are removed in one write; identity and bind address are carried over.
- **K7** The cards in the device manager carry the Roku's identity as their id.
- **K9** Held keys have a 30-second watchdog; the release never runs into the rate limit.
- **K10** Key states are set to false at the start, only where they are not false already.
- **K13** Deleting a Roku in the device manager asks first; afterwards its datapoints are gone.
- **K18** The queries a Harmony and a Sofabaton make are answered: device info and app list.
- **K19** UDP 1900 is shared: several Rokus and instances per host.
- **K20** The device dialog blocks “OK” while name or port collide and names the reason.
- **K21** 25 commands per second and Roku, at most one warning per minute naming the device.

<!-- core-decisions:end -->

## Design-Entscheidungen

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen in `.claude/dev-history.md` (dort auch der frühere Wortlaut dieses Registers, Eintrag 2026-10-01)._

1. **Datenmodell** — `<gerät>.info.online` (boolean, `indicator.reachable`, hinter `statusStates.onlineId`), `<gerät>.info.error` (string, `text`: `Unknown` / leer / Ursache), `<gerät>.command` (string, `text`) und feste `<gerät>.keys.<Key>` (boolean, Rolle `sensor`, nicht `button.press` wegen E1010/E1011), alle Tasten vorab angelegt; `Lit_`-Eingaben und App-Starts landen nur in `command`; auf Instanzebene `info.devicesTotal` / `devicesOnline` / `devicesAllOnline`.
2. **Identität überlebt das Umbenennen** — eine Zeile ohne `uuid` wird über `deriveUuid(gespeicherter Name)` identifiziert; ein neues Gerät (Dialog, Erststart ohne Baum) bekommt `randomIdentity()`, geschrieben vor der ersten Ankündigung.
3. **Die Objekt-ID ist fest** — gespeicherte `objectId`, sonst der vorhandene Baum (heutige ID oder Alt-ID `name.replace(/[.\s]+/g, "_")`), sonst `sanitizeId(gespeicherter Name)`; Umbenennen ändert nur den angezeigten Namen.
4. **Eine typlose Zeile (vor 0.7.0) bekommt ihren Typ EINMAL in `native.devices` geschrieben** — abgeleitet aus dem Baum (TV-Tasten dort machen sie zum TV), im selben Schreibvorgang wie Kennung, Objekt-ID und Port (unbrauchbar: Alt-Vorgabe 9093); danach liest kein Start den Baum mehr dafür.
5. **Leichen im Instanzobjekt gehen in EINEM Schreibvorgang** — `common.license`/`singletonHost` per `commonDrop`, `HTTP_PORT`/`MULTICAST_IP`/`UUID`/`BIND` per `drop`, `networkInterface` gewinnt vor `BIND`; ein Neustart.
6. **`compact: true`, kein `singletonHost`** — Konstruktor-Export, kein veränderlicher Modulzustand, `onUnload` gibt alles frei; gehalten von den Compact-Tests in `main.lifecycle.test.ts` und `manifest.test.ts`.
7. **Karten im Gerätemanager tragen die Identität als Id**, nicht die Listenposition.
8. **Grün = alles läuft, gelb = etwas stimmt nicht, rot = nur ein abgestürzter Prozess** (krobi 2026-10-03) — `healthy` heißt: jeder Roku lauscht, die Erkennung antwortet und die gewählte Adresse existiert; jeder Ausfall (belegter Port, `onEcpFatal`, `onSsdpFatal`, Startfehler, kein IPv4) ist gelb und wird jede Minute erneut versucht, ohne angelegten oder laufenden Roku bleibt die Instanz gelb für den Gerätemanager am Leben, und alle Anzeigen (je Roku `info.online` + `info.error`, die drei Summen) entstehen im selben Durchgang wie `info.connection`, beim Start und Beenden offline mit `Unknown`, nur `devicesTotal` bleibt beim Beenden stehen (krobi 2026-10-03 15:18).
9. **Das Loslassen einer gehaltenen Taste passiert nie die Ratenbegrenzung**; ein `keypress` auf eine gehaltene Taste entwaffnet deren Wächter.
10. **Tastenzustände werden beim Start auf `false` gesetzt**, nicht im `onUnload` — verglichen mit dem Zustands-Abzug, geschrieben nur, wo sie nicht `false` sind.
11. **`info` ist reserviert** — `RESERVED_IDS` im Dialog und in `startDevices`; der Waisen-Durchgang schützt nur `OWN_INFO_IDS`.
12. **`refreshOwnObjects` frischt Name und Beschreibung von `info`, `info.connection` und den drei Summen auf**, nur wo sie vom gespeicherten Objekt abweichen; alle Namen über `tName`/`tDesc`/`tRaw`.
13. **Objekte und Anzeigen werden nur bei Unterschied geschrieben** — Objekte über `KnownObjects.extend`, `info.connection`, Summen und Marker über `StatusBoard` gegen den Zustands-Abzug.
14. **Vertrauensgrenze = die eigenen Netze** (krobi 2026-09-24, 2026-10-03) — Netz einer eigenen Schnittstelle, ohne Ausnahme für Loopback oder Link-local; mit gewählter Schnittstelle nur deren Netz: dort wird gelauscht, gesendet und angenommen.
15. **Der Waisen-Durchgang läuft an jedem Konfigurations-Ausstieg von `onReady`** — `toDeviceRows` = `null` (kein `devices`-Schlüssel) räumt nichts, `[]` räumt alles.
16. **„Alle Schnittstellen“ bedient jedes eigene Netz mit der eigenen Adresse darin** — jede Suche bekommt die Adresse aus dem Netz des Suchenden, jeder NOTIFY die Adresse seiner Schnittstelle; keine Schnittstelle wird am Namen ausgefiltert (krobi 2026-10-03), ohne IPv4 ist die Erkennung ausgefallen wie bei jedem anderen Startfehler.
17. **Eine gewählte Schnittstelle hält alles in ihrem Netz** (krobi 2026-09-24) — trägt der Rechner ihre Adresse nicht, lauscht fakeroku auf allen Adressen, schreibt genau eine warn-Zeile mit der Ursache und meldet `info.connection` false (krobi 2026-10-02); `native.bind` bleibt unverändert.
18. **Jedes Problem schreibt beim ersten Auftreten genau eine Zeile mit Ursache, die Wiederholung debug, die Rückkehr einmal info** — läuft keiner, ist es EINE error-Zeile mit allen Rokus und Gründen; die Erkennung hält das über `discoveryDown` und den Flotten-Master `LogOnce`, der ECP-Server protokolliert seinen Laufzeitfehler nur auf debug.
19. **Ein SSDP-Empfangsfehler schaltet die Erkennung nicht ab**; tödlich ist nur ein `close`, das `stop()` nicht ausgelöst hat — dann schließt der Adapter den Rest des Responders und startet ihn mit dem Minuten-Neuversuch neu.
20. **Beantwortet wird, was Harmony und Sofabaton lesen** — Description, SCPD, device-info, apps, icon; jede andere Abfrage ist 404, Tastennamen ohne Groß-/Kleinschreibung.
21. **⚠️ Play≠Pause ist protokollbedingt ungelöst** (Harmony sendet für beide `Play`); **Harmony-App-Tasten erreichen den Adapter nicht**; die App-Liste bleibt fest (krobi 2026-09-24).
22. **Port 8060 ist Vorgabe, das Feld bleibt frei** (krobi 2026-07-30) — Harmony/Sofabaton lesen den Port aus der Erkennung, Home Assistant und Homey sprechen fest 8060.
23. **UDP 1900 wird mit `reuseAddr` geteilt** — mehrere Rokus je Instanz und mehrere Instanzen je Rechner; nur ein fremdes Programm ohne Wiederverwendung führt in den Ablehnungszweig von `startDiscovery`.
24. **Listen-Port-Standard** — `native.bind` (`"0.0.0.0"` = alle), kein `native.port`; `fleet.json listenPorts`: `devices[].port` (perDevice) + SSDP 1900 (shared).
25. **Ratenbegrenzung 25 Befehle/s je emuliertem Roku** (krobi 2026-09-01), Warnung höchstens 1×/min mit dem Gerätenamen.
26. **Das Alt-Attribut `native.url` verschwindet in EINEM `setForeignObject`** des gelesenen Objekts (`planNativePrune` + `pruneStateNative`), nie per `delObject` + Neuanlage.
27. **Der Gerätedialog sperrt OK über `applyDisabledRule`**; der Grund steht als `staticText`, `findClash` sichert dahinter ab.
28. **Ein Symbol** — `admin/fakeroku.svg` für `icon`, `extIcon` und den README-Kopf; davon getrennt trägt jedes Geräteobjekt das Piktogramm seines Typs (`admin/icons/player.svg`, `tv.svg`) als Inline-SVG-URI in `common.icon`.
29. **Sentry über `common.plugins.sentry`**, kein Code; README-Abzeichen und Abschnitt sind gate-erzwungen.
30. **Zweige** — Arbeit auf `developing`, Release von `master`; die CI prüft beide, `deploy` nur am Tag.

## Tests

- vitest über `src/**/*.test.ts`, `test/standards/*.test.ts` und `tools/**/*.test.ts`. Die Orchestrierung von `main.ts` liegt in fünf Dateien nach Verantwortung — `main.start`, `main.settings`, `main.network`, `main.commands`, `main.lifecycle` — gegen ein `@iobroker/adapter-core`-Doppel; `status-board.test` prüft die Anzeigen gegen einen eigenen Zustandsspeicher. Doppel und Vorbereitung unter `test/helpers/` (nicht `src/`, sonst gebaut und ausgeliefert): `adapter-core-double` (tiefes `node.extend`, teures `delObject`, `def` nur in fehlende Zustände, Kopien beim Lesen, `written`), `os-double`, `fakeroku-harness` (`setup`, Fakes, `settle`, `missingPrivateMembers` als Laufzeitprüfung der privaten Zugriffe), `i18n-double`, `ssdp-fixtures`. Den echten Start fährt `test/integration.js`.
- **`main.ts` exportiert die Klasse nicht** — ein `export` neben `module.exports` lässt esbuild die Datei als ES-Modul lesen (Warnung `commonjs-variable-in-esm`, D05 rot); die Klasse reitet auf der Factory (`Object.assign(factory, { Fakeroku })`), Tests und Wächter holen sie per Namensraum-Import mit Cast.
- **`npm run test:inventory`** (nach `npm run build`, über `with-werkstatt-lock.py`) erzeugt `test/objects.inventory.json` aus einem Player und einem TV nach der Flottenvorlage, die Flotten-Suiten aus `test/fleet-suites.js` laufen darin mit; die Aufstiegs-Suite läuft nur mit `INVENTORY_PREVIOUS` (der Vorlauf setzt es). Beschreibungs-Entscheidung: `test/self-explaining.json` (`*.keys.*`).
