# fakeroku — emulierte Roku-Geräte für deine Fernbedienung

Dieser Adapter lässt ioBroker im Heimnetz wie ein oder mehrere **Roku-Streaming-Geräte**
aussehen. Eine Fernbedienung oder Steuerung, die das Roku-Protokoll spricht — ein
Logitech-Harmony-Hub, eine Sofabaton X1/X2, die Roku-Integration von Home Assistant,
openHAB — findet das emulierte Gerät, und jeder Tastendruck darauf wird zu einem
Datenpunkt in ioBroker, auf den Skripte und Visualisierungen reagieren können.

Er ist das **Eingabe**-Gegenstück zum Logitech-Harmony-Adapter: Statt dass ioBroker
ein Gerät steuert, steuert ein Gerät den ioBroker.

> **Die offizielle Roku-App funktioniert mit diesem Adapter nicht.** Sie spricht mit
> echten Rokus über Rokus herstellereigenen, undokumentierten ECP-2-WebSocket-Kanal,
> den dieser Emulator nicht nachbildet. Nutze einen Harmony-Hub oder eine Sofabaton —
> die sprechen das offene Protokoll, das dieser Adapter bedient.

## Voraussetzungen

- Node.js 22 oder neuer
- js-controller 7.2.2 oder neuer
- admin 8.0.11 oder neuer
- Eine Fernbedienung bzw. ein Hub im **selben Heimnetz** wie der ioBroker-Rechner

## Einrichtung

### 1. Instanz anlegen

Adapter installieren und eine Instanz anlegen. Er läuft sofort: Die Instanz bringt
bereits einen emulierten Roku mit, Name „Roku", Anschluss 8060.

### 2. Netzwerkschnittstelle wählen (meistens: nicht)

Lass **Netzwerkschnittstelle** auf „alle Schnittstellen". Der Adapter bedient dann jedes
Netz, in dem dein ioBroker-Rechner hängt, und antwortet einer Fernbedienung in jedem davon
mit der Adresse des Rechners in genau diesem Netz — eine Fernbedienung in einem eigenen
VLAN bekommt die Adresse, die sie erreicht.

Eine bestimmte Adresse wählst du nur, wenn die emulierten Rokus **nur in einem Netz**
existieren sollen. Dann bleibt alles in diesem Netz: Beantwortet werden nur
Fernbedienungen daraus, in den anderen Netzen wird nichts angeboten. Gibt es die Adresse
beim Start der Instanz auf dem Rechner nicht, wartet der Adapter bis zu zwei Minuten
darauf (ein Netz, das erst nach ioBroker hochkommt), meldet es dann im Protokoll und
startet nichts — er weicht nie auf ein anderes Netz aus.

### 3. Emulierte Rokus anlegen oder ändern

Jede Karte unter **Emulierte Roku-Geräte** ist ein Roku, den deine Fernbedienung
finden kann.

- **Name** — der Name des Geräts in ioBroker und in der Geräteauskunft des emulierten
  Roku. Ob eine Fernbedienung ihn anzeigt, hängt von der Fernbedienung ab: Eine Harmony
  benennt das Gerät selbst. Nimm etwas Wiedererkennbares, zum Beispiel den Raum.
  **Eine Karte später umzubenennen behält ihre Datenpunkte** — der Ordner im Objektbaum,
  seine Raum- und Funktionszuordnung und seine Aufzeichnungs-Einstellungen bleiben, wo sie
  sind; nur der angezeigte Name ändert sich.
- **ECP-Port** — der Netzwerk-Port, auf dem dieser Roku antwortet. `8060`
  ist der Port eines echten Roku. Jeder emulierte Roku braucht **seinen eigenen**;
  der Dialog schlägt einen freien vor und lässt einen bereits belegten nicht bestätigen.
  Eine Harmony oder Sofabaton liest den Port aus der Erkennung; **Home Assistant und
  Homey nutzen immer 8060** — gib 8060 dem Roku, den sie steuern sollen.
- **Typ**
  - **Player** (eine Streaming-Box) bietet die 16 üblichen Navigations- und
    Wiedergabetasten.
  - **TV** bietet zusätzlich Lautstärke-, Ein/Aus-, Kanal- und Eingangstasten
    (`VolumeUp`, `PowerOn`, `PowerOff`, `Power`, `Sleep`, `ChannelUp`, `InputTuner`,
    `InputHDMI1` …). Wähle das nur, wenn du diese zusätzlichen Tasten wirklich als
    Auslöser in ioBroker haben willst.

### 4. Fernbedienung anlernen

