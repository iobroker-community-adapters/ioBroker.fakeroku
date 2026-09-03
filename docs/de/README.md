# fakeroku — emulierte Roku-Geräte für deine Fernbedienung

Dieser Adapter lässt ioBroker im Heimnetz wie ein oder mehrere **Roku-Streaming-Geräte**
aussehen. Eine Fernbedienung, die das Roku-Protokoll spricht — ein Logitech-Harmony-Hub
oder eine Sofabaton X1/X2 — findet das emulierte Gerät, und jeder Tastendruck darauf
wird zu einem Datenpunkt in ioBroker, auf den Skripte und Visualisierungen reagieren
können.

Er ist das **Eingabe**-Gegenstück zum Logitech-Harmony-Adapter: Statt dass ioBroker
ein Gerät steuert, steuert ein Gerät den ioBroker.

> **Die offizielle Roku-App funktioniert mit diesem Adapter nicht.** Sie spricht mit
> echten Rokus über einen herstellereigenen, verschlüsselten Kanal, der sich nicht
> nachbauen lässt. Nutze einen Harmony-Hub oder eine Sofabaton — die sprechen das
> offene Protokoll, das dieser Adapter bedient.

## Voraussetzungen

- Node.js 22 oder neuer
- js-controller 7.2.2 oder neuer
- admin 8.0.11 oder neuer
- Eine Fernbedienung bzw. ein Hub im **selben Heimnetz** wie der ioBroker-Rechner

## Einrichtung

### 1. Instanz anlegen

Adapter installieren und eine Instanz anlegen. Er läuft sofort: Die Instanz bringt
bereits einen emulierten Roku mit, Name „Roku", Anschluss 8060.

### 2. Netzwerkkarte wählen (meistens: nicht)

Lass **Netzwerkkarte** auf „alle Schnittstellen". Der Adapter ermittelt dann selbst
die erreichbare Adresse deines ioBroker-Rechners und kündigt diese an.

Eine bestimmte Adresse wählst du nur, wenn dein ioBroker-Rechner in **mehreren
Netzen** hängt und die Fernbedienung nur eines davon erreicht.

### 3. Emulierte Rokus anlegen oder ändern

Jede Karte unter **Emulierte Roku-Geräte** ist ein Roku, den deine Fernbedienung
finden kann.

- **Name** — erscheint als Gerätename auf der Fernbedienung und als Ordner im
  Objektbaum. Nimm etwas Wiedererkennbares, zum Beispiel den Raum.
- **ECP-Anschluss** — der Netzwerk-Anschluss, auf dem dieser Roku antwortet. `8060`
  ist der Anschluss eines echten Roku. Jeder emulierte Roku braucht **seinen eigenen**;
  der Dialog schlägt einen freien vor und weist einen bereits belegten ab.
- **Typ**
  - **Player** (eine Streaming-Box) bietet die 16 üblichen Navigations- und
    Wiedergabetasten.
  - **TV** bietet zusätzlich Lautstärke, Ein/Aus, Programm und Eingangswahl. Wähle
    das nur, wenn du diese zusätzlichen Tasten wirklich als Auslöser in ioBroker
    haben willst.

### 4. Fernbedienung anlernen

**Logitech Harmony:** In der Harmony-App ein Gerät hinzufügen, als Hersteller
**Roku** wählen und auf deinen ioBroker-Rechner zeigen. Der Hub findet den emulierten
Roku von selbst und liest den Anschluss aus der Ankündigung — du musst ihn nicht
eintippen.

**Sofabaton X1/X2:** In der Sofabaton-App ein Roku-Gerät hinzufügen, während die App
im selben Netz ist. Der Adapter meldet eine aktuelle Roku-Version — genau das prüfen
diese Fernbedienungen, bevor sie ein Gerät annehmen.

## Was im Objektbaum entsteht

Auf Instanz-Ebene:

| Datenpunkt | Typ | Bedeutung |
|---|---|---|
| `info.connection` | boolean, nur lesbar | Nur wahr, solange **jeder** konfigurierte Roku tatsächlich lauscht. Kann einer nicht starten — fast immer, weil sein Anschluss schon belegt ist — bleibt die Instanz getrennt, und das Protokoll nennt Gerät und Anschluss. |

Je emuliertem Roku, unterhalb von `fakeroku.0.<Name>`:

