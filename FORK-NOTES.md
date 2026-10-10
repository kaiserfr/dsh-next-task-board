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

Kurzfassung: **siebzehn echte Zusatz-Fähigkeiten** (1, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 und 20) plus drei
Paketierungs-/Datenschutz-Unterschiede (2, 3, 5). Alles Weitere ist unverändert
übernommen (siehe unten).

| Nr. | Art | Änderung |
| --- | --- | --- |
| 1 | **Mehr können** | Host-erzwungenes WIP-Limit **je Workspace/Lane** `maxConcurrentRuns` (Default `1`) mit FIFO-Queue — gilt für **Implementierungsläufe** („In progress", Cron); Klärungsläufe in „To do" sind WIP-frei (siehe 14 und 17) |
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
| 14 | **Mehr können** | Klärungsschritt vor der Implementierung: `backlog → todo` startet für **jede** Karte ihren Lauf (Aktion `clarify`) — dieselbe Execution wie in der In-Progress-Spalte (gleiche Start-Queue, aber **WIP-frei**: startet sofort statt „Queued", pausierbar), nur der Prompt ist der Karten-Prompt plus Klärungsblock („Bitte kläre jetzt alle offenen Fragen — und implementiere noch nichts." … „Die Implementierung beginnt erst mit dem Auftrag „Bitte jetzt implementieren".") samt System-Prompt-Stoppregel, die in jedem Turn gilt; **der Agent stellt seine offenen Fragen im Chat der Karte**, der Nutzer antwortet dort (kein Fragenfeld, kein `openQuestions`/`questionsResolvedAt`); die Karte bleibt in Todo, das Ziehen nach In Progress schließt die Runde und setzt **dieselbe Session** mit „Bitte jetzt implementieren." fort, direktes Ziehen Backlog → In Progress bleibt unmöglich |
| 15 | **Mehr können** | Pausieren/Fortsetzen laufender Arbeit: ein Klick pausiert **alle** Karten in „In progress“ (Host-Aktion `pause`, stoppt je Lauf die Session), Karten bleiben in ihrer Spalte (`pausedAt`, Lauf bleibt offen), Pause-/Play-Symbolik am Kopf-Button, an jeder Karte und am Ausführungs-Knopf im Detail; Fortsetzen (`resume`) schreibt „Weitermachen“ in dieselbe Session |
| 16 | **Mehr können** | Fertig-Meldung des Laufs, Session-Ende entscheidet: der Agent beendet seine letzte Antwort mit einer eigenen Zeile `FERTIG: <Zusammenfassung>` (Bericht für den Menschen im Chat); die Karte wandert erst nach „Ready for test", wenn die Session des Laufs **tatsächlich beendet** ist — eine weiter als laufend geführte Session blockiert den Wechsel, unabhängig von der Meldung |
| 17 | **Mehr können** | *(durch 18 abgelöst)* WIP-Platz nur für **wirklich arbeitende** Läufe: eine offene Ausführung, deren Session der letzte Roster-Poll als untätig sah, belegte keinen Platz mehr — der Roster kennt aber nur „läuft gerade ein Turn?", nicht „ist der Lauf fertig?" |
| 18 | **Mehr können** | **WIP 1 strikt je Workspace/Lane**: der Platz gehört jeder offenen Implementierungs-Ausführung **mit angehängter Session**, von der Session-Zuweisung bis zum `settle()` (Erfolg erst nach dem Ende der Session) oder bis zur Pause — der Roster gibt ihn **nicht** mehr frei. Damit kann nie eine zweite Implementierungs-Session derselben Workspace im selben Worktree arbeiten; wartende Karten bleiben in „In progress" und tragen ein Warte-Abzeichen samt Blocker und Workspace, der Drop auf die Laufspalte meldet den Grund einmalig. Todo und Ready for Test bleiben ohne Limit |
| 19 | **Mehr können** | Kein stiller Verlust von Formular-Eingaben: Klick neben das Popup, Escape und „Cancel" schließen es, die Eingaben bleiben aber als **Entwurf** im Board-Controller und kommen beim nächsten Öffnen zurück (eigener Entwurf je Formular/Karte, Hinweis mit „Entwurf verwerfen", Punkt am „+ New task"-Knopf); nach dem Anlegen/Speichern ist der Entwurf verbraucht |
| 20 | **Mehr können** | **Wartende Frage auf der Karte**: hält die Konversation einer Karte eine Frage, die der Agent gestellt hat und auf die er wartet (blockierender `ask_user_question`-Aufruf ohne Ergebnis, oder ein Turn, den der Agent mit eigener Nachricht beendet hat, während die Session stillsteht), trägt die Karte ein Fragezeichen in der linken oberen Ecke; ein Klick springt über denselben `#session=<id>`-Deep-Link direkt in die Session mit der Frage. Der Host liest das je Poll aus der Konversation (`awaitingAnswerWatch` + `runner.awaitingAnswer`, zusätzlich die `userQuestions`-Projektion für das timed-Schema) und schickt `awaitingAnswer: { taskId → sessionId }` im Snapshot und im SSE-Frame — nie ins Ledger. Die Markierung erscheint mit der Frage und verschwindet mit der Antwort; ein fehlgeschlagener Read hält das letzte Urteil, eine unbekannte Session-Liste ändert nichts |

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
     ihrer Lane warten, bis eine laufende Ausführung ihren Platz freigibt — weil
     sie **settled** (Erfolg/Fehler/Abbruch; der Erfolg erst nach dem Ende der
     Session) oder weil ihre Karte **pausiert** wird. Weder das
     Anhängen der Session allein noch ein untätiger Roster-Eintrag geben den Platz
     frei: der Roster sagt nur, ob gerade ein Turn läuft, nicht ob der Lauf fertig
     ist (siehe Punkt 18).
   - Die Grenze gilt nur für **Implementierungsläufe** (Spalte „In progress",
     Cron). Ein Klärungslauf aus „To do" läuft zwar durch dieselbe
     Start-Queue, wartet aber nie auf einen Platz und belegt auch keinen:
     „To do" ist WIP-frei, er startet sofort — auch neben einem arbeitenden
     Lauf derselben Lane (siehe Punkt 14).
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
   Wartende und bereits laufende Karten werden ignoriert; `backlog` bleibt ein
   reiner manueller Spaltenwechsel. Seit dem Klärungsschritt (Punkt 14) startet
   auch `backlog → todo` einen echten Lauf (über dieselbe Start-Queue, aber
   WIP-frei — siehe Punkt 14 —, mit Klärungs-Prompt); `backlog → running` existiert nicht mehr, und ein
   unbeaufsichtigter Lauf (cron) startet eine Karte mit ungeklärten offenen
   Fragen nicht — ein menschliches Ziehen nach „In Arbeit" gibt die Fragen frei
   und setzt die Klärungssession fort.
5. **`lib/` wird committet** — damit `dsh plugin --profile web add
   github:kaiserfr/dsh-next-task-board` ohne Build-Schritt und ohne
   `allowBuilds`-Freigabe installiert. Es gibt bewusst **keinen**
   `prepare`-Hook. Nach Änderungen an `src/` also `pnpm build` ausführen und das
   gebaute `lib/` mitcommitten.
6. **Agentic-Programming-Defaults** — der Board-Ablauf ist auf agentische
   Programmierung zugeschnitten:
   - Spaltenreihenfolge: `backlog → todo → running → ready_for_test → failed →
     done`; „Ready for test" sitzt direkt vor „Failed", „Done" ist die letzte Spalte.
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
     Todo-Zug übersprungen hat (Cron oder Run-Knopf), wird
     er beim Start nachgeholt; vor jedem **Implementierungslauf** wird dieser
     Branch ausgecheckt („In progress" arbeitet darauf) — ein Klärungslauf
     checkt **keinen** Branch aus (`git.useBranch` entfällt): er implementiert
     nichts und würde einem laufenden Lauf derselben Workspace den Worktree
     wegziehen (siehe Punkt 14); **sobald die Karte „Ready for test" erreicht,
     wird committet** (`git.commitBranch` auf allen manuellen Wegen in die
     Spalte, und der Runner-Settle `running → ready_for_test` über denselben
     Git-Helfer, weil ein Settle keine konfigurierbare Aktion feuert): `git add
     -A`, Message `task: <titel>`, nur wenn dirty (kein Leer-Commit, sonst bleibt
     das vorige `committedAt` stehen), fehlender Branch wird vorher angelegt. Das
     gilt für **jeden** Ausgang eines Implementierungslaufs — auch `failed` und
     `cancelled` (inklusive der Host-Stornierung eines unterbrochenen Starts beim
     Neustart) committen, damit nie etwas im Worktree liegen bleibt; Klärungsläufe
     committen nie. Verweigert git den Commit (z. B. ein Hook), scheitert der Zug
     bzw. das Settle **nicht**: der Fehler wird an die neueste Execution
     angehängt (`error`, in der Ausführungshistorie der Karte sichtbar); nur eine
     Karte ohne jede Ausführung bekommt bloß eine Host-Warnung. Ready-for-test→Done
     committet Reste als Sicherheitsnetz und merged den Branch mit `--no-ff`
     zurück in den Basis-Branch. Schlägt dort git fehl (z. B. Merge-Konflikt),
     schlägt der Spaltenwechsel fehl und die Karte bleibt in „Ready for test" —
     kein stiller Merge.
   - Grenzen: git greift nur bei gepinnter Workspace (ohne Pin ist nicht
     bekannt, welches Repo gemeint ist); jede Workspace nutzt ihren eigenen
     Worktree, und das WIP-Limit je Lane verhindert, dass zwei
     Implementierungsläufe derselben Workspace sich beim Auschecken überholen —
     Klärungsläufe checken nichts aus und fallen nicht darunter; verschiedene
     Workspaces dürfen parallel laufen.
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
     Backlog → To Do), `git.commitBranch` (den Worktree auf den Feature-Branch
     committen, hängt an **allen** manuellen Übergängen nach „Ready for test";
     ohne Repo oder bei sauberem Worktree No-op), `git.mergeBranch` (Reste
     committen + zurückmergen, hängt an
     Ready for test → Done), `run` (Ausführung starten, auf dem Weg nach
     „In Arbeit"; nur von To Do aus, gibt ungeklärte offene Fragen frei und
     setzt die Klärungssession fort), `clarify` (den Lauf der Karte über
     dieselbe Start-Queue, aber WIP-frei starten — echte Execution mit
     Klärungs-Prompt, ohne Branch-Auscheck, bleibt in der Spalte, hängt
     ebenfalls an Backlog → To Do) und
     `{ kind: "stamp", field: "doneAt" }`. Pro Übergang wirkt nur die **erste**
     Git-Aktion, `"git": false` überspringt sie ganz.
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
     Session angehängt (`isTaskExecuting` in `src/core/tasks.ts`) — bei einem
     Implementierungslauf genau die Bedingung, unter der der Host einen
     WIP-Platz hält; ein Klärungslauf in Todo hält keinen. Nur diese Karte
     bekommt fetten Warn-Rahmen, Warn-Hintergrund, pulsierenden Ring, Spinner
     und das Abzeichen „Running now".
   - Offene Ausführungen **ohne** Session (WIP-Queue eines vollen Workspace)
     sind in derselben Spalte, bleiben aber klar unterscheidbar: dünner
     Spaltenrahmen, kein Ring, Abzeichen „Queued". Eine Karte in **Todo** steht
     nie in dieser Queue: ihr Klärungslauf startet ohne WIP-Platz sofort.
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
12. **Korrektur nach Test: der Chat ist die Anmerkung** — der Übergang
    `ready_for_test → todo` existierte in der Zustandsmaschine schon
    (`manual('ready_for_test','todo')`, siehe `docs/state-machine.md`). Das
    Korrekturfeld im Kartendetail ist **entfallen**; die Korrektur wird direkt in
    der Session der Karte geschrieben:
    - **Kein Board-Feld mehr.** Weder eine Textarea noch `reworkNote`/`rework`
      (Karte/Execution), `normalizeReworkNote`, der Prompt-Anhang noch die
      Host-Aktion `rework` existieren weiter — die Beschreibung steht in der
      Konversation selbst, das Ledger hält nur den Stempel. Alte `reworkNote`-
      Werte im Ledger werden beim nächsten Schreiben verworfen.
    - **Der Host hört am Chat mit.** Jeder Poll (5 s) liest für Karten in
      `ready_for_test`/`failed` den Kopf ihrer neuesten abgeschlossenen Session
      (`ledger.reworkWatch()` — eine billige Projektion, der heiße Poll-Pfad
      klont nicht das Dokument; `runner.newestHumanTurn()` liest den
      `session/follow`-Kopf). Eine **menschliche Nachricht** (`user/message`) ab
      dem Park-Zeitpunkt schickt die Karte über einen ganz normalen,
      maschinengeprüften `move` nach `todo`. Zwei Bremsen: unverändertes
      `updatedAt` der Session spart den History-RPC, und ein unlesbarer Kopf
      (`known: false`) gilt nie als „keine Nachricht", sondern wird wiederholt.
    - **Stempel statt Text.** Jeder Weg aus `ready_for_test`/`failed` nach `todo`
      stempelt `reworkAt` (Zeitpunkt) und `reworkCount` (Anzahl) — der Drag/Chip
      wie der Chat-Auslöser. Sichtbar als Zeile im Kartendetail; sonst passiert
      beim Rückschub nichts: der Lauf startet weiterhin nur auf menschliche
      Anweisung.
    - **Die Runde wird als solche geführt.** `pendingRework(task)` (Stempel
      jünger als der letzte Nicht-Clarify-Lauf) markiert den nächsten Lauf
      (`ExecutionRecord.rework`), die Clarify-Runde verbraucht die Marke nicht.
      Ein solcher Lauf erzwingt die Fortsetzung der korrigierten Konversation
      (`reusableSessionId(..., { rework: true })` — unabhängig vom
      `reuseSession`-Häkchen) und schickt als neuen Turn nur den kurzen
      Rework-Rahmen (`reworkPrompt()`, ohne Textkopie), weil der Auftrag, die
      Arbeit und die Korrektur bereits im Verlauf stehen. Ist die Session weg
      oder beschäftigt, eröffnet der Lauf fail-closed eine neue und fährt mit
      dem vollen Prompt fort (plus Host-Warnung).
    - **Zwei neue Übergänge.** `ready_for_test → running` und
      `failed → running` (jeweils `run`) ziehen die Karte direkt aus der Review-
      bzw. Fehlerspalte auf die Laufspalte; der Lauf setzt dieselbe Konversation
      fort. Die Karte muss also nicht mehr über `todo` laufen, und `backlog →
      running` bleibt weiterhin ohne Übergang.
    - Abgedeckt durch `tests/rework.spec.ts` (Stempel, `pendingRework`,
      Prompt-Zusammensetzung, Persistenz, entfallene Wire-Aktion), die
      Rework-Fälle in `tests/host-ledger.spec.ts`, die Chat-Erkennung in
      `tests/host-service.spec.ts`, die erzwungene Fortsetzung in
      `tests/session-reuse.spec.ts`, Rework-Prompt und Launch-Verdrahtung in
      `tests/host-runner.spec.ts` und die UI in `tests/rework-ui.spec.tsx`.

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

14. **Klärungsschritt vor der Implementierung** — before a task is implemented,
    what the agent does not know yet is settled with the human first. Es gibt
    dafür **keine zusätzliche Session und kein Fragenfeld**: die Karte bekommt
    ihre eine Session, in der der Agent **im Chat** fragt, der Nutzer dort
    antwortet, und der Lauf, der nach In Progress startet, setzt genau diese
    Session fort. Die Fragen gehören dem Agenten, nicht dem Formular — deshalb
    gibt es weder `openQuestions` noch `questionsResolvedAt` am Datensatz noch
    einen „Karte klären"-Knopf; die Liste wäre die des Nutzers, und was zu klären
    ist, weiß der Agent erst beim Lesen der Aufgabe.
    - **`backlog → todo` ist der Klärungsschritt und ein echter Lauf — für jede
      Karte.** Die Transition trägt neben `git.openBranch` die Aktion
      **`clarify`**: der Host legt eine Execution mit `kind: 'clarify'` an, die
      **wie ein Lauf der In-Progress-Spalte** durch dieselbe Start-Queue geht,
      aber **nicht** durch deren WIP-Grenze: „To do" ist WIP-frei, der
      Klärungslauf startet also sofort — auch neben einem arbeitenden Lauf
      derselben Lane — und liest sich nie als „Queued" (die Karte bleibt in
      **Todo** — der Klärungslauf wechselt die Spalte nie — und zeigt sich wie
      jeder andere Lauf: **Running** sobald die Session hängt, plus
      Session-Link in der Ecke und demselben Pause-/Play-Knopf). Er checkt
      außerdem keinen Branch aus (er implementiert nichts und darf einem
      laufenden Lauf den Worktree nicht wegziehen). Der Prompt ist der **normale Karten-Prompt** (inkl.
      Tags/Handover/Freeze-Wrap) plus dem Klärungsblock (`CLARIFICATION_ADDENDUM`
      in `clarificationPrompt`): „Bitte kläre jetzt alle offenen Fragen — und
      implementiere noch nichts. / Stelle deine Fragen und stoppe dann. / Wenn
      noch Fragen offen sind, stelle die nächsten und stoppe wieder. / Wenn du
      alles geklärt hast stoppe und fasse nur kurz zusammen. / Die
      Implementierung beginnt erst mit dem Auftrag „Bitte jetzt implementieren"." —
      das ist der **einzige** Unterschied zum Lauf der In-Progress-Spalte. Damit
      der Stopp nicht nur im ersten Turn gilt, trägt `TASK_BOARD_GUIDANCE` eine
      **Stoppregel für Klärungssessions**, die an der ersten Zeile dieses Blocks
      hängt und mit **jedem Turn** erneut im System-Prompt steht: in einer
      Klärungssession wird nichts implementiert — nach jeder Antwort entweder die
      nächste Frage stellen und stoppen oder nach der letzten Antwort stoppen.
      Beide Texte interpolieren denselben Konstanten-Text, können also nicht
      auseinanderlaufen (`tests/guidance.spec.ts` prüft genau das). Die Session-Id
      landet über `attachSession` als `clarificationSessionId` an der Karte; ein
      erneuter Eintritt in die Spalte startet einen neuen Lauf, der diese
      Session fortsetzt statt eine zweite anzulegen. Das Startsignal (Ziehen
      nach In Progress oder Run-Knopf) **schließt den offenen Klärungslauf**
      (`supersedeClarification`, Ergebnis `cancelled`); ein noch nicht
      gestarteter Klärungslauf wird dabei verworfen, und einer, dessen Session
      gerade erst entsteht, wird gestoppt statt an die Karte gehängt — die Karte
      hat nie zwei offene Läufe und nie zwei Sessions. Ein **Gruppen-Drop**
      (`move-many`) startet bewusst keine Läufe — dieselbe Regel, die eine
      Batch-Bewegung keine Ausführungen starten lässt.
    - **Auswertung:** der Host-Monitor beobachtet und settled den Klärungslauf wie
      jeden Lauf; das Ergebnis landet in der Execution-Historie (in der
      Detail-Ansicht als „Clarification" markiert), die Karte bleibt aber in
      ihrer Spalte — auch ein fehlgeschlagener Klärungslauf parkt sie nicht in
      `failed`.
    - **Anzeige:** die Karte liest sich wie ein laufender Task (Running;
      „Queued" gibt es in Todo nicht)
      und verlinkt über die Ecke direkt den Klärungs-Chat; die Detail-Ansicht
      zeigt denselben Lauf samt Historie. Ein Fragen-Abzeichen gibt es nicht
      mehr.
    - **Freigabe durch den Menschen:** das Ziehen der Karte auf „In Progress"
      (oder der Run-Knopf) ist das Startsignal. Der Host schließt die offene
      Runde und setzt die Klärungssession mit **einem kurzen Zusatz-Prompt**
      fort: „Bitte jetzt implementieren." — der Agent hat den Karten-Prompt, die
      Fragen und die Antworten bereits im Kontext, es wird weder das ganze
      Prompt wiederholt noch eine zweite Session geöffnet. **`backlog →
      running` ist aus der Default-State-Machine entfernt** — die Transition
      existiert nicht mehr, ein direktes Ziehen von Backlog nach In Progress ist
      damit unmöglich; die Karte muss durch die Klärungsspalte.
    - **Eine Session:** `reusableSessionId` bevorzugt bei einem Lauf die
      Klärungssession der Karte (idle und im Roster vorhanden), erst danach greift
      die bisherige Logik (`reuseSession`/Rework → letzte abgeschlossene
      Ausführung). Damit läuft die Implementierung in derselben Session, in der
      die Fragen beantwortet wurden; ein unbekanntes Roster fällt wie bisher
      fail-closed auf eine frische Session zurück. Ein Import streicht die
      Fremd-Session.
    - Die Regel steht zusätzlich im **Task-System-Prompt** (`TASK_BOARD_GUIDANCE`
      in `src/index.ts`, deutscher Klärungs-Absatz) und in der
      State-Machine-Doku (`docs/state-machine.md`).
    - Abgedeckt durch `tests/clarification-step.spec.ts` (Spalte und Status des
      Klärungslaufs, Lauf für jede Karte, Freigabe per Drag samt geschlossener
      Runde, Session-Wiederverwendung, Pause/Weiter, Prompt-Zusammenbau) und die
      Klärungsfälle in `tests/board-view.spec.tsx`
      (Running-Anzeige, Session-Link, Pause-Knopf) sowie den End-to-End-Fall in
      `tests/host-service.spec.ts` (Klärungslauf startet WIP-frei neben einem
      arbeitenden Lauf, danach dieselbe Session mit „Bitte jetzt
      implementieren."; ein vom Startsignal überholter Lauf wird gestoppt statt
      angehängt). Die Default-Machine
      und das Diagramm prüfen `tests/state-machine.spec.ts`;
      `tests/guidance.spec.ts` prüft den Wortlaut der Regel im Task-System-Prompt
      samt Nennung des Klärungsschritts und des fehlenden Direkt-Drops.

15. **Pausieren und Fortsetzen laufender Arbeit** — laufende Tasks lassen sich
    anhalten, ohne sie aus „In progress" zu nehmen; das Fortsetzen schreibt
    automatisch „Weitermachen" in den Chat.
    - **Ein Klick für die ganze Spalte:** der Kopf-Button (`pause-all`) sendet
      die Host-Aktion `pause` mit **allen** Karten der Lauf-Spalte (nicht auf den
      aktuellen Filter/Projekt eingegrenzt) in **einem** Ledger-Schreibvorgang —
      dadurch kann die WIP-Queue zwischen zwei Pausen nicht die nächste Karte
      starten. Die Karte selbst trägt denselben Schalter in der Ecke
      (Pause-Symbol ⏸ solange der Lauf offen ist), und der Ausführungs-Knopf der
      Detail-Ansicht ist derselbe Pause-/Play-Schalter (⏸ / ▶ „Weitermachen").
    - **Der Zustand:** `pausedAt` an der Karte. Status und Spalte bleiben
      `running`, der Execution-Record bleibt **offen** — der Lauf ist suspendiert,
      nicht beendet. `isTaskExecuting` meldet eine pausierte Karte als *nicht*
      laufend, `runtimeView()` lässt ihre Ausführung aus (kein Monitor, kein
      WIP-Platz), `settle()` ignoriert sie (der abgebrochene Turn darf die Karte
      nicht nach `failed`/`todo` schieben) und `reconcileInterruptedStarts`
      überspringt sie beim Host-Neustart. Karten mit offenem Lauf sind weiter
      nicht verschiebbar/löschbar: der Weg zurück ist das Fortsetzen.
    - **Stoppen:** `HostExecutionRunner.cancel(sessionId)` ruft
      `session/cancel` (nur der aktive Turn endet, die Session bleibt). Hat die
      Session keinen lebenden Agenten mehr (Lauf schon fertig, Host neu
      gestartet), wird die Pause wieder aufgehoben (`clearPause`) und der normale
      Monitor settled den Lauf — statt eine Karte dauerhaft einzufrieren.
    - **Fortsetzen:** `resume` löscht `pausedAt` und der Service schreibt über
      `launch(task, { reuseSessionId, resume: true })` einen kurzen
      „Weitermachen (continue)"-Turn (`resumePrompt`) **in dieselbe Session** —
      Permission/Modell werden dabei wie bei jeder Wiederaufnahme neu
      angewendet. Ein Lauf, der noch auf einen WIP-Platz wartete und nie eine
      Session bekam, geht stattdessen zurück in die Start-Queue; ein solcher Lauf
      wird während der Pause auch nicht gestartet (`launch` prüft `isPaused`).
    - **Protokoll/Transport:** `pause`/`resume` sind Strikt-Aktionen mit einer
      Kartenliste (`taskIds`, dedupliziert, `MAX_BATCH_MOVE`-Cap) — eine Karte
      für den Karten-Schalter, die ganze Spalte für den Kopf-Button. Der
      Controller nutzt sie als `pauseTasks`/`resumeTasks`.
    - Abgedeckt durch `tests/pause-runner.spec.ts` (Letzter Turn, `cancel`,
      Fortsetzen, Rücknahme bei fehlgeschlagenem Stopp, kein Start pausierter
      Queue-Läufe), die Pause-Fälle in `tests/host-ledger.spec.ts`, den reinen
      Übergang in `tests/tasks.spec.ts`, die UI in `tests/pause-ui.spec.tsx`
      sowie `tests/protocol.spec.ts` und `tests/store.spec.ts`.

16. **Fertig-Meldung des Laufs (`FERTIG:`) — die Session entscheidet** — ein Lauf,
    der tatsächlich fertig ist, meldet das selbst; die Karte bleibt trotzdem so
    lange als „läuft" stehen, bis die Session des Laufs beendet ist.
    - **Das Signal:** die letzte Antwort des Agenten enthält eine eigene Zeile
      `FERTIG: <kurze Zusammenfassung>`. Die Zeile ist der **Bericht für den
      Menschen** im Chat der Karte — sie ist ausdrücklich **nicht** der Auslöser
      des Spaltenwechsels.
    - **Der Übergang:** `HostExecutionRunner.inspect()` meldet `succeeded` nur,
      wenn der Lauf beendet **und** die Session nachweislich am Ende ist: die
      frische Roster-Zeile meldet sie nicht mehr als laufend, die Live-Baseline
      (`session/control`) zeigt keine wartende Nachricht und keinen laufenden Job.
      Ein weiterlaufender Turn hält das Ergebnis auf `pending` — die Karte bleibt
      in „In progress" mit ihrer offenen Ausführung. `reconcileExecutions` fragt
      das für jede offene Ausführung ab; die frühere Sonderbehandlung für
      Implementierungsläufe (`completionMarker`) ist entfallen.
    - **Behobener Fehler:** die Meldung rechnete den Lauf vorher sofort als
      `succeeded` ab und schob die Karte nach „Ready for test", **während die
      Session noch lief** (und damit auch noch hätte weiterarbeiten können).
      Richtig ist die Reihenfolge Session-Ende → Spaltenwechsel.
    - **Kein Timeout, keine Ausnahme:** führt die Laufzeit eine fertige Session
      dauerhaft als laufend, bleibt die Karte in „In progress"; Pausieren bewegt
      sie weiterhin von Hand, und der WIP-Platz der Lane bleibt bis zum
      `settle()` bei ihr (Punkt 18).
    - **Klärungsläufe:** brauchen keine Sonderregel mehr — die Runde in „To do"
      endet nach jeder Fragerunde, ohne dass die Arbeit fertig ist, und ihr
      Chat-Verlauf kann die Karte gar nicht mehr bewegen; sie bleibt in „To do",
      bis der Mensch sie auf die Laufspalte zieht.
    - **Prompt-Regel:** `COMPLETION_MARKER`/`COMPLETION_INSTRUCTION`
      (`src/host-runner.ts`) hängen als letzter Block an **jedem**
      Implementierungs-Turn (`promptText`: voller Prompt, „Bitte jetzt
      implementieren."-Turn, Weitermachen, Korrektur-Turn) — der
      System-Prompt-Abschnitt ist per Default (`announceToAgent: false`) aus und
      darf nicht der einzige Träger des Berichts sein; er bekommt dieselben
      Konstanten zusätzlich als Regel für jeden Turn. Der Klärungs-Turn bekommt
      den Block **nicht**.
    - Abgedeckt durch `tests/host-runner.spec.ts` (die Meldung allein kann eine
      laufende Session nicht abrechnen; derselbe Lauf parked nach dem
      Session-Ende; wartende Nachricht/laufender Job halten ihn weiterhin offen)
      und `tests/host-service.spec.ts` (Karte bleibt `running`, während die
      Session läuft, und wechselt erst nach ihrem Ende nach `ready_for_test`).

17. **WIP-Platz nur für wirklich arbeitende Läufe** *(durch Punkt 18 abgelöst:
    der Roster ist kein Beweis für das Ende eines Laufs)* — die Zählung, ob eine
    Lane noch belegt ist, orientierte sich am Arbeiten, nicht am bloßen Anhängen.
    - **Vorher:** `pumpLaunchQueue` zählte je Lane jede offene Ausführung mit
      angehängter Session. Ein fertiger, aber noch nicht abgerechneter Lauf (der
      alte Fehler aus Punkt 16) oder ein Klärungslauf, der auf die Antwort des
      Menschen wartete, hielt damit den einzigen Platz der Workspace — jede
      weitere nach „To do" oder „In progress" gezogene Karte landete als „Queued",
      obwohl nichts lief.
    - **Jetzt:** die Platzbelegung überspringt Sessions, die der letzte
      Roster-Poll (`session/list`) als untätig gemeldet hat
      (`idleSessionIds`). Ein **echt arbeitender Implementierungslauf** hält den
      Platz weiter. Ein Klärungslauf in „To do" belegt dagegen **gar keinen**
      Platz — die Spalte ist WIP-frei, er wartet nie und startet sofort
      (Punkt 14). Ist der Roster unbekannt (`idleSessionIds === undefined`),
      wird für Implementierungsläufe **nichts** gefiltert: eine unlesbare Liste
      ist kein Beweis für einen freien Platz.
    - **Nachziehen:** `pollSessions` ruft nach jedem Poll `pumpLaunchQueue()`, damit
      wartende Karten starten, sobald ein Platzherr als untätig erkannt wird; das
      Settlen eines Laufs tat das schon vorher (Ledger-Subscription).
    - Abgedeckt durch `tests/host-service.spec.ts` (`lane occupancy`: Start trotz
      angehängter, aber untätiger Ausführung; Queue hinter einem arbeitenden Lauf
      und Start, sobald er ruht; Klärungslauf in Todo startet neben dem
      arbeitenden Lauf, während der Zug nach „In progress" — der
      Implementierungslauf — weiterhin wartet) und `tests/wip-limit.spec.ts`
      (Todo-Karte startet ohne Platz, ihr Implementierungslauf bleibt begrenzt).

18. **WIP 1 strikt je Workspace/Lane: der Platz gehört dem offenen Lauf, nicht
    dem laufenden Turn** — die im Betrieb beobachtete Kollision (zwei Tasks
    derselben Workspace arbeiteten gleichzeitig im selben Worktree) hatte eine
    konkrete Ursache: `pumpLaunchQueue` rechnete eine offene
    Implementierungs-Ausführung nicht mehr gegen ihre Lane, sobald der letzte
    Roster-Poll (`session/list`) ihre Session als untätig meldete. Der Roster
    kennt aber nur „läuft gerade ein Turn?", nicht „ist der Lauf fertig?" — ein
    Agent, der mitten in der Arbeit eine Rückfrage stellt und seinen Turn
    beendet, war damit „idle", obwohl Worktree, Branch und Karte weiter ihm
    gehörten; die nächste wartende Karte derselben Lane startete und beide
    Sessions arbeiteten im selben Checkout.
    - **Jetzt:** der WIP-Platz gehört **jeder offenen Implementierungs-Ausführung
      mit angehängter Session**, von der Zuweisung der Session bis zum
      `settle()` (Erfolg/Fehler/Abbruch; der Erfolg erst nach dem Ende der
      Session) — oder bis die Karte pausiert wird
      (`runtimeView()` blendet pausierte Ausführungen aus, Pause gibt den Platz
      also frei und „Weiter" hängt die Karte wieder in die Queue). Die
      Roster-Ausnahme für Implementierungsläufe ist entfernt; `idleSessionIds`
      dient nur noch der Session-Wiederverwendung (`reusableSessionId`).
      Klärungsläufe in „To do" bleiben WIP-frei (Punkt 14), die Todo- und
      Ready-for-Test-Spalten haben weiterhin kein Limit.
    - **Wartezustand bleibt sichtbar und erklärbar:** eine blockierte Karte
      bleibt in „In progress" (ohne Session) und startet automatisch, sobald der
      Platz frei wird; sie trägt jetzt ein Warte-Abzeichen mit Begründung
      („… wartet auf ‚<Task>' in Workspace <X>", `card.waitingOn` /
      `card.waitingNoWorkspace`) statt des generischen „Queued", und der Detail-
      Dialog zeigt denselben Satz. Der Drop auf die Laufspalte meldet zusätzlich
      einmalig `board.queuedNotice` (Blocker + Workspace), damit der
      Nutzer den Grund sofort sieht; pausierbar bleibt die wartende Karte wie
      jeder offene Lauf.
    - **Draht:** `TaskBoardSnapshot`/`TaskBoardEventPayload` tragen jetzt
      `maxConcurrentRuns` und `maxDoneTasks`, damit der Client das echte Limit
      kennt (`HostTaskLedger.maxDoneTasksLimit` als Lesezugriff; `setMaxConcurrentRuns`
      emittiert). Der Browser leitet den Wartegrund nur ab — die Durchsetzung
      bleibt ausschließlich Host-seitig.
    - Abgedeckt durch `tests/wip-limit.spec.ts` („keeps the lane occupied while
      the occupant run is open, even when its session is idle" — der
      Regressionstest für die Ursache; „frees the lane as soon as the occupant is
      paused"), `tests/host-service.spec.ts` (`lane occupancy`: Queue bleibt trotz
      untätigem Roster bestehen und startet erst nach dem Settle) und
      `tests/board-view.spec.tsx` (Warte-Abzeichen samt Blocker-Namenszug und
      `queuedDropNotice`-Text).

19. **Kein stiller Verlust der Formular-Eingaben in den Popups** — ein
    versehentlicher Klick neben das Popup ist kein Datenverlust mehr.
    - **Vorher:** der gesamte Formularzustand lag in der Popup-Komponente
      (`NewTaskModal`/`EditTaskModal`/`EditTagsModal`). Der Hintergrund schließt
      das Popup bei `mousedown`, das Board hängt es bedingt ein — damit war der
      Zustand beim Schließen weg. Besonders schmerzhaft im „Parse with AI"-Feld:
      der Text war verloren, und die Karte existierte nie, weil `createTaskConfirmed`
      nur beim Absenden läuft.
    - **Jetzt:** der Formularzustand wandert beim Schließen in eine **Entwurfsablage
      des `BoardController`** (`getFormDraft`/`saveFormDraft`/`discardFormDraft`,
      nur im Speicher, also bis zum Seiten-Reload) und wird beim nächsten Öffnen
      wiederhergestellt. Jedes Formular hat seinen eigenen Schlüssel
      (`new`, `duplicate:<karten-id>`, `edit:<karten-id>`, `tags:<karten-id>`), damit
      ein Entwurf nie bei einer anderen Karte auftaucht.
    - **Schließwege:** Klick daneben, **Escape** und „Cancel" verhalten sich gleich
      (Entwurf bleibt); ein nie berührtes Formular hinterlässt nichts. Nach
      erfolgreichem Anlegen/Speichern wird der Entwurf verworfen — auch wenn die
      Host-Bestätigung erst nach dem Schließen eintrifft.
    - **Sichtbarkeit:** das wiederhergestellte Formular zeigt oben „已恢复上次未完成的
      输入 / Restored what you had typed" mit **„Entwurf verwerfen"**, der Knopf
      „+ New task" trägt einen Punkt (`data-draft="true"`), solange ein Entwurf
      wartet. Eine laufende KI-Analyse wird beim Schließen abgebrochen; der
      eingefügte Text bleibt im Entwurf.
    - Abgedeckt durch `tests/form-draft.spec.tsx`.

20. **Wartende Frage auf der Karte sichtbar und anklickbar** — eine Karte, deren
    Agent etwas gefragt hat und auf die Antwort wartet, sieht nicht mehr aus wie
    jede andere.
    - **Erkennung im Host, nicht im Browser:** der 5-Sekunden-Session-Poll liest
      für die Kandidaten aus `ledger.awaitingAnswerWatch()` — jede Karte mit
      **offenem, nicht abgerechnetem Lauf** (der Agent kann mitten im Lauf fragen)
      plus jede **Todo-Karte mit Klärungssession** (deren Klärungslauf ist
      abgerechnet, die Karte bleibt stehen, die Antwort gehört in genau diese
      Konversation) — den Kopf der Konversation (`session/follow`) und entscheidet
      über `runner.awaitingAnswer(sessionId, running)`. Zwei Formen zählen:
      ein **blockierender `ask_user_question`-Aufruf ohne Ergebnis** (der Turn
      bleibt offen, der Roster meldet die Session weiter als laufend — das ist
      der Modus der ausgelieferten Presets), und ein **Turn, den der Agent mit
      einer eigenen Nachricht beendet hat**, während die Session stillsteht (die
      Form der Klärungsrunde, die nach jeder Fragerunde stoppt). Für das
      **timed**-Schema von `ask_user_question` wird zusätzlich die dauerhafte
      Session-Projektion `userQuestions` gelesen (`session/projections` →
      `values.userQuestions.active`), weil dort der Vordergrund-Wait enden kann,
      während die Frage beantwortbar bleibt; fehlt die Projektion (blockierendes
      Preset, älterer Host), ist das kein Fehler.
    - **Erscheinen und Verschwinden:** das Ergebnis geht als
      `awaitingAnswer: { taskId → sessionId }` in den Snapshot **und** in den
      SSE-Frame (wie `maxConcurrentRuns`/`maxDoneTasks`, weil es die Revision
      nicht erhöht) und wird **nie ins Ledger geschrieben**. Ein unveränderter
      Roster-Eintrag (`updatedAt` + `running`) kostet keinen zweiten History-Read;
      sobald ein neues Ereignis ankommt, wird neu gelesen — ist der neueste
      Oberflächen-Event nicht mehr der fragende Agent (Antwort des Menschen,
      Tool-Ergebnis, neuer Turn), ist die Karte sofort wieder unmarkiert, ohne auf
      den nächsten Lauf zu warten.
    - **Fehlerpolitik:** ein fehlgeschlagener History-Read behält das letzte
      Urteil und wird beim nächsten Poll wiederholt (eine offene Frage wird nicht
      wegen eines Aussetzers fallen gelassen), eine unbekannte Session-Liste lässt
      die veröffentlichte Zuordnung unangetastet, eine im Roster fehlende Session
      trägt nichts bei. Pausierte Karten sind bewusst keine Kandidaten — ihre
      Session wurde absichtlich gestoppt, das ist kein Warten. Archivierte Karten
      ebenso wenig.
    - **Auf der Karte:** ein Fragezeichen-Anker in der linken oberen Ecke
      (`data-dsh-part="card-awaiting-answer"`, Warn-Ring, sanftes Pulsieren;
      `prefers-reduced-motion` schaltet es ab), der die Ecke per
      `data-answering` reserviert. Er nutzt denselben `#session=<id>`-Deep-Link
      und dieselben Klickregeln wie der Session-Anker (der in der rechten unteren
      Ecke unverändert bleibt), springt also per Linksklick direkt in die Session
      — die Fragekarte steht dort im Composer — und per Mittelklick/Ctrl-Klick in
      einen neuen Tab.
    - Abgedeckt durch `tests/awaiting-answer.spec.ts` und
      `tests/card-awaiting-answer.spec.tsx`.

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

- Eine **erfolgreich angelegte Karte kann unsichtbar bleiben**, wenn das Board
  gerade die Archiv-Ansicht zeigt oder ein Such-, Tag- oder Projektfilter aktiv
  ist: „+ New task" ist in allen drei Fällen bedienbar, die frische Karte erfüllt
  aber keine der Sichtbarkeitsbedingungen (`TaskBoard.visible`). Bewusst nicht
  geändert (der Entwurfs-Fix aus Punkt 18 deckt den gemeldeten Fall ab): wer die
  Karte sehen will, wechselt zurück aufs Board bzw. leert den Filter.
- Wartende Läufe haben noch keine Session. Startet der Host neu, während Läufe in
  der Queue stehen, räumt das Plugin sie beim Boot als `cancelled` ab
  („host restarted before the execution session was recorded") — dieselbe
  Behandlung wie bisher für abgebrochene Starts. Diese Tasks müssen erneut
  gestartet werden.
- Das WIP-Limit gilt je Workspace/Lane für alle **Implementierungs**läufe
  (manuell, per Cron); Klärungsläufe in „To do" nicht — die Spalte ist WIP-frei,
  sie starten sofort (Punkt 14). Verschiedene Workspaces laufen parallel. Den Platz belegt nur ein Lauf, dessen Session der Roster-Poll als
  arbeitend sieht — ein angehängter, aber untätiger Lauf (fertig, wartend) tut
  das nicht (Punkt 17). Ein Lauf, dessen Session untätig ist, aber noch
  anstehende Arbeit besitzt (stehender Prompt, laufender Hintergrund-Job), gibt
  seinen Platz dadurch für kurze Zeit frei — der bewusste Preis dafür, fertige
  Läufe nicht mehr vor sich hin blockieren zu lassen; das Settle-Monitor kennt
  diese Unterscheidung weiterhin und rechnet einen solchen Lauf nicht vorzeitig
  ab.
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
mitcommitten. Die Host-Hälfte wird beim Boot geladen — nach einem Build an
`src/host-*.ts`/`src/index.ts` erst `dsh web` neu starten (der laufende Host
bedient bis dahin weiter den alten Stand); die Client-Hälfte lädt die Seite hart
neu.
