# FORK-NOTES — dsh-next-task-board

Dieses Repository ist ein **eigenständiger Fork** des DSH-Task-Boards.

| | |
|---|---|
| Upstream | [`zhu1090093659/dsh-web`](https://github.com/zhu1090093659/dsh-web) → `packages/dsh-task-board` |
| Upstream-Paket | `@linxin666/dsh-client-ui-task-board` |
| Basis dieses Forks | **0.3.23** (Commit `cd13fc1`, Branch `dev`) |
| Fork-Paket | `dsh-next-task-board` (Version `0.4.0`) |
| Lizenz | Apache-2.0 (unverändert übernommen, siehe `LICENSE`) |

## Änderungen gegenüber dem Upstream

Kurzfassung: **zehn echte Zusatz-Fähigkeiten** (1, 4, 6, 7, 8, 9, 10, 11, 12 und 13) plus drei
Paketierungs-/Datenschutz-Unterschiede (2, 3, 5). Alles Weitere ist unverändert
übernommen (siehe unten).

| Nr. | Art | Änderung |
| --- | --- | --- |
| 1 | **Mehr können** | Host-erzwungenes WIP-Limit **je Workspace/Lane** `maxConcurrentRuns` (Default `1`) mit FIFO-Queue |
| 2 | Datenschutz | Installations-Heartbeat an `dsh-market.com` entfernt |
| 3 | Paketierung | Eigenständiges Repo statt Monorepo (Build-Preset vendored in `build/`) |
| 4 | **Mehr können** | Karte auf „In Arbeit" ziehen startet den Task (Host-Aktion `rerun`) |
| 5 | Paketierung | `lib/` wird committet → Installation ohne Build-Schritt |
| 6 | **Mehr können** | Agentic-Programming-Defaults: Spalte „Ready for test" vor „Done", neue Tasks ins Backlog, git-Feature-Branch-Automatik |
| 7 | **Mehr können** | Host-erzwungenes Done-Spalten-Limit `maxDoneTasks` (Default `9`) mit FIFO-Verdrängung ins Archiv |
| 8 | **Mehr können** | Konfigurierbare State-Engine (`stateMachine`): Spalten = Zustände, erlaubte Übergänge + Übergangs-Aktionen deklarativ, Drag & Drop dagegen validiert |
| 9 | **Mehr können** | Läuft-jetzt-Karte unübersehbar markiert (Rahmen, Warn-Hintergrund, Ring, Abzeichen); WIP-Spalte als Queue sortiert (laufende Karte oben, wartende in Ankunftsreihenfolge) |
| 10 | **Mehr können** | Direkter Sprung von der Karte in die Session: Link in der Karten-Ecke, für aktive und inaktive Sessions; `#session=<id>`-Deep-Link (neuer Tab / kopierte URL), Roster-Refresh vor dem Retry |
| 11 | **Mehr können** | Mehrfachauswahl und Gruppen-Verschieben: Karten per Klick, Ctrl/Cmd-Klick und Shift-Bereich markieren (Doppelklick öffnet weiterhin das Detail), eine markierte Karte ziehen bewegt die ganze Auswahl als **eine** atomare Host-Aktion `move-many` |
| 12 | **Mehr können** | Korrektur nach Test: Karte von „Ready for test" zurück nach „To do" mit Anmerkung; die Anmerkung geht als **eigene neue Nachricht** in die vorherige Session (der ursprüngliche Prompt bleibt unverändert) |
| 13 | **Mehr können** | Inhalte bleiben editierbar, solange die Karte in „Backlog"/„To do" wartet — auch nach einem früheren Lauf; der Text der Box „Parse with AI" liegt als `parseText` an der Karte und wird beim Bearbeiten wiederverwendet |

Die englische Fassung dieser Übersicht steht im README unter
„What this fork adds over the upstream task board".

1. **WIP-Limit je Workspace/Lane (`maxConcurrentRuns`, Default `1`)** — Host-seitig
   erzwungen, nicht nur im Browser:
   - Neue Einstellung im Settings-Namespace `task-board`, editierbar in der
     Plugin-Settings-Karte (Feld „Maximum concurrent runs per workspace (WIP)").
   - Gezählt wird **pro Lane**, wobei die Lane die effektive Workspace des Tasks
     ist (die Workspace aus dem Handover-Bundle überschreibt den einfachen Pin).
     Karten ohne gepinnte Workspace teilen sich eine Lane, weil ihr echtes Ziel
     erst beim Start aufgelöst wird.
   - Lanes sind unabhängig: Läufe verschiedener Workspaces starten parallel, und
     eine volle Lane hält spätere Queue-Einträge anderer Lanes nicht auf. Innerhalb
     einer Lane bleibt die Queue FIFO.
   - `TaskBoardHostService` führt eine FIFO-Warteschlange: Läufe über dem Limit
     ihrer Lane warten, bis eine laufende Ausführung **settled** und damit ihren
     Platz freigibt. Das Anhängen der Session allein gibt den Platz nicht frei,
     sonst wäre das Board nur beim Start gedrosselt statt echt seriell.
   - Ein wartender Lauf ist im Ledger bereits `running` **ohne** Session, damit
     seine Karte nicht doppelt geöffnet werden kann.
   - Herabsetzen des Limits bricht keinen laufenden Task ab; überschüssige Plätze
     laufen leer, die Queue hält den Rest zurück.
   - Die Queue räumt sich selbst auf: Einträge, deren Ausführung nicht mehr offen
     ist (gelöscht, archiviert oder während des Wartens settled), werden beim
     nächsten Pump verworfen.
2. **Installations-Heartbeat entfernt** — der Upstream sendet beim Mount einmal
   pro Tag ein anonymes Telemetrie-Event an `dsh-market.com` (siehe
   `src/client/telemetry.ts`). Der Aufruf in `src/client/index.ts` ist in diesem
   Fork gestrichen; die Datei bleibt für einen späteren, eigenen Endpunkt liegen.
3. **Standalone-Repo statt Monorepo** — das Paket liegt in der Repo-Wurzel:
   - Das Build-Preset des Monorepos (`shared/tsdown.client.ts` +
     `shared/web-platform.ts`) liegt vendored in `build/`.
   - `lightningcss` ist als devDependency ergänzt (kam upstream aus der
     Workspace-Wurzel).
   - `README.i18n.yaml` (Hash-Register des Monorepo-Doku-Checks) entfällt; die
     `scripts/`-Werkzeuge des Monorepos existieren hier nicht.
4. **Ziehen nach „In Arbeit" startet den Task** — die `running`-Spalte ist ein
   Drop-Ziel: eine Karte aus einer anderen Spalte dorthin zu ziehen sendet
   dieselbe Host-Aktion wie der „Run"-Button im Detail (`rerun`), der Task läuft
   also wirklich über die Host-Queue an und wird nicht nur manuell umgebucht.
   Wartende und bereits laufende Karten werden ignoriert; `backlog`/`todo`
   bleiben reine manuelle Spaltenwechsel.
5. **`lib/` wird committet** — damit `dsh plugin --profile web add
   github:kaiserfr/dsh-next-task-board` ohne Build-Schritt und ohne
   `allowBuilds`-Freigabe installiert. Es gibt bewusst **keinen**
   `prepare`-Hook. Nach Änderungen an `src/` also `pnpm build` ausführen und das
   gebaute `lib/` mitcommitten.
6. **Agentic-Programming-Defaults** — der Board-Ablauf ist auf agentische
   Programmierung zugeschnitten:
   - Spaltenreihenfolge: `backlog → todo → running → ready_for_test → done →
     failed`; „Ready for test" sitzt direkt vor „Done".
   - Neue Tasks landen im **Backlog** und müssen manuell nach „Todo" gezogen
     werden. Der Backlog→Todo-Zug ist der Startschuss des Workflows.
   - Ein erfolgreicher Lauf (`succeeded`) parkt die Karte in **Ready for test**;
     „Done" wird ausschließlich manuell erreicht (Runner-Settles erzeugen es nie).
     Der Park ist eine **Session-Ende-Aussage**: gesettled wird erst, wenn die
     Session des Laufs wirklich still ist — ihr neuester Turn ist beendet, das
     Roster meldet sie idle, ihre Prompt-Inbox ist leer und kein Hintergrund-Job
     läuft noch. Eine einzelne Turn-Grenze parkt nie, denn die Session setzt
     jeden eingereihten Prompt und jeden Job-Weckruf als eigenen Turn fort; nur
     ein mit `completed` beendeter Turn zählt als Erfolg, ein vom Nutzer
     abgebrochener, interrupteter, blockierter oder ans Token-Limit gelaufener
     Lauf landet mit Begründung in **Failed**. Solange die Session arbeitet,
     bleibt die Karte in „In progress".
   - **Git-Integration** (`src/git-workflow.ts`, nur wenn die gepinnte
     Workspace ein git-Worktree ist, sonst überall No-op):
     Backlog→Todo legt den Feature-Branch `task/<titel-slug>-<id8>` an
     (Basis: aktueller Branch bzw. `main`/`master`, damit eine zweite Karte
     nicht auf der ersten aufsetzt); fehlt der Branch bei einem Start, der den
     Todo-Zug übersprungen hat (Cron, direkt nach „In progress" gezogen), wird
     er beim Start nachgeholt; vor jedem Lauf wird dieser Branch
     ausgecheckt („In progress" arbeitet darauf); Ready-for-test→Done
     committet die Änderungen im Worktree (`task: <titel>`, nur wenn dirty) und
     merged den Branch mit `--no-ff` zurück in den Basis-Branch. Schlägt git
     fehl (z. B. Merge-Konflikt), schlägt der Spaltenwechsel fehl und die Karte
     bleibt in „Ready for test" — kein stiller Merge.
   - Grenzen: git greift nur bei gepinnter Workspace (ohne Pin ist nicht
     bekannt, welches Repo gemeint ist); jede Workspace nutzt ihren eigenen
     Worktree, und das WIP-Limit je Lane verhindert, dass zwei Läufe derselben
     Workspace sich beim Auschecken überholen — verschiedene Workspaces dürfen
     parallel laufen.
7. **Done-Spalten-Limit (`maxDoneTasks`, Default `9`)** — Host-seitig erzwungen:
   - Neue Einstellung im Settings-Namespace `task-board`, editierbar in der
     Plugin-Settings-Karte (Feld „Done column limit (N)").
   - Beim Verschieben einer Karte nach „Done" prüft der Ledger die Anzahl der
     On-Board-Karten in „Done". Liegt sie über N, werden die Karten archiviert,
     die am längsten in „Done" liegen (FIFO über den Eintritts-Zeitstempel
     `doneAt`) — nur so viele, wie zum Einhalten des Limits nötig sind.
   - Wird das Limit angewendet (Host-Start mit der konfigurierten Einstellung
     oder eine Settings-Änderung), räumt der Ledger einen bereits überfüllten
     „Done"-Bestand sofort auf. Die Spalte zeigt dadurch nie mehr als N Karten,
     ohne auf die nächste Verschiebung zu warten; ein Herabsetzen von N kürzt den
     Überhang unmittelbar.
   - Die Verdrängung nutzt dieselbe Archiv-Transition wie das manuelle
     Archivieren: Status und Ausführungshistorie bleiben, ein Cron-Zeitplan wird
     entwaffnet, die Karte verlässt nur die Spalten und ist im Archiv sichtbar
     und wiederherstellbar. Es wird nie gelöscht.
   - Das Limit gilt ausschließlich für die Spalte „Done"; andere Spalten werden
     nie angefasst, und die verbleibenden Karten behalten ihre Reihenfolge.
8. **Konfigurierbare State-Engine (`stateMachine`)** — die Spalten des Boards
   sind die Task-Zustände; die Engine darunter ist deklarativ:
   - `src/core/state-machine.ts` hält die Zustandsmaschine als reine Daten:
     `states` (Spalten inkl. `label`, `order`, `drop`), `transitions`
     (`from`/`to`/`trigger`) und je Übergang `actions`.
   - Aktionen: `git.openBranch` (Feature-Branch öffnen, hängt am Übergang
     Backlog → To Do), `git.mergeBranch` (committen + zurückmergen, hängt an
     Ready for test → Done), `run` (Ausführung starten, auf dem Weg nach
     „In Arbeit"; von Backlog aus öffnet er vorher den Branch) und
     `{ kind: "stamp", field: "doneAt" }`.
   - Durchgesetzt wird die Maschine im **Host**: `HostTaskLedger` lehnt jeden
     `move` ab, den die Maschine nicht auflistet („invalid state transition"),
     und feuert beim erlaubten Übergang dessen Aktionen in Reihenfolge. Die
     neue Task landet in `initial`.
   - Der Browser validiert Drag & Drop gegen **dieselbe** Maschine: der Host
     legt seine aufgelöste Maschine in den Snapshot (`stateMachine`), das Board
     rendert daraus Spalten und erlaubte Drop-Ziele. Fällt eine Konfiguration
     durch die Validierung, bleibt die geltende Maschine in Kraft und die
     Settings-Karte markiert das Feld als ungültig.
   - Einstellbar über den Settings-Namespace `task-board`, Feld
     `stateMachine` (JSON) in der Plugin-Settings-Karte; leer = eingebaute
     Maschine. Diagramm der aktuellen Maschine:
     [`docs/state-machine.md`](docs/state-machine.md), erzeugt aus der
     Definition via `node scripts/render-state-machine.mjs`
     (`tests/state-machine.spec.ts` schlägt fehl, wenn beides auseinanderläuft).
   - Unverändert bleiben Ledger-Format, Protokoll und `TaskStatus`-Vokabular;
     konfigurierbar ist, welche Zustände Spalten sind, welche Wechsel erlaubt
     sind und was dabei passiert.
9. **Laufende Karte markiert + WIP-Spalte als Queue** — in der Spalte „In
   Arbeit" ist sofort erkennbar, welche Karte gerade läuft, auch wenn dort
   mehrere Karten stehen:
   - „Läuft jetzt" heißt: die letzte Ausführung ist offen **und** hat schon ihre
     Session angehängt — genau die Bedingung, unter der der Host einen
     WIP-Platz hält (`isTaskExecuting` in `src/core/tasks.ts`). Nur diese Karte
     bekommt fetten Warn-Rahmen, Warn-Hintergrund, pulsierenden Ring, Spinner
     und das Abzeichen „Running now".
   - Offene Ausführungen **ohne** Session (WIP-Queue eines vollen Workspace)
     sind in derselben Spalte, bleiben aber klar unterscheidbar: dünner
     Spaltenrahmen, kein Ring, Abzeichen „Queued".
   - Die Spalte ist wie die Warteschlange sortiert: die laufende Karte steht
     oben, danach die wartenden in Ankunftsreihenfolge — die zuletzt
     hineingezogene Karte steht zuunterst. Andere Spalten behalten die
     Ledger-Reihenfolge.
   - Die Sortierung ist reine Darstellung im Browser (`compareWipOrder` in
     `src/core/tasks.ts`, angewandt auf die Spalte, deren Übergang die
     `run`-Aktion trägt); Ledger und Host bleiben unverändert. Der Puls respektiert
     `prefers-reduced-motion`.
10. **Direkter Sprung von der Karte in die Session** — jede Karte, deren letzte
    Ausführung eine Session hat, bekommt in der Ecke ein kleines Link-Abzeichen
    (`⌁`, `src/client/board/TaskCard.tsx`):
    - Der Sprung gilt für **aktive** (laufende) und **inaktive** (settled,
      archivierte) Ausführungen gleichermaßen; er öffnet den Transcript direkt
      und **nicht** das Task-Detail.
    - Der Link ist ein `<a>` und **Geschwister** des Karten-Buttons, nicht dessen
      Kind: ein Button darf keine interaktiven Inhalte enthalten, und ein
      verschachtelter Anker wäre per Tastatur nicht erreichbar. Der Karten-Button
      behält damit genau eine Klickfläche (Detail), das Abzeichen ist per Tab
      fokussierbar.
    - Der `href` ist ein echter Deep-Link `#session=<id>`
      (`src/client/session-link.ts`). Ein normaler Linksklick springt an Ort und
      Stelle; Mittelklick / Strg-Klick oder eine kopierte URL öffnen die Session
      in einem neuen Tab, weil `apply()` (`src/client/index.ts`) beim Mount und
      bei `hashchange` auf den Hash hört. Die Web-Shell hat keinen eigenen
      Router, der Hash ist frei.
    - **Inaktive Sessions funktionieren auch mit veraltetem Roster:**
      `ctx.sessions.open()` lehnt jede id ab, die die lokale Session-Liste noch
      nicht gezogen hat („sessions.select: unknown session …") — genau der
      Normalfall einer älteren Ausführung in einem frischen Tab. `openSession`
      im Controller versucht es deshalb zuerst synchron, zieht bei Ablehnung
      **einmal** die Host-Namensliste nach (`sessions.refresh()`) und versucht es
      erneut; erst eine zweite Ablehnung wird als sichtbarer Fehler gemeldet
      (`sessionOpenError`, Banner im Board, quittierbar).
    - Abgedeckt durch `tests/card-session-link.spec.tsx` (aktive/inaktive/
      archivierte Karte, kein Link ohne Session, Detail-Klick unverändert,
      Deep-Link-Roundtrip) und die `openSession`-Fälle in
      `tests/controller.spec.ts`.

11. **Mehrfachauswahl und Gruppen-Verschieben** — mehrere Karten werden markiert
    und gemeinsam gezogen:
    - Auswahl wie im Dateimanager: ein Linksklick markiert genau diese Karte,
      Ctrl/Cmd-Klick nimmt eine weitere Karte auf oder wieder heraus, Shift-Klick
      markiert den Bereich vom Anker — der zuletzt einfach oder mit Ctrl
      angeklickten Karte — bis zur geklickten Karte in Board-Reihenfolge (Spalten
      von links nach rechts, innerhalb der Spalte von oben nach unten). Ein Klick
      auf freie Board-Fläche oder der Knopf im Auswahl-Chip lösen die Auswahl.
    - Weil der einfache Klick jetzt markiert, öffnet der **Doppelklick** das
      Task-Detail; auf der fokussierten Karte öffnet **Enter** es direkt (der
      Klick einer Tastatur-Aktivierung trägt `detail === 0`), während die
      **Leertaste** wie ein einfacher Klick markiert — mit denselben Zusätzen wie
      die Maus (Shift = Bereich, Ctrl/Cmd = umschalten). Den Keydown verbraucht
      die Karte selbst, damit weder der synthetische Klick des Buttons noch ein
      Seiten-Scroll entsteht. Das Öffnen des Details lässt die Auswahl stehen.
    - Ziehen an einer markierten Karte trägt die **gesamte** ziehbare Auswahl
      mit; Ziehen an einer nicht markierten Karte bewegt weiterhin nur diese
      eine Karte. Das Drag-Payload hält die Lead-Id in `text/plain` (wie bisher)
      und die ganze Id-Liste in `application/x-dsh-taskboard-cards`.
    - Der Host bekommt **eine** atomare Aktion `move-many`: er prüft die ganze
      Gruppe vor dem Schreiben, ein ungültiger Eintrag lässt den gesamten Stapel
      unverändert (`revision` steigt genau einmal). Karten, die die
      Zustandsmaschine nicht in die Zielspalte lässt, bleiben zurück; ist keine
      ziehbar, passiert gar nichts und die Auswahl bleibt stehen.
    - Die Reihenfolge der bewegten Karten untereinander bleibt erhalten (der
      Host behält die Ledger-Reihenfolge). Ablage auf der „In Arbeit"-Spalte
      startet jede gültige Karte nacheinander über den bestehenden
      `rerun`-Pfad, damit die Einzel-Lauf-Invariante des Runners gilt.
    - Rückmeldung: markierte Karten tragen Akzentrahmen und Tönung, die gezogenen
      Karten werden abgedunkelt, ein Zähler nennt die Anzahl. Die Auswahl ist
      reiner Browser-Zustand (wie der Filter) und steht nicht im Ledger; nach
      einem erfolgreichen Verschieben ist sie leer.
    - Abgedeckt durch die `move-many`-Fälle in `tests/protocol.spec.ts` und
      `tests/host-ledger.spec.ts` sowie die Auswahl- und Gruppen-Drag-Fälle in
      `tests/board-view.spec.tsx`.
12. **Korrektur nach Test: zurück nach „To do" mit Anmerkung** — der Übergang
    `ready_for_test → todo` existierte in der Zustandsmaschine schon
    (`manual('ready_for_test','todo')`, siehe `docs/state-machine.md`), es fehlte
    nur der Weg, ihn zu begründen:
    - Im Kartendetail bekommt eine Karte in „Ready for test" ein Feld
      **Korrektur-Anmerkung** und den Knopf **Zurück nach To Do**. Er schickt die
      neue Host-Aktion `rework` (Anmerkung getrimmt, max. 4000 Zeichen, leere
      Anmerkung wird abgelehnt) und startet **keinen** Lauf: wann der Agent wieder
      arbeitet, entscheidet weiterhin der Mensch (Drag auf „In Arbeit", Run-Knopf,
      Cron).
    - Der Host prüft den Übergang gegen die Zustandsmaschine wie jeden anderen
      Move und verweigert ihn, wenn dort kein `→ todo` deklariert ist
      (`invalid state transition`). Es gibt **keine** neue Aktionsart in der
      Zustandsmaschine: Aktionen sind statische Konfiguration, die Anmerkung sind
      Daten pro Zug.
    - Die Anmerkung hängt **nicht** am ursprünglichen Prompt. Sessions sind
      append-only, und nach dem ersten Prompt folgt der ganze Verlauf; ein
      Anhängen an den Prompt würde den tatsächlichen Session-Verlauf also falsch
      darstellen. Stattdessen schickt der nächste Lauf der Karte die Anmerkung als
      **eigene neue User-Nachricht** in die vorherige Session; der ursprüngliche
      Prompt bleibt unverändert (eine Karte in `ready_for_test` lässt ihren Inhalt
      ohnehin nicht mehr ändern, siehe Punkt 13).
    - Dafür erzwingt eine Rework-Runde die Fortsetzung: `reusableSessionId`
      bekommt `{ rework: true }` und ignoriert das `reuseSession`-Häkchen der
      Karte. Die Fail-closed-Regeln bleiben unangetastet — ist die vorherige
      Session verschwunden, läuft sie gerade, oder ist das Session-Roster
      unbekannt, wird **keine** Session fortgesetzt, sondern eine neue eröffnet;
      dann hängt die Anmerkung als eigener Abschnitt an einem frischen Prompt
      (plus Warnung im Host-Log), damit sie nie stillschweigend verloren geht.
    - Lebenslauf der Anmerkung: sie liegt als `reworkNote` an der Karte (sichtbar
      im Detail), wandert beim Start des nächsten Laufs in dessen
      `ExecutionRecord` (dort bleibt sie als Audit-Spur) und verschwindet von der
      Karte. Ohne Host-Transport (reines Browser-Ledger) wird der Rework
      abgelehnt, weil nur der Host das Ledger schreibt.
    - Nebenbei behoben: der Reuse-Pfad schickte bisher den **kompletten**
      ursprünglichen Prompt erneut als neuen Turn in die fortgesetzte Session.
      Bei einer Rework-Runde besteht der neue Turn jetzt nur noch aus der
      Anmerkung (mit kurzem Rahmen), weil die Session den ursprünglichen Auftrag
      bereits enthält. Ohne Anmerkung bleibt der Reuse-Prompt unverändert
      (byte-gleich), um bestehende Läufe nicht zu verändern.
    - Abgedeckt durch `tests/rework-note.spec.ts` (Normalisierung, Protokoll,
      Prompt-Zusammensetzung, Persistenz), die Rework-Fälle in
      `tests/host-ledger.spec.ts`, die erzwungene Fortsetzung in
      `tests/session-reuse.spec.ts`, Rework-Prompt und Launch-Verdrahtung in
      `tests/host-runner.spec.ts` / `tests/host-service.spec.ts` und die UI in
      `tests/rework-ui.spec.tsx`.

13. **Inhalte editierbar in „Backlog"/„To do" — mit dem Parse-Text an der Karte** —
    Upstream sperrte den Inhalt nach dem **ersten Lauf**; eine Karte, die
    fehlgeschlagen und zurück ins Backlog/To do gezogen wurde, blieb damit für
    immer gesperrt.
    - `canEditTaskContent` fragt jetzt den **Status**: editierbar ist eine Karte
      genau dann, wenn sie nicht archiviert ist und in `backlog` oder `todo`
      steht — unabhängig davon, wie viele Läufe schon passiert sind. `running`
      (die Session liest den Inhalt gerade), `ready_for_test`, `done` und
      `failed` bleiben gesperrt; dort führt weiterhin „Edit as New Copy" zum Ziel.
      Der Host prüft dieselbe Bedingung fail-closed bei jedem `update`-Patch.
    - Das neue optionale Kartenfeld `parseText` speichert den Text, mit dem die
      Box **„Parse with AI"** beim Anlegen gefüllt war. Das Bearbeitungsformular
      zeigt dieselbe Box (geteiltes `useAiParse`/`AiParseSection`) und startet sie
      mit diesem Text; „Parse and fill" überschreibt Titel, Beschreibung und
      Prompt erneut.
    - Ist der Text nicht (mehr) vorhanden — Karten aus der Zeit vor dem Feld oder
      ein geleerter Kasten —, startet die Box mit der **Summe aus Titel,
      Beschreibung und Prompt** (durch Leerzeilen getrennt, leere Teile entfallen,
      `parseSourceText`). Der Nutzer ändert diesen Block und führt „Parse and
      fill" erneut aus.
    - Gespeichert wird der Text wie die übrigen Inhaltsfelder: getrimmt, leer
      bedeutet „nicht vorhanden" (`normalizeParseText`). Das Bearbeitungsformular
      schickt die Quelle nur mit, wenn der Kasten tatsächlich angefasst wurde
      (`parse.text !== openingText`); wer nur Titel oder Prompt ändert, lässt den
      gespeicherten Text unangetastet, und eine Karte, die die Box nie benutzt
      hat, bekommt die abgeleitete Ersatzsumme nicht nachträglich als Quelle
      untergeschoben. `parseText` zählt als Inhalts-Patch und durchläuft deshalb
      dasselbe Tor wie Titel/Beschreibung/Prompt — auf der Leitung (Allowlist in
      `protocol.ts`), beim Import, im Ledger (`store.ts`, ungültige Zeile wird
      verworfen, leerer Wert wird zu „nicht vorhanden") und im reinen
      Browser-Ledger (`task-update.ts`).
    - Abgedeckt durch `tests/edit-parse.spec.tsx` (Vorbelegung aus dem
      gespeicherten Text, Ersatzsumme, erneutes Parsen, Speichern, versteckte Box
      ohne Parse-Fähigkeit), die Editierfälle in
      `tests/controller-use-cases.spec.ts` und `tests/task-detail-edit.spec.tsx`,
      den Persistenz-/Reparaturfall in `tests/store.spec.ts`, das Leitungstor in
      `tests/protocol.spec.ts` und das Mitschreiben beim Anlegen in
      `tests/ai-parse.spec.tsx`.

Unverändert übernommen: Ledger-Pfad und -Format (`$DSH_HOME/task-board/ledger-v2.json`,
Schema v3), die Host-Routen, die Sidebar-/Board-UI und die Row-Id `ui-task-board`
in `cordis.patch.yml`. Der Fork ist dadurch ein **Drop-in-Ersatz**: er liest und
schreibt dasselbe Ledger, bestehende Tasks bleiben erhalten. Upstream-Plugin und
Fork dürfen **nicht** parallel installiert sein — beide mounten dieselbe
Host-Route und denselben System-Prompt-Abschnitt.

## Installation

```sh
# aus dem Repo (kein Build nötig, lib/ liegt bei)
dsh plugin --profile web add github:kaiserfr/dsh-next-task-board

# lokale Entwicklung
pnpm install && pnpm build
dsh plugin --profile web add link:/pfad/zu/dsh-next-task-board
```

Danach `dsh web` neu starten (Host-Hälften werden beim Boot geladen) und die
Seite hart neu laden. Plugin und Upstream schließen sich aus:

```sh
dsh plugin --profile web remove @linxin666/dsh-client-ui-task-board
```

## Bekannte Grenzen

- Wartende Läufe haben noch keine Session. Startet der Host neu, während Läufe in
  der Queue stehen, räumt das Plugin sie beim Boot als `cancelled` ab
  („host restarted before the execution session was recorded") — dieselbe
  Behandlung wie bisher für abgebrochene Starts. Diese Tasks müssen erneut
  gestartet werden.
- Das WIP-Limit gilt je Workspace/Lane für **alle** Läufe (manuell, per Cron),
  weil beide durch dieselbe Launch-Queue gehen; verschiedene Workspaces laufen
  parallel.
- Der frühere In-place-Patch (`task-board-serial/patch-wip1.py`) ist mit diesem
  Fork überflüssig und darf nicht mehr angewendet werden.
- Die Mehrfachauswahl (Fork-Erweiterung) verschiebt Karten **in eine Spalte**,
  nicht an eine Position: ein Ablegen *zwischen* zwei Karten gibt es nicht, die
  bewegten Karten landen in der Zielspalte in ihrer bisherigen Reihenfolge.
- Die Mehrfachauswahl braucht Ctrl/Cmd bzw. Shift: auf reinen Touch-Geräten
  markiert ein Tippen nur eine Karte, ein Gruppen-Drag ist dort also nicht
  möglich.

## Pflege

Upstream-Änderungen manuell nachziehen (`git remote add upstream …`,
`git diff`/`cherry-pick`) und dabei die fünf Punkte oben erhalten. Nach jedem
Quell-Änderungslauf: `pnpm typecheck && pnpm test && pnpm build`, danach `lib/`
mitcommitten.