| Datenpunkt | Typ | Bedeutung |
|---|---|---|
| `command` | string, nur lesbar | Der letzte Befehl als lesbarer Text: `Home`, `Lit_a`, `launch:12`, `search:news`. |
| `commandType` | string, nur lesbar | Um welche Art Befehl es sich handelte: `keypress`, `keydown`, `keyup`, `launch`, `install`, `input` oder `search`. |
| `keys.<Taste>` | boolean, nur lesbar | Ein Datenpunkt je Taste. Ein Tastendruck setzt ihn kurz auf `true` und wieder auf `false`; eine gehaltene Taste bleibt `true`, bis sie losgelassen wird. |

Tastatureingaben der Fernbedienung (`Lit_a`) und App-Starts erscheinen nur in
`command` — sie bekommen keine eigenen Datenpunkte.

## Verwendung im Skript

Der übliche Weg ist, auf eine Taste zu reagieren, die `true` wird:

```javascript
on({ id: "fakeroku.0.Wohnzimmer.keys.Play", val: true }, () => {
    // deine Aktion
});
```

Oder `command` beobachten, wenn du mehrere Tasten an einer Stelle behandeln willst:

```javascript
on({ id: "fakeroku.0.Wohnzimmer.command" }, obj => {
    log("Fernbedienung sendete: " + obj.state.val);
});
```

Die Tasten-Datenpunkte werden bei jedem Adapterstart auf `false` zurückgesetzt. Eine
Taste, die beim Stoppen von ioBroker gedrückt stehen geblieben ist, kann deine Regel
danach also nicht blockieren.

## Genutzte Anschlüsse

- **TCP 8060** (einer je emuliertem Roku, einstellbar) — das Steuerprotokoll. Hierhin
  sendet deine Fernbedienung ihre Tastendrücke.
- **UDP 1900** (Multicast) — die Geräteerkennung, damit die Fernbedienung die
  emulierten Rokus findet. Dieser Anschluss ist vom Standard vorgegeben und wird von
  allen gemeinsam genutzt.

Beantwortet werden nur Geräte aus deinem eigenen Heimnetz. Eine Anfrage aus dem
Internet wird abgewiesen, eine Suche von außen ignoriert.

## Fehlersuche

**Die Fernbedienung findet kein Gerät.**
Prüfe, ob Hub und ioBroker-Rechner im selben Netz sind und keine Firewall den
UDP-Anschluss 1900 blockiert. Bei einem Rechner mit mehreren Netzwerkkarten die
richtige unter **Netzwerkkarte** auswählen. Ist die Erkennung nicht verfügbar,
schreibt der Adapter das ins Protokoll und arbeitet für bereits gekoppelte
Fernbedienungen weiter.

**Die Instanz bleibt „nicht verbunden".**
Mindestens ein konfigurierter Roku konnte nicht starten. Das Protokoll nennt Gerät
und Anschluss — fast immer ist der Anschluss schon von etwas anderem belegt (auch von
einem zweiten emulierten Roku mit demselben Anschluss). Gib ihm einen freien.

**Ich drücke eine Taste und in ioBroker passiert nichts.**
Stelle die Protokollstufe der Instanz kurz auf `debug`. Jeder empfangene Befehl wird
mit Tastenname und Absenderadresse protokolliert. Erscheint nichts, erreicht die
Fernbedienung den Adapter nicht; erscheint etwas, ist der Befehl angekommen und das
Problem liegt im Skript, das den Datenpunkt liest.

**Wiedergabe und Pause tun dasselbe.**
Das ist das Roku-Protokoll, nicht der Adapter: Die Fernbedienung sendet für
Wiedergabe und Pause **denselben** Befehl, die beiden sind hier also nicht
unterscheidbar.

**Die App-Tasten meiner Harmony bewirken nichts.**
Die App-Tasten der Harmony (Netflix, YouTube …) hängen an Harmony-Aktivitäten und
werden nie an das Gerät gesendet — der Adapter sieht sie also nie.

## Datenschutz

Der Adapter spricht ausschließlich mit Geräten im Heimnetz. Er kontaktiert keinen
Cloud-Dienst und sendet nirgendwohin Daten. Die optionale Fehlerberichterstattung
über Sentry ist aus, solange du in den ioBroker-Systemeinstellungen die Diagnose
nicht eingeschaltet hast; sie überträgt eine anonyme Installations-Kennung und den
Fehler selbst, keine personenbezogenen Daten.