**Logitech Harmony:** In der Harmony-App ein Gerät hinzufügen, als Hersteller
**Roku** wählen und auf deinen ioBroker-Rechner zeigen. Der Hub findet den emulierten
Roku von selbst und liest den Anschluss aus der Ankündigung — du musst ihn nicht
eintippen.

**Sofabaton X1/X2:** In der Sofabaton-App ein Roku-Gerät hinzufügen, während die App
im selben Netz ist; sie findet den emulierten Roku über die Erkennung.

**Home Assistant:** Die Roku-Integration hinzufügen — sie findet den emulierten Roku,
oder du gibst den ioBroker-Rechner an. Home Assistant spricht immer Port 8060 an (siehe
oben).

## Was im Objektbaum entsteht

Auf Instanz-Ebene:

| Datenpunkt        | Typ                 | Bedeutung                                                                                                                                                                                                                                                 |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info.connection` | boolean, nur lesbar | Nur wahr, solange **jeder** konfigurierte Roku tatsächlich lauscht. Kann einer nicht starten — fast immer, weil sein Port schon belegt ist —, nennt das Protokoll Gerät und Port, und der Adapter versucht dieses Gerät jede Minute erneut, bis es läuft. |

Je emuliertem Roku, unterhalb von `fakeroku.0.<Name>`:

| Datenpunkt     | Typ                 | Bedeutung                                                                                                                                                |
| -------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`      | string, nur lesbar  | Der letzte Befehl als lesbarer Text: `Home`, `Lit_a`, `launch:12`, `search:news`.                                                                        |
| `commandType`  | string, nur lesbar  | Um welche Art Befehl es sich handelte: `keypress`, `keydown`, `keyup`, `launch`, `install`, `input` oder `search`.                                       |
| `keys.<Taste>` | boolean, nur lesbar | Ein Datenpunkt je Taste. Ein Tastendruck setzt ihn kurz auf `true` und wieder auf `false`; eine gehaltene Taste bleibt `true`, bis sie losgelassen wird. |

Tastatureingaben der Fernbedienung (`Lit_a`) und App-Starts erscheinen nur in
`command` — sie bekommen keine eigenen Datenpunkte. Die App-Taste einer Fernbedienung,
die App-Starts sendet (eine Sofabaton, Home Assistant), kommt als `launch:<id>` an, mit
ihren Parametern, falls sie welche trägt (`launch:12?contentId=…`). Tastennamen werden in
jeder Schreibweise erkannt: `home` und `HOME` sind die Taste `Home`.

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
danach also nicht blockieren. Das Loslassen einer Taste, die du tatsächlich hältst, wird
nie verworfen — auch dann nicht, wenn der Adapter gerade eine Befehlsflut abweist; sonst
wäre die Flutbremse das, was eine Taste hängen lässt.

## Genutzte Anschlüsse

- **TCP 8060** (einer je emuliertem Roku, einstellbar) — das Steuerprotokoll. Hierhin
  sendet deine Fernbedienung ihre Tastendrücke.
- **UDP 1900** (Multicast) — die Geräteerkennung, damit die Fernbedienung die
  emulierten Rokus findet. Dieser Anschluss ist vom Standard vorgegeben und wird von
  allen gemeinsam genutzt.

Beantwortet werden nur Geräte aus einem der eigenen Netze des ioBroker-Rechners — mit
gewählter Netzwerkschnittstelle nur aus deren Netz. Eine Anfrage von anderswo (Internet,
anderes VLAN, VPN) wird abgewiesen, eine Suche von dort ignoriert.

Beim Stoppen der Instanz melden sich die emulierten Rokus im Netz ab. Eine Steuerung,
die ihre Geräteliste aus der Erkennung führt, nimmt sie damit heraus, statt sie bis zu
einer Stunde zu behalten; eine Harmony, die ein gekoppeltes Gerät selbst behält,
betrifft das nicht.

Du kannst mehrere Instanzen auf demselben Rechner betreiben — gib jeder eigene
ECP-Ports. UDP 1900 teilen sie sich: Der Adapter öffnet den Anschluss mit
Adress-Wiederverwendung, jede Instanz empfängt die Suchanfragen also und antwortet für
ihre eigenen Geräte. Nur wenn ein anderes Programm den Anschluss exklusiv hält, startet
eine Instanz ohne Geräteerkennung — das steht dann im Protokoll, und bereits gekoppelte
Fernbedienungen kommen weiterhin durch.

