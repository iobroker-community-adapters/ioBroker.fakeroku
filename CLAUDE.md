# CLAUDE.md — ioBroker.fakeroku

Adapter-spezifischer Kontext. Globale Dev-Standards: `../CLAUDE.md` + `../CLAUDE_*.md`; generische ioBroker-Mechanik steht dort, nicht hier.

## Projekt

Roku-Emulator im LAN: ein ECP/SSDP-Controller (Logitech Harmony, Sofabaton, Home Assistant/rokuecp, openHAB) findet einen emulierten Roku und löst über Tastendrücke Ereignisse in ioBroker aus — die **Eingabe-Seite**, Gegenstück zum harmony-Adapter (Ausgabe). Community-Adapter (`iobroker-community-adapters`), Greenfield-Neubau des `fakeroku` von Pmant (2017) ab 0.5.0, an Nutzer ausgeliefert ab 0.6.0, krobi Maintainer. Version: `io-package.json`. Feld-/Protokoll-Details: `../../Ressourcen/rokuemu/`, Audits: `../../Ressourcen/fakeroku/`.

## Architektur (`src/`)

- **`main.ts`** — Lifecycle: `I18n.init` zuerst, dann der Gerätemanager; `repairInstanceObject` (Flotten-Helfer `migrateNativeKeys`, EIN Schreibvorgang); EIN Objekt-Abzug (`KnownObjects`) und EIN Zustands-Abzug (`primeStates`) beim Start; `persistNewIdentities` (Erststart); Interface-Regel (`awaitBindAddress`, `isOwnClient`); je Gerät ein `DeviceRuntime`-Datensatz (Id, Name, Advert, Typ, Tasten, Server), `running` daraus abgeleitet; Wiederholung belegter Ports; Waisen-Durchgang; `writeIndicator` (die eine Schreibstelle für `info.connection`); `onUnload` schreibt zuletzt (`.finally`).
- **`command-handler.ts`** — Befehl → Zustand: `command`, Impuls (50 ms), Halten mit 30-s-Wächter, Ratenbegrenzung je Gerät; besitzt seine Zeitgeber, `dispose()` im `onUnload`; die Zeitgeber im `CommandHost` sind als Eigenschaften mit Funktionstyp deklariert, nicht als Methoden-Signatur (der Prüfbot liest `setTimeout(` am Zeilenanfang als blanken Aufruf, S5005).
- **`device-management.ts`** — Gerätemanager (dm-utils): Karten je Gerät (Id = Identität), Dialog mit `applyDisabledRule`, liest/schreibt `native.devices` über `lib/device-config`.
- **`discovery/ssdp-responder.ts`** — handgebauter `dgram`-SSDP-Responder (0.0.0.0:1900, `reuseAddr`): Beitritt einmal je Interface, eigene Geräteliste, Antwort mit der Adresse aus dem Netz des Suchenden, NOTIFY/byebye je Interface. ⚠️ `node-ssdp` taugt nicht: es hängt `::device` ans USN.
- **`discovery/ssdp-messages.ts`** — reine Datagramme (Suchantwort, alive, byebye, Suchziel), `usnOf`, `ROKU_DEVICE_TYPE`.
- **`ecp/ecp-http-server.ts`** — ein `node:http` je Gerät (`maxConnections` 32): Description, SCPD, device-info, apps, active-app, media-player, tv-channels (nur TV), icon; POST → `CommandEvent`, protokolliert nach der Ratenbegrenzung; Vertrauensgrenze über `isClientAllowed`.
- **`ecp/device-info.ts`** — Profile Player/TV, `SOFTWARE_VERSION`, `DEFAULT_APPS`, die Abfrage-Antworten. **`ecp/ecp-command.ts`** — Parser POST-URL → `CommandEvent`. **`ecp/state-model.ts`** — `BASE_KEYS` + `TV_KEYS`, `canonicalKey`, `commandToStateWrite`.
- **`lib/`** — `device-config` (EINE Lesestelle für `native.devices`, feste `objectId`), `device-identity`, `detect-ip` (Netz-Modell, `net.BlockList` für die Subnetz-Prüfung, virtuelle Brücken am Namen), `lan-guard`, `rate-gate`, `log-throttle`, `object-cleanup`, `pure-helpers`, `constants` (`LANGUAGES`, `instanceObjectId`, `RESERVED_IDS`), `i18n`, `logger`; Flotten-Master byte-gleich: `err-text`, `known-objects`, `native-key-migration`.

