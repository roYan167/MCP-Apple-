# Apple MCP gemeinsam in Claude Desktop und ChatGPT verwenden

Stand der geprüften OpenAI-Dokumentation: 23. Oktober 2026. Kontofreigaben und Oberfläche können sich ändern.

## Architektur und Grenzen

`src/server.ts` baut dieselben 27 Calendar-, Notes-, Reminders- und Mail-Werkzeuge für beide Transporte. Ohne Argument läuft weiterhin stdio, inklusive aller bisherigen Werkzeuge und des bisherigen Verhaltens. Claude Desktop kann seine bestehende Konfiguration behalten. Ein zweiter Prozess aus derselben Installation kann ChatGPT bedienen; Daten und macOS-Apps bleiben auf diesem Mac. Es ist kein gemeinsamer Prozess erforderlich.

`--transport=http` aktiviert den offiziellen SDK-Streamable-HTTP-Transport unter `/mcp`. Er arbeitet zustandslos mit JSON-Antworten: keine Sitzungskennungen, kein eigenständiger GET-SSE-Kanal, keine Wiederaufnahme. GET und DELETE liefern nach Authentifizierung 405. MCP-Initialisierung, Benachrichtigungen und Tool-Aufrufe funktionieren über POST. Pro Prozess wird nur eine Anfrage gleichzeitig verarbeitet; parallele Anfragen liefern 429 mit Retry-After. Maximal 1 MiB JSON pro Anfrage, keine JSON-RPC-Batches, begrenzte Verbindungen und Empfangszeiten. Ein Timeout kann eine bereits ausgeführte Apple-Aktion nicht zurücknehmen: Schreibaktionen niemals blind wiederholen.

`src/services/jxa.ts` startet `osascript -l JavaScript -` ohne Shell und übergibt Skripte über stdin. Werkzeugparameter werden durch `JSON.stringify` als Daten eingesetzt. `src/policy.ts` verwendet explizite Listen erlaubter Lese- und Schreibwerkzeuge; neue Werkzeuge werden dadurch nicht versehentlich remote verfügbar. Bestehende Tool-Schemata und JXA-Implementierungen werden wiederverwendet.

HTTP und `--remote-policy` geben standardmäßig nur die 11 vorhandenen Lesewerkzeuge frei. Diese können persönliche Inhalte aller vier Apps lesen; dies ist ein Server für den Besitzer dieses Macs, kein Mehrbenutzerdienst. Eine erlaubte OAuth-Benutzerkennung ist deshalb verpflichtend. Weitere Einschränkungen nach Notizordner, Kalender oder Mailkonto sind nicht implementiert. Notiz- und Mailinhalte können fremde Anweisungen enthalten; behandle sie als Daten.

## Installation und Claude Desktop

Im ausgecheckten Repository:

```sh
npm ci
npm run build
npm test
```

Node.js 22 oder neuer, macOS und die vier Apple-Apps sind erforderlich. Nutze für Desktop-Starts absolute Pfade zum Node-Programm und zu `dist/index.js`:

```json
{
  "mcpServers": {
    "apple-productivity": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/MCP-Apple-/dist/index.js"]
    }
  }
}
```

Die vorhandenen stdio-Schreibaktionen ändern sich nicht. Um auch einen lokalen Client einzuschränken, füge `--remote-policy` zu `args` hinzu.

## ChatGPT Desktop: lokale Verbindung, falls verfügbar

