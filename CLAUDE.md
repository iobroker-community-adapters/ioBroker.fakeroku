# CLAUDE.md — ioBroker.fakeroku

Adapter-spezifischer Kontext. Globale Dev-Standards: `../CLAUDE.md` + `../CLAUDE_*.md`.

## Projekt
Roku-Emulator im LAN: ein ECP/SSDP-Controller (Logitech Harmony, Sofabaton) findet einen emulierten Roku und löst über Tastendrücke Ereignisse in ioBroker aus — die **Eingabe-Seite**, Gegenstück zum harmony-Adapter (Ausgabe). Greenfield-Neubau ab **v0.5.0** des community-`fakeroku` (Pmant 2017, Community-Wartung bis 0.4.0); Übernahme durch krobi. Feld-/Protokoll-Details: `../../Ressourcen/rokuemu/`.

## Architektur (`src/`)
- **`discovery/ssdp-responder.ts`** — handgebauter `dgram`-SSDP-Responder (Port 1900, Multicast 239.255.255.250). Empfang bindet 0.0.0.0:1900; Gruppen-Beitritt **pro Interface**: konkretes Interface → nur dieses + `setMulticastInterface` (NOTIFY-Egress gepinnt), Auto → **alle** routbaren IPv4 (Emulator-Familie/node-ssdp-Muster, damit Multi-Homed auf allen LANs gefunden wird). `onFatalError`-Callback meldet einen Socket-Tod zur Laufzeit an `main` (stoppt Announce, revidiert Zustand). ⚠️ `node-ssdp` taugt NICHT: hängt `::device` ans USN, ein echtes Roku sendet `uuid:roku:ecp:<uuid>` OHNE Suffix.
- **`ecp/ecp-http-server.ts`** — pro Gerät ein `node:http`-Server auf dem konfigurierten Port (Default 8060). Serviert UPnP-Description, `/query/device-info`, `/query/apps`; POST-Tasten → CommandEvent. **LAN-restringiert** (`isLanClient`), sauberes 404 (nicht das alte leere 200).
- **`ecp/device-info.ts`** — `SOFTWARE_VERSION` = **aktuelle Roku-Version** (der Pairing-Hebel — moderne Fernbedienungen prüfen sie), Modell „Roku Ultra". `DEFAULT_APPS` (Netflix/YouTube/Prime/Disney+).
- **`ecp/ecp-command.ts`** — reiner Parser: POST-URL → CommandEvent (keypress/keydown/keyup/launch/install/input/search).
- **`ecp/state-model.ts`** — `STANDARD_KEYS` (27 feste Tasten) + `commandToStateWrite`.
- **`main.ts`** — Lifecycle. `onReady` (async, top-level try/catch): **pro Gerät eigenes try/catch** (ein belegter Port kippt die anderen nicht), dann **isolierter** SSDP-Start (Fehler = „Discovery aus", kein Total-Abbruch). **`info.connection` = ECP-Bereitschaft** (≥1 Server lauscht), NICHT an SSDP gekoppelt; `onSsdpFatal` revidiert bei Laufzeit-Tod. keydown-Watchdog (`HOLD_MAX_MS`) gegen hängende Hold-Tasten. **`onUnload` synchron**.
- **`lib/`** — reine Helfer: `sanitizeId`, `normalizeKey`, `deriveUuid` (md5 → stabile UUID), `detectPrimaryIPv4`/`detectLocalIPv4s` (Advertise-IP + Membership-Interfaces), `constants.ts` (`DEFAULT_ECP_PORT`), `logger.ts` (`AdapterLogger` = geteilter Logger-Typ).

## Design-Entscheidungen (belegt, nicht wieder aufmachen)
- **Datenmodell:** `<gerät>.command` (string, role `text`) = letzter Befehl; `<gerät>.commandType`; feste `<gerät>.keys.<Key>` (boolean, role **`sensor`** — NICHT `button.press`: repochecker **E1010** lehnt es ab). Alle Tasten **vorab** angelegt (kein lazy-Wachstum wie der Alte). Tastatur-`Lit_` + App-Starts landen NUR in `command` (kein Pro-Zeichen-Objekt-Wildwuchs).
- **⚠️ Play≠Pause protokollbedingt UNGELÖST** — Harmony sendet für beide dieselbe `Play`-Taste (live belegt 2026-07-30).
- **⚠️ Apps über Harmony nicht steuerbar** — die Harmony-App-Tasten (Netflix …) senden NICHTS an den Adapter (aktivitäts-gebunden, kein lokaler ECP-`launch`). Der Parser KANN `launch:<id>` — nur Harmony liefert es nicht.
- **Port ist für die Funktion egal** — die Fernbedienung liest ihn aus der SSDP-Ankündigung. Default 8060 (echter Roku-Port, risikofrei). **Manuelles Feld** — Auto-Vergabe verworfen (krobi 2026-07-30).
- **Mehrere Rokus pro Instanz** (geteilter Port 1900), `singletonHost`.

- **Zweige:** Arbeit auf `developing`, Release auf `master` — die CI prüft seit 2026-08-23 BEIDE (`push.branches`). Vorher lief sie nur auf dem Release-Zweig, wodurch ein nur unter Windows roter Test erst am Release-Tag auffiel (yamaha v1.1.0 verbrannt). `deploy` hängt am Tag, aus einem Push auf `developing` wird also nie ein Release.

## Tests
- vitest, `src/**/*.test.ts` — Unit + Boot-Integrationstest (startet den Adapter real).

## Befehle
- `npm run build` · `npm test` · `npm run lint` · `npm run release`.

## Versionshistorie
- Changelog wird im README (`## Changelog`) + `CHANGELOG_OLD.md` + `io-package.json` `news` geführt, nicht hier dupliziert. **v0.5.0** = Greenfield-Neustart; die Vorgänger-Historie (Pmant 2017 → Community-Wartung bis 0.4.0) bleibt erhalten — s. README `## History`.