## Design-Entscheidungen

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen in `.claude/dev-history.md` (dort auch der frühere Wortlaut dieses Registers, Eintrag 2026-10-01)._

1. **Datenmodell** — `<gerät>.command` (string, `text`) und feste `<gerät>.keys.<Key>` (boolean, Rolle `sensor`, nicht `button.press` wegen E1010/E1011), alle Tasten vorab angelegt; `Lit_`-Eingaben und App-Starts landen nur in `command`.
2. **Identität überlebt das Umbenennen** — eine Zeile ohne `uuid` wird über `deriveUuid(gespeicherter Name)` identifiziert; ein neues Gerät (Dialog, Erststart ohne Baum) bekommt `randomIdentity()`, geschrieben vor der ersten Ankündigung.
3. **Die Objekt-ID ist fest** — gespeicherte `objectId`, sonst der vorhandene Baum (heutige ID oder Alt-ID `name.replace(/[.\s]+/g, "_")`), sonst `sanitizeId(gespeicherter Name)`; Umbenennen ändert nur den angezeigten Namen.
4. **Eine typlose Zeile (vor 0.7.0) nimmt ihren Typ aus dem Baum** — TV-Tasten dort machen sie zum TV; ihr unbrauchbarer Port fällt auf die Alt-Vorgabe 9093.
5. **Leichen im Instanzobjekt gehen in EINEM Schreibvorgang** — `common.license`/`singletonHost` per `commonDrop`, `HTTP_PORT`/`MULTICAST_IP`/`UUID`/`BIND` per `drop`, `networkInterface` gewinnt vor `BIND`; ein Neustart.
6. **`compact: true`, kein `singletonHost`** — Konstruktor-Export, kein veränderlicher Modulzustand, `onUnload` gibt alles frei; gehalten von den Compact-Tests in `main.lifecycle.test.ts` und `manifest.test.ts`.
7. **Karten im Gerätemanager tragen die Identität als Id**, nicht die Listenposition.
8. **Ein beim Start belegter ECP-Port wird jede Minute erneut versucht**; ein Server, der im Lauf stirbt (`onEcpFatal`), wird nicht wiederholt, sondern aus der SSDP-Liste genommen.
9. **Das Loslassen einer gehaltenen Taste passiert nie die Ratenbegrenzung**; ein `keypress` auf eine gehaltene Taste entwaffnet deren Wächter.
10. **Tastenzustände werden beim Start auf `false` gesetzt**, nicht im `onUnload` — verglichen mit dem Zustands-Abzug, geschrieben nur, wo sie nicht `false` sind; die 50-ms-Impulsüberlappung bleibt.
11. **`info` ist reserviert** — `RESERVED_IDS` im Dialog und in `startDevices`; der Waisen-Durchgang schützt nur `OWN_INFO_IDS`.
12. **`refreshOwnObjects` frischt Name und Beschreibung von `info` + `info.connection` auf**, nur wo sie vom gespeicherten Objekt abweichen; alle Namen über `tName`/`tDesc`/`tRaw`.
13. **Objekte und Anzeigen werden nur bei Unterschied geschrieben** — Objekte über `KnownObjects.extend`, `info.connection` über `writeIndicator` gegen den Zustands-Abzug.
14. **Vertrauensgrenze = die eigenen Netze** (krobi 2026-09-24) — Netz einer eigenen Schnittstelle, dazu Loopback und Link-local; mit gewählter Schnittstelle nur deren Netz.
15. **Der Waisen-Durchgang läuft an jedem Konfigurations-Ausstieg von `onReady`** — `toDeviceRows` = `null` (kein `devices`-Schlüssel) räumt nichts, `[]` räumt alles.
16. **„Alle Schnittstellen“ bedient jedes eigene Netz mit der eigenen Adresse darin**; virtuelle Brücken werden am Namen erkannt (Rückfall 172.17./172.18.); ohne IPv4 lauschen die ECP-Server, die Erkennung startet nach.
17. **Eine gewählte Schnittstelle hält alles in ihrem Netz** (krobi 2026-09-24) — fehlt ihre Adresse, wird sie 2 min lang alle 10 s gesucht, dann Fehlerzeile, kein Rückfall.
18. **Ein sterbender ECP-Server widerruft `info.connection`** (`onFatalError` → `onEcpFatal`, Meldung nennt das Gerät).
19. **Ein SSDP-Empfangsfehler schaltet die Erkennung nicht ab**; tödlich ist nur ein `close`, das `stop()` nicht ausgelöst hat.
20. **Die Abfragen der Clients werden beantwortet** (active-app, media-player, tv-channels, icon), Tastennamen ohne Groß-/Kleinschreibung.
21. **⚠️ Play≠Pause ist protokollbedingt ungelöst** (Harmony sendet für beide `Play`); **Harmony-App-Tasten erreichen den Adapter nicht**; die App-Liste bleibt fest (krobi 2026-09-24).
22. **Port 8060 ist Vorgabe, das Feld bleibt frei** (krobi 2026-07-30) — Harmony/Sofabaton lesen den Port aus der Erkennung, Home Assistant und Homey sprechen fest 8060.
23. **UDP 1900 wird mit `reuseAddr` geteilt** — mehrere Rokus je Instanz und mehrere Instanzen je Rechner; nur ein fremdes Programm ohne Wiederverwendung führt in den Ablehnungszweig von `startDiscovery`.
24. **Listen-Port-Standard** — `native.bind` (`"0.0.0.0"` = alle), kein `native.port`; `fleet.json listenPorts`: `devices[].port` (perDevice) + SSDP 1900 (shared).
25. **Ratenbegrenzung 25 Befehle/s je emuliertem Roku** (krobi 2026-09-01), Warnung höchstens 1×/min mit dem Gerätenamen.
26. **Das Alt-Attribut `native.url` verschwindet in EINEM `setForeignObject`** des gelesenen Objekts (`planNativePrune` + `pruneStateNative`), nie per `delObject` + Neuanlage.
27. **Der Gerätedialog sperrt OK über `applyDisabledRule`**; der Grund steht als `staticText`, `findClash` sichert dahinter ab.
28. **Ein Symbol** — `admin/fakeroku.svg` für `icon`, `extIcon` und den README-Kopf.
29. **Sentry über `common.plugins.sentry`**, kein Code; README-Abzeichen und Abschnitt sind gate-erzwungen.
30. **Zweige** — Arbeit auf `developing`, Release von `master`; die CI prüft beide, `deploy` nur am Tag.