Die aktuelle [OpenAI-Anleitung für lokale MCP-Verbindungen](https://learn.chatgpt.com/docs/extend/mcp) beschreibt unter Einstellungen → MCP servers sowohl STDIO als auch Streamable HTTP. Wenn diese Oberfläche in deinem Client verfügbar ist, kannst du direkt denselben lokalen Startbefehl verwenden. Für den geschützten Einstieg ergänze `--remote-policy`; ein öffentlicher Tunnel ist dafür nicht nötig. Lokale Einstellungen werden nicht automatisch an ChatGPT im Web übertragen.

## ChatGPT im Web: privater Secure MCP Tunnel

Bevorzugter Weg für persönliche Apple-Daten: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Er verbindet den Mac ausgehend über HTTPS mit OpenAI; es wird kein öffentlicher Port geöffnet. Du brauchst einen Tunnel in den Platform-Tunneleinstellungen, eine eingeschränkte Runtime-Berechtigung für den Tunnel-Client und eine Zuordnung zum richtigen ChatGPT-Workspace. Tunnel erstellen: Read + Manage; betreiben/auswählen: Read + Use. Diese Rechte sind von ChatGPT-Workspace-Rechten getrennt.

1. Lade den aktuellen offiziellen `tunnel-client` über die Platform-Tunneleinstellungen oder das dort verlinkte OpenAI-Repository. Prüfe `tunnel-client help quickstart`.
2. Hinterlege den Runtime-Schlüssel lokal über die unterstützte sichere Umgebung (`CONTROL_PLANE_API_KEY`); nicht ins Repository, in Chats oder in Kommandoargumente kopieren.
3. Verwende für diesen Tunnel ausdrücklich den geschützten stdio-Start. Beispiel mit deinen absoluten Pfaden und deiner Tunnel-ID:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile apple-local \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command "/absolute/path/to/node /absolute/path/to/MCP-Apple-/dist/index.js --remote-policy"
tunnel-client doctor --profile apple-local --explain
tunnel-client run --profile apple-local
```

Bei Pfaden mit Leerzeichen den Startbefehl nach Vorgaben der installierten Client-Version quotieren. Der Tunnel nutzt hier bewusst stdio: die Zugangskontrolle erfolgt an der privaten OpenAI-Tunnelverbindung, und der Server setzt zusätzlich seine Remote-Werkzeugregeln durch. Der bestehende unbeschränkte Claude-Startbefehl sollte nicht als Tunnelziel übernommen werden.

4. In ChatGPT Plugins → Plus → Add custom MCP server → Connection: Tunnel deinen Tunnel auswählen und als privaten Plugin-Eintrag anlegen. Bei älteren Oberflächen liegen diese Funktionen unter Apps/Developer mode. Zugriff auf den Tunnel nur deinem eigenen Konto geben.
5. Zuerst nur die Werkzeugliste und danach eine ausdrücklich gewünschte harmlose Leseaktion testen. Der Mac muss erreichbar bleiben und der Tunnel-Client laufen. Schlafmodus unterbricht die Verbindung.

Der HTTP-Transport kann ebenfalls hinter einen Tunnel geschaltet werden. Dafür muss der Tunnel-Client die lokale Bearer-Authentifizierung oder den OAuth-Zugriff korrekt weiterreichen; das ist versionsabhängig und hier nicht end-to-end verifiziert. Der obige geschützte stdio-Weg vermeidet diese zusätzliche Konfiguration.

## Lokales Streamable HTTP testen

Ein langes zufälliges Geheimnis wird verpflichtend verlangt; es gibt keinen anonymen HTTP-Modus. In einer lokalen Shell:

```sh
export MCP_HTTP_AUTH=bearer
export MCP_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
npm run start:http
```

Ein lokaler MCP-Client verbindet sich mit `http://127.0.0.1:8787/mcp` und Header `Authorization: Bearer <MCP_HTTP_TOKEN>`. Den Wert sicher lokal an den Client übergeben, nicht ausgeben oder teilen. `.env` wird nicht automatisch geladen. Bearer-Token nicht als URL-Parameter verwenden. Alternativer Port: `MCP_HTTP_PORT` (1–65535).

Die Node-Anwendung bindet immer an `127.0.0.1`. Host und gegebenenfalls Origin müssen exakt zur lokalen Adresse oder zur konfigurierten öffentlichen Adresse passen; fremde Origins werden mit 403 abgelehnt. Es gibt keine CORS-Freigabe für beliebige Webseiten. Weiterleitungsheader wie `X-Forwarded-Host` werden nicht vertraut.

## ChatGPT im Web: HTTPS mit OAuth statt privatem Tunnel

Ein öffentlicher HTTPS-Tunnel allein ist keine Zugangskontrolle. Für diese Variante wird ein etablierter OAuth/OIDC-Anbieter benötigt; der Server implementiert absichtlich keinen eigenen Login-, Registrierungs- oder Token-Endpunkt. Die JWT-Prüfung nutzt `jose` und den konfigurierten JWKS-Endpunkt. Undurchsichtige Tokens/Introspection werden nicht unterstützt.

1. Richte beim Identitätsanbieter eine API für die exakte Resource/Audience `https://apple.example.com/mcp` und den Scope `apple:mcp` ein. Nur dein Konto darf diese Berechtigung bekommen. Nutze dessen stabile `sub`-Kennung, nicht eine frei eingebbare E-Mail-Adresse.
2. Der Anbieter muss einen Authorization-Code-Flow mit PKCE, MCP-kompatible Discovery sowie eine von ChatGPT unterstützte Client-Registrierung bieten (CIMD, DCR oder passende vorregistrierte Clientdaten). Refresh Tokens müssen bei Bedarf unterstützt werden. Discovery, Browser-Login und Token-Endpunkt müssen für ChatGPT erreichbar sein. Siehe [OpenAI OAuth-Anforderungen](https://developers.openai.com/plugins/build/auth).
3. Konfiguriere den Server mit den echten Werten deines Anbieters:

```sh
export MCP_HTTP_AUTH=oauth
export MCP_PUBLIC_URL=https://apple.example.com/mcp
export MCP_OAUTH_ISSUER=https://identity.example.com/
export MCP_OAUTH_JWKS_URL=https://identity.example.com/.well-known/jwks.json
export MCP_OAUTH_SUBJECT=YOUR_EXACT_OWNER_SUBJECT
npm run start:http
```

Issuer inklusive abschließendem Slash exakt wie im Token setzen. Geprüft werden RS256/ES256-Signatur, Issuer, Audience, feste Benutzerkennung, Pflicht-Claims `exp`/`iat`/`sub`, Ablauf/Not-before und der genaue Scope `apple:mcp`. JWT-Schlüssel werden über HTTPS geholt und vom JOSE-JWKS-Cache verwaltet. Widerruf einzelner JWTs wird nicht abgefragt; kurze Token-Laufzeiten nutzen. JWKS und Issuer werden ausschließlich lokal konfiguriert, niemals aus Token-Headern übernommen.

4. Stelle einen stabilen HTTPS-Reverse-Proxy/Tunnel auf genau diese öffentliche Adresse bereit; Upstream ist `http://127.0.0.1:8787`. Gültiges TLS-Zertifikat verwenden, kein Port-Forwarding auf das LAN. Proxy muss Authorization und MCP-Header unverändert weitergeben, Host auf der konfigurierten öffentlichen oder lokalen Adresse belassen und mindestens 190 Sekunden Antwortwartezeit erlauben (Bestätigung plus langsamste JXA-Aktion). Zugangsdaten nicht in Proxy-Logs schreiben. Keine weiteren internen Dienste weiterleiten. Optional kann der Proxy zusätzlich OpenAIs dokumentierte mTLS-Clientidentität prüfen; das ersetzt die Benutzeranmeldung nicht.
5. `/.well-known/oauth-protected-resource` auf demselben Host zum Server weiterleiten. Dort liefert er die Resource und den Authorization-Server. Nicht authentifizierte `/mcp`-Anfragen erhalten 401 mit Discovery-Verweis. Ein statischer Bearer-Schlüssel mit `MCP_PUBLIC_URL` wird beim Start abgewiesen: ChatGPT im Web unterstützt keine frei gewählten API-Schlüssel/Header.
6. In ChatGPT einen benutzerdefinierten MCP-Server/Plugin mit URL `https://apple.example.com/mcp` und OAuth anlegen, anmelden, Werkzeuge prüfen und zunächst lesend testen. Bei Änderung der Tool-Freigaben Werkzeuge im Client neu laden bzw. das Plugin nach dessen Vorgaben aktualisieren.

Der OAuth-Anbieter und der öffentliche Tunnel sind Infrastruktur des Nutzers und werden durch dieses Repository nicht automatisch angelegt. Ohne deren Einrichtung ist ein ChatGPT-Web-Login nicht einsatzbereit. Die Integration ist keine Hosting-Lösung für JXA: auf einem Linux-Cloudserver funktionieren die Apple-Apps nicht.

## Schreibaktionen gezielt freigeben

Für HTTP oder geschütztes stdio vor dem Start eine kommaseparierte Liste setzen, zum Beispiel:

```sh
export MCP_HTTP_WRITE_TOOLS=notes_create_note,reminders_complete_reminder
```

Standard ist die leere Liste. Unbekannte Namen und Wildcards führen zu einem Startfehler. Vollständige erlaubte Namen stehen in `WRITE_TOOLS` in `src/policy.ts`. Freigabe eines Werkzeugs gilt für alle damit erreichbaren Apple-Konten/Objekte.

Jeder freigeschaltete Aufruf benötigt zusätzlich ein lokales macOS-Dialogfenster mit Werkzeugname und den vom SDK geprüften konkreten Parametern. Standardknopf ist Cancel. Abbruch, fehlende Desktop-Sitzung, Fehler oder Ablauf nach 60 Sekunden verweigern die Aktion. Parameter über 4000 Zeichen werden verweigert, damit kein abgeschnittener Auftrag bestätigt wird. Dies betrifft auch lange Notizen/Mails. Es gibt keinen Remote-Schalter zum Umgehen der lokalen Bestätigung.

`mail_send_message`, alle Löschwerkzeuge und vollständige Notiz-Ersetzungen sind besonders sensibel. Nur bei wirklichem Bedarf einzeln freigeben. Vor Bestätigung Empfänger, Text, Objekt-ID und bei Kalenderterminen die gesamte Serie prüfen. Die Bestätigung ersetzt keine Backups. Clientseitige MCP-Annotations sind nur Hinweise; die tatsächliche Sperre liegt im Server. ChatGPT kann zusätzlich eigene Bestätigungen verlangen. Ein Prozess verarbeitet Anfragen nacheinander; getrennte Claude-/ChatGPT-Prozesse können trotzdem gleichzeitig dieselben Apple-Daten ändern. Änderungen deshalb bewusst koordinieren.

## macOS-Berechtigungen

Den Server in deiner angemeldeten macOS-Benutzersitzung starten. Beim ersten tatsächlichen App-Zugriff fragt macOS nach Automation/Apple-Events-Rechten. Unter Systemeinstellungen → Datenschutz & Sicherheit → Automation die jeweils benötigten Apps für den startenden Host erlauben (z. B. Terminal, Claude oder der verwendete Desktop-Client). Bei Kalender/Erinnerungen können zusätzliche Datenschutzabfragen erscheinen. Die sichtbare Zuordnung hängt vom Starter und der macOS-Version ab; ein neuer Starter kann erneut fragen.

Nur benötigte Rechte vergeben; pauschaler Festplattenvollzugriff ist für diesen Ansatz nicht vorgesehen. Für HTTP-Schreibbestätigungen muss der Mac bedienbar und eine GUI-Sitzung verfügbar sein. Bei einem Timeout zuerst Berechtigungsdialoge prüfen. Ein Timeout bestätigt nicht, dass eine Schreibaktion wirkungslos geblieben ist.

## Tarife und Verfügbarkeit

Die aktuelle [Anleitung für benutzerdefinierte MCP-Server](https://developers.openai.com/api/docs/guides/custom-mcp-server) beschreibt ChatGPT-Webzugriff mit Lese- und Schreibwerkzeugen, abhängig von Workspace-Freigaben und Sicherheitsregeln. Sie nennt keine universell garantierte Tarifmatrix. Daher lässt sich aus dem Repository allein keine Zusage für Free, Plus, Pro oder einen konkreten Workspace ableiten. Prüfe, ob dein Konto „Add custom MCP server“ bzw. die entsprechende Apps/Developer-mode-Funktion tatsächlich anbietet; Organisationsadmins können sie beschränken.

Lokaler Desktop-MCP-Zugriff, ChatGPT-Web-Plugins und Platform-Tunnelrechte sind getrennte Funktionen. Ein ChatGPT-Abo allein bestätigt keine Tunnelberechtigung. API-Nutzung und gegebenenfalls Identitätsanbieter/Tunnel-Hosting können zusätzlich berechnet werden. Dieses Projekt benötigt selbst keinen OpenAI-API-Key; nur der optionale Secure-Tunnel-Client benötigt seine eigene Runtime-Zugangsberechtigung.

## Prüfung und noch erforderlicher Praxistest

`npm test` prüft OAuth-Tokens (auch falsche Signatur, Audience, Benutzer, Scope und Ablauf), HTTP-Zugriffsschutz, Größe/Batch-Grenzen, Initialisierung und Tool-Liste mit dem offiziellen MCP-Client, direkte Aufrufe gesperrter Tools, simulierte lokale Freigaben und parallele Aufrufe. Der echte stdio-Prozess wird unter macOS initialisiert und seine vollständige Werkzeugliste geprüft. Bestehende Wiederholungstermin-Tests bleiben enthalten. Tests lesen oder verändern keine persönlichen Apple-Daten und senden keine Mails.

Vor produktiver Nutzung noch erforderlich: echter Login beim gewählten OAuth-Anbieter bzw. Tunnelverbindung zu deinem ChatGPT-Konto, erlaubte harmlose Leseaktion und lokale Bestätigung mit einer eigens angelegten Testnotiz. Die GUI-Bestätigung ist im automatisierten Test simuliert; macOS-Berechtigungen und Dialogdarstellung müssen in deiner Sitzung geprüft werden. Lösch- und Sendeaktionen wurden nicht live ausgeführt.
