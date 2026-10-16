# Apple MCP Server (Kalender · Notizen · Erinnerungen · Mail)

Ein lokaler [MCP](https://modelcontextprotocol.io)-Server, der KI-Assistenten wie Claude Desktop Zugriff auf die
macOS-Apps **Kalender**, **Notizen**, **Erinnerungen** und **Mail** gibt.

Der Server läuft komplett lokal auf dem Mac. Er steuert die Apps über **JavaScript for Automation (JXA)**
(`osascript -l JavaScript`) – es gibt keinen Cloud-Dienst, keine API-Schlüssel und keine zusätzliche Anmeldung.

---

## Inhalt

1. [Wie es funktioniert](#wie-es-funktioniert)
2. [Voraussetzungen](#voraussetzungen)
3. [Installation](#installation)
4. [In Claude Desktop einbinden](#in-claude-desktop-einbinden)
5. [macOS-Berechtigungen](#macos-berechtigungen)
6. [Konfiguration](#konfiguration)
7. [Verfügbare Tools](#verfügbare-tools)
8. [Testen ohne Claude](#testen-ohne-claude)
9. [Bekannte Einschränkungen](#bekannte-einschränkungen)
10. [Fehlerbehebung](#fehlerbehebung)
11. [Projektstruktur & eigene Tools ergänzen](#projektstruktur--eigene-tools-ergänzen)

---

## Wie es funktioniert

```
Claude Desktop  ──stdio──▶  dieser MCP-Server (Node.js)  ──osascript/JXA──▶  Kalender / Notizen / Erinnerungen / Mail
```

- Claude Desktop startet den Server als Kindprozess und spricht mit ihm über **stdio**.
- Jedes Tool baut ein kleines JXA-Skript, führt es mit `osascript` aus und bekommt das Ergebnis als JSON zurück.
- Parameter werden über `JSON.stringify` sicher ins Skript eingebettet (kein String-Zusammenbasteln von Benutzereingaben).
- Große Antworten werden auf 25.000 Zeichen gekürzt, damit ein einzelner Aufruf nicht den Kontext sprengt.

## Voraussetzungen

| Was | Version / Hinweis |
|---|---|
| macOS | 13 (Ventura) oder neuer empfohlen. **Läuft nur auf macOS.** |
| Node.js | 18 oder neuer (`node --version`). Installation z. B. per `brew install node` |
| Claude Desktop | aktuelle Version für Mac |
| Freier Speicherplatz | ein paar hundert MB für `node_modules` |

## Installation

> **Tipp:** Lege den Ordner direkt in dein Home-Verzeichnis (z. B. `~/mcp-apple`) und **nicht** in
> Schreibtisch, Dokumente oder Downloads. Diese Ordner werden oft per iCloud synchronisiert und Dateien können
> „ausgelagert" sein – das führt beim Bauen zu seltsamen Fehlern (`ETIMEDOUT`, `uv_cwd`, fehlende Dateien).

```bash
cd ~
git clone https://github.com/roYan167/MCP-Apple-.git mcp-apple
cd mcp-apple
npm install
npm run build
```

Nach dem Build muss es den Ordner `dist/` mit `dist/index.js` geben:

```bash
ls dist
# constants.js  index.js  services  tools  types.js
```

Den absoluten Pfad zu dieser Datei brauchst du im nächsten Schritt:

```bash
echo "$(pwd)/dist/index.js"
```

## In Claude Desktop einbinden

1. Claude Desktop öffnen → **Einstellungen → Entwickler → Konfiguration bearbeiten**.
   Das öffnet `~/Library/Application Support/Claude/claude_desktop_config.json`.
2. In der Datei einen Eintrag unter `mcpServers` hinzufügen.
   **Wichtig:** Die Datei enthält meist schon andere Einstellungen – diese **nicht löschen**, sondern
   `mcpServers` als zusätzlichen Schlüssel auf oberster Ebene ergänzen (Kommas beachten):

```json
{
  "...": "bestehende Einstellungen bleiben unverändert",
  "mcpServers": {
    "apple-productivity": {
      "command": "node",
      "args": ["/ABSOLUTER/PFAD/ZU/mcp-apple/dist/index.js"]
    }
  }
}
```

3. Claude Desktop **komplett beenden** (⌘Q, nicht nur das Fenster schließen) und neu öffnen.
4. Unter **Einstellungen → Entwickler** sollte `apple-productivity` jetzt mit Status **„Läuft"** erscheinen.

> Wenn `node` nicht gefunden wird (Claude Desktop kennt nicht immer deinen Shell-`PATH`), trage bei
> `command` den vollen Pfad ein, z. B. das Ergebnis von `which node` (`/opt/homebrew/bin/node`).

## macOS-Berechtigungen

Beim ersten Zugriff auf eine App fragt macOS: *„Claude" möchte „Kalender" steuern.* → **Erlauben.**
Das passiert einmal pro App (Kalender, Notizen, Erinnerungen, Mail).

Falls kein Dialog kommt oder ein Aufruf nach 20–45 Sekunden mit Timeout abbricht:
**Systemeinstellungen → Datenschutz & Sicherheit → Automatisierung** → bei „Claude" die Häkchen für
Kalender, Notizen, Erinnerungen und Mail setzen. Ggf. zusätzlich unter **Kalender** bzw. **Erinnerungen**
(gleicher Bereich) Vollzugriff erlauben.

## Konfiguration

Optional über Umgebungsvariablen im `env`-Block der Claude-Desktop-Konfiguration:

| Variable | Bedeutung | Standard |
|---|---|---|
| `APPLE_MCP_DEFAULT_CALENDARS` | Kommagetrennte, exakte Kalendernamen, die `calendar_list_events` standardmäßig durchsucht. Sinnvoll, wenn es sehr große Kalender gibt (z. B. abonnierte oder importierte), die Abfragen stark verlangsamen. Andere Kalender bleiben über `calendar_name` oder `all_calendars: true` erreichbar. | leer = alle Kalender |

Beispiel:

```json
"apple-productivity": {
  "command": "node",
  "args": ["/ABSOLUTER/PFAD/ZU/mcp-apple/dist/index.js"],
  "env": {
    "APPLE_MCP_DEFAULT_CALENDARS": "Zuhause,Arbeit"
  }
}
```

Die exakten Namen deiner Kalender liefert das Tool `calendar_list_calendars`.

## Verfügbare Tools

### Kalender
| Tool | Zweck | Schreibend? |
|---|---|---|
| `calendar_list_calendars` | Alle Kalender mit Namen und Beschreibbarkeit | – |
| `calendar_list_events` | Termine in einem Zeitraum, optional nach Kalender/Titel gefiltert; **Serientermine werden aufgelöst** (jedes Vorkommen im Zeitraum wird einzeln geliefert) | – |
| `calendar_create_event` | Termin anlegen | ✏️ |
| `calendar_update_event` | Felder eines Termins ändern | ✏️ |
| `calendar_delete_event` | Termin löschen (endgültig) | 🗑️ |

### Notizen
| Tool | Zweck | Schreibend? |
|---|---|---|
| `notes_list_folders` | Alle Ordner | – |
| `notes_list_notes` | Notizen auflisten/durchsuchen (Titel + Text) | – |
| `notes_get_note` | Vollständigen Text einer Notiz lesen | – |
| `notes_create_note` | Notiz anlegen (erste Zeile = Titel) | ✏️ |
| `notes_update_note` | Notiztext komplett ersetzen | ✏️ |
| `notes_delete_note` | Notiz löschen | 🗑️ |

### Erinnerungen
| Tool | Zweck | Schreibend? |
|---|---|---|
| `reminders_list_lists` | Alle Listen | – |
| `reminders_list_reminders` | Erinnerungen filtern (Liste, erledigt, Fälligkeit, Text) | – |
| `reminders_create_reminder` | Erinnerung anlegen (mit Fälligkeit/Priorität) | ✏️ |
| `reminders_update_reminder` | Felder ändern | ✏️ |
| `reminders_complete_reminder` | Als erledigt/unerledigt markieren | ✏️ |
| `reminders_delete_reminder` | Erinnerung löschen | 🗑️ |

### Mail
| Tool | Zweck | Schreibend? |
|---|---|---|
| `mail_list_accounts` | Alle Mail-Konten | – |
| `mail_list_mailboxes` | Postfächer mit Anzahl ungelesener Mails | – |
| `mail_list_messages` | Neueste Mails eines Postfachs, filterbar (ungelesen, Betreff/Absender) | – |
| `mail_get_message` | Vollständigen Inhalt einer Mail lesen | – |
| `mail_mark_read` | Als gelesen/ungelesen markieren | ✏️ |
| `mail_flag_message` | Markierung (Flag) setzen/entfernen | ✏️ |
| `mail_delete_message` | In den Papierkorb verschieben | 🗑️ |
| `mail_create_draft` | Entwurf im Mail-Fenster öffnen, **ohne** zu senden (empfohlen) | ✏️ |
| `mail_send_message` | Mail **sofort** senden – kein Rückgängig | ⚠️ |

Jedes Tool trägt MCP-Annotationen (`readOnlyHint`, `destructiveHint`, …), sodass Claude Desktop vor
schreibenden oder löschenden Aktionen um Bestätigung bitten kann.

**Beispiel-Prompts in Claude:**
- „Was steht diese Woche in meinem Kalender?"
- „Leg mir morgen um 18 Uhr einen Termin ‚Training' an."
- „Welche Erinnerungen sind heute fällig?"
- „Zeig mir meine ungelesenen Mails und fass sie zusammen."
- „Erstelle einen Entwurf an … mit dem Betreff …" (wird nicht gesendet, nur geöffnet)

## Testen ohne Claude

Mit dem MCP Inspector lassen sich einzelne Tools isoliert aufrufen:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Das öffnet eine Weboberfläche. Empfohlen: zuerst nur lesende Tools testen (`*_list_*`), dann schreibende.

Die Auflösung von Serienterminen (`src/services/recurrence.ts`) hat automatische Tests, die ohne macOS laufen:

```bash
npm test
```

## Bekannte Einschränkungen

- **Nur macOS.** Auf anderen Systemen beendet sich der Server sofort mit einer Meldung.
- **Kalender:** Gefiltert wird nach der *Startzeit*. Ein mehrtägiger Termin, der vor `start_date` beginnt,
  wird nicht gefunden – dann `start_date` früher wählen. Sehr große Kalender sind langsam
  (Calendar.app braucht ca. 5 ms pro Termin) → siehe `APPLE_MCP_DEFAULT_CALENDARS`.
- **Serientermine:** Calendar.app liefert per Skript nur den *ersten* Termin einer Serie. Der Server wertet deshalb
  die Wiederholungsregel (RRULE) selbst aus – unterstützt werden täglich, wöchentlich, monatlich und jährlich
  inkl. `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` (auch „2. Dienstag“ / „letzter Freitag“), `BYMONTHDAY`, `BYMONTH`,
  `BYSETPOS` sowie gelöschte Einzeltermine einer Serie. Nicht unterstützte Regeln (z. B. stündlich) werden als
  „Warnings“ in der Antwort gemeldet. Einzeln verschobene Vorkommen einer Serie können doppelt oder an der
  alten Stelle erscheinen. `calendar_update_event` / `calendar_delete_event` wirken immer auf die **ganze Serie**.
- **Notizen:** Es gibt kein separates Titelfeld; der Titel ist die erste Zeile. `notes_update_note` ersetzt den
  gesamten Text. Formatierungen (fett, Listen, Bilder) gehen beim Schreiben verloren, Text wird als einfache
  Absätze gespeichert.
- **Mail:** Die Suche prüft nur **Betreff und Absender**, nicht den Inhalt. Aus Geschwindigkeitsgründen werden
  nur die neuesten `scan_limit` Nachrichten durchsucht (Standard 300 bei Listen, 1000 bei Einzelabruf) –
  bei älteren Mails den Wert erhöhen. Mails ohne Netz landen beim Senden ggf. im Postausgang.
- **Löschen** von Terminen, Notizen und Erinnerungen ist über die Tools nicht rückgängig zu machen.

## Fehlerbehebung

| Symptom | Ursache / Lösung |
|---|---|
| `npm error ENOENT … package.json` | Du bist nicht im Projektordner → `cd ~/mcp-apple` |
| `ETIMEDOUT`, `uv_cwd`, Dateien mit Wolken-Symbol | Ordner liegt in iCloud-synchronisiertem Bereich → nach `~` verschieben |
| `ENOSPC` / `no space left on device` | Festplatte voll → Platz schaffen (`df -h /`), dann `rm -rf node_modules && npm install` |
| `tsc: command not found` | `node_modules` unvollständig → `rm -rf node_modules package-lock.json && npm install` |
| Server erscheint nicht in Claude Desktop | JSON-Syntax prüfen (z. B. mit `python3 -m json.tool < claude_desktop_config.json`), Pfad zu `dist/index.js` prüfen, Claude mit ⌘Q komplett neu starten |
| `Not authorized to send Apple events` | Automatisierungs-Berechtigung fehlt → siehe [macOS-Berechtigungen](#macos-berechtigungen) |
| Timeout nach 20–45 s | Berechtigungsdialog wartet unbemerkt, oder sehr großer Kalender/Postfach → Zeitraum/Kalender/`scan_limit` eingrenzen |
| Server-Logs ansehen | Einstellungen → Entwickler → Server auswählen → „Protokolle anzeigen" |

## Projektstruktur & eigene Tools ergänzen

```
.
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts            # Einstiegspunkt: registriert alle Tools, startet stdio-Transport
    ├── constants.ts        # Zeichenlimit, Standard-/Maximal-Limits
    ├── types.ts            # gemeinsame TypeScript-Typen
    ├── services/
    │   └── jxa.ts          # führt JXA über osascript aus, parst JSON, verständliche Fehlermeldungen
    └── tools/
        ├── calendar.ts     # 5 Kalender-Tools
        ├── notes.ts        # 6 Notizen-Tools
        ├── reminders.ts    # 6 Erinnerungen-Tools
        └── mail.ts         # 9 Mail-Tools
```

**Neues Tool hinzufügen** – jedes Tool folgt demselben Muster:

1. Eingabe-Schema mit **Zod** definieren (`z.object({...}).strict()`).
2. `server.registerTool("app_aktion", { title, description, inputSchema, annotations }, handler)` aufrufen.
3. Im Handler ein JXA-Skript als Template-String bauen. Parameter **immer** über `toJXALiteral(params)`
   einbetten, nie direkt in den String einsetzen.
4. Das Skript endet mit `JSON.stringify(ergebnis)`; ausführen mit `runJXAJson<Typ>(script, timeoutMs)`.
5. `npm run build`, Claude Desktop neu starten.

Nützlich zum Erkunden, welche Eigenschaften eine App per Skript anbietet: **Skripteditor.app → Ablage →
Funktionsverzeichnis öffnen** und die gewünschte App wählen (Sprache oben auf „JavaScript" stellen).

**Befehle:**

| Befehl | Zweck |
|---|---|
| `npm run build` | TypeScript nach `dist/` kompilieren |
| `npm run dev` | Kompilieren im Watch-Modus |
| `npm start` | Server direkt starten (wartet auf stdio – normalerweise startet Claude Desktop ihn) |

## Lizenz

Privates Projekt, ohne Gewähr. Nutzung auf eigenes Risiko – insbesondere die schreibenden und löschenden Tools.