## Tests

- vitest über `src/**/*.test.ts`. Die Orchestrierung von `main.ts` liegt in fünf Dateien nach Verantwortung — `main.start`, `main.settings`, `main.network`, `main.commands`, `main.lifecycle` — gegen ein `@iobroker/adapter-core`-Doppel; Doppel und Vorbereitung unter `test/helpers/` (nicht `src/`, sonst gebaut und ausgeliefert): `adapter-core-double` (tiefes `node.extend`, teures `delObject`, `def` nur in fehlende Zustände, Kopien beim Lesen, `written`), `os-double`, `fakeroku-harness` (`setup`, Fakes, `settle`, `privateMembersExist` als Typprüfung der privaten Zugriffe), `i18n-double`, `ssdp-fixtures`. Den echten Start fährt `test/integration.js`.
- **`npm run test:inventory`** (nach `npm run build`, über `with-werkstatt-lock.py`) erzeugt `test/objects.inventory.json` aus einem Player und einem TV nach der Flottenvorlage; die Aufstiegs-Suite läuft nur mit `INVENTORY_PREVIOUS` (der Vorlauf setzt es). Beschreibungs-Entscheidung: `test/self-explaining.json` (`*.keys.*`).
- Mutationsnadeln: `Ressourcen/iobroker-entwicklung/mutation-testing/mutations_fakeroku*.py`; Test-Audits: `Ressourcen/fakeroku/test-audit-*.md`.