Der Adapter läuft außerdem im Compact-Modus von ioBroker, in dem sich mehrere Adapter
einen Prozess teilen, statt dass jeder einen eigenen startet. Auf kleinen Rechnern
spart das Speicher und Startzeit. Eingeschaltet wird er in den Instanz-Einstellungen;
hier ist dafür nichts umzustellen.

## Fehlersuche

**Die Fernbedienung findet kein Gerät.**
Prüfe, ob Hub und ioBroker-Rechner im selben Netz sind und keine Firewall den
UDP-Anschluss 1900 blockiert. Bei einem Rechner mit mehreren Netzwerkkarten die
richtige unter **Netzwerkschnittstelle** auswählen. Ist die Erkennung nicht verfügbar,
schreibt der Adapter das ins Protokoll und arbeitet für bereits gekoppelte
Fernbedienungen weiter.

**Die Fernbedienung findet nichts, und ioBroker läuft in Docker.**
Im Standard-Bridge-Netz von Docker hat der Container nur eine interne Adresse, die keine
Fernbedienung erreicht, und Suchanfragen aus deinem Heimnetz kommen nie an. Starte den
ioBroker-Container mit `network_mode: host` oder gib ihm über ein `macvlan`-Netz eine
Adresse im Heimnetz. Brücken von Docker, libvirt, VirtualBox und WSL auf dem Rechner
selbst erkennt der Adapter und kündigt sie nicht an.

**Im Protokoll steht „The network interface address … does not exist on this host".**
Die in den Einstellungen gewählte Adresse gibt es auf dem Rechner nicht mehr — neue
Netzwerkkarte, geänderte DHCP-Adresse, eine Sicherung auf anderer Hardware
zurückgespielt. Wähle die aktuelle Schnittstelle (oder „alle Schnittstellen") und
speichere; die Instanz startet neu.

**Home Assistant erreicht einen von mehreren emulierten Rokus nicht.**
Home Assistant nutzt immer Port 8060. Gib 8060 dem emulierten Roku, den es steuern soll.

**Die Instanz bleibt „nicht verbunden".**
Mindestens ein konfigurierter Roku konnte nicht starten. Das Protokoll nennt Gerät
und Anschluss — fast immer ist der Anschluss schon von etwas anderem belegt (auch von
einem zweiten emulierten Roku mit demselben Anschluss). Gib ihm einen freien.
Der Adapter versucht es bei so einem Gerät jede Minute erneut und meldet im Protokoll,
wenn es hochkommt — ein Anschluss, den der vorherige Prozess nach einem Neustart noch
hielt, löst sich damit von allein.

**Ich drücke eine Taste und in ioBroker passiert nichts.**
Stelle die Protokollstufe der Instanz kurz auf `debug`. Jeder _angewendete_ Befehl wird
mit Absenderadresse protokolliert, bei einer Taste mit ihrem Namen (bei `launch`,
`input` und `search` steht stattdessen das Gestartete bzw. Getippte da). Erscheint die
Zeile, ist der Befehl angekommen und das Problem liegt im Skript, das den Datenpunkt
liest.

Erscheint nichts, suche zuerst nach einer Warnung über mehr als 25 Befehle pro Sekunde:
Befehle, die diese Bremse verwirft, werden nicht einzeln protokolliert — eine zu
gesprächige Fernbedienung sieht also genauso aus wie eine, die den Adapter gar nicht
erreicht. Ohne so eine Warnung kommt die Fernbedienung wirklich nicht durch: Netz und
ECP-Port prüfen.

**Wiedergabe und Pause tun dasselbe.**
Das ist das Roku-Protokoll, nicht der Adapter: Die Fernbedienung sendet für
Wiedergabe und Pause **denselben** Befehl, die beiden sind hier also nicht
unterscheidbar.

**Die App-Tasten meiner Harmony bewirken nichts.**
Ein Harmony-Hub hat seine App-Tasten (Netflix, YouTube …) nicht an den emulierten Roku
gesendet — sie hängen an Harmony-Aktivitäten, der Adapter sieht sie also nie.
Fernbedienungen, die App-Starts senden (eine Sofabaton, Home Assistant), zeigen sie in
`command` als `launch:<id>`.

## Datenschutz

Der Adapter spricht ausschließlich mit Geräten in deinen eigenen Netzen. Er kontaktiert keinen
Cloud-Dienst und sendet nirgendwohin Daten. Die optionale Fehlerberichterstattung
über Sentry ist aus, solange du in den ioBroker-Systemeinstellungen die Diagnose
nicht eingeschaltet hast; sie überträgt eine anonyme Installations-Kennung und den
Fehler selbst, keine personenbezogenen Daten.
