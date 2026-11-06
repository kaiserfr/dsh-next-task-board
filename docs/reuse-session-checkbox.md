# Die Checkbox „Continue in the same conversation" (`reuseSession`)

Diese Notiz klärt zwei Fragen zur Kartenoption **„Continue in the same
conversation"**: (1) welches Verhalten sie steuert und wann man sie aktiviert,
(2) ob sie mit dem **Follow-up**-Konzept dasselbe bewirkt oder dazu redundant
ist. Aus der Analyse folgt eine kleine Korrektur an Hinweistext und
Follow-up-Dialog; das Verhalten der Läufe selbst bleibt unverändert.

## Kurzfassung

Die Checkbox ist eine **Laufrichtlinie für eine Karte**, kein zweiter
Follow-up-Weg. Sie entscheidet, welche Unterhaltung ein *gewöhnlicher* späterer
Lauf derselben Karte fortsetzt: die **zuletzt abgeschlossene Ausführung**
(angehakt) statt der **Klärungs-Unterhaltung** bzw. einer neuen Session, wenn es
keine Klärungs-Unterhaltung gibt.

Das **Follow-up** ist demgegenüber ein eigener Lebenszyklus: eine *neue* Karte
mit eigenem Text, die Branch/Worktree und die Quell-Unterhaltung erbt, deren
Quellkarte für die Dauer des Follow-ups gesperrt wird und deren erster Lauf als
Follow-up gerahmt ist. Ein Follow-up **erzwingt** `reuseSession: true`; die
Checkbox ist also die Mechanik, auf der Follow-up aufsetzt — nicht sein
Duplikat.

Einschränkung: Für Karten mit Klärungs-Chat ist die Checkbox heute **teilweise
redundant zur Klärungsregel** (dort wird die Klärungssession ohnehin immer
fortgesetzt); der frühere Hinweistext war ungenau, und im Follow-up-Dialog wirkte
sie wie eine Wahl (beides korrigiert, siehe unten). Sie bleibt trotzdem sinnvoll:
sie ist der einzige explizite Schalter für Karten ohne Klärungs-Chat und die
Basismechanik des Follow-ups.

## 1. Was die Checkbox steuert

Die Checkbox sitzt **nicht auf der Kartenkachel**, sondern in der Detailansicht
der Karte (Abschnitt „Ausführungs-Einstellungen", nicht archiviert) und im
Anlage-/Bearbeitungsformular. Sie schreibt das Feld `TaskRecord.reuseSession`
in den Ledger (`src/core/tasks.ts`, `src/client/board/TaskDetail.tsx`,
`src/client/board/NewTaskModal.tsx`); Beschriftung und Hinweis stehen unter
`exec.reuseSession` / `exec.reuseSessionHint` (`src/client/locales.ts`).

Die Entscheidung fällt in `reusableSessionId()` (`src/core/session-reuse.ts`).
Drei Quellen, in dieser Reihenfolge:

1. die Quell-Unterhaltung eines Follow-ups, solange der Follow-up-Rahmen noch
   nicht geschrieben wurde (`followUp.injectedAt` fehlt) — **unabhängig** von
   der Checkbox;
2. die Session der neuesten **abgeschlossenen** Ausführung — **nur** wenn
   `reuseSession === true` gesetzt ist, der Lauf eine Rückweisung bearbeitet
   (`rework`) oder es der Testlauf ist (`test`);
3. sonst die Klärungssession der Karte (`clarificationSessionId`), immer — und
   ohne eine solche eine neue Session.

Damit ist die Checkbox **kein** Schalter für „überhaupt wiederverwenden":
Rework- und Testläufe setzen die neueste Session ohnehin fort
(`src/host-service.ts`), und der erste Lauf einer Follow-up-Karte nimmt ohnehin
die Quellsession. Sie wählt nur zwischen „neueste Ausführung" und
„Klärungs-Unterhaltung/neu".

Wichtig: **„aus" bedeutet nicht „neue Unterhaltung".** Eine Karte mit
Klärungs-Chat setzt auch ohne Häkchen in der Klärungs-Unterhaltung fort; ein
frisches Gespräch *erzwingt* die Checkbox nicht. Der frühere Hinweistext („when
that session is idle and still exists", „instead of starting a new conversation
each time") war deshalb irreführend: die Ruhe-/Namensregister-Prüfung wurde am
2026-11-03 entfernt; eine belegte Session wird eingereiht, eine nicht
fortsetzbare lässt den Lauf sichtbar scheitern (fail closed, Session-ID in der
Fehlermeldung). Der Hinweis ist inzwischen entsprechend präzisiert.

### Wann aktivieren?

- wenn eine Karte **mehrfach** läuft und der nächste Lauf auf dem **letzten**
  Gespräch aufbauen soll — wiederkehrende/Cron-Karten, Wiederholung nach
  Abbruch oder Fehler, iterative Karten;
- besonders, wenn die Karte **keinen Klärungs-Chat** hat (Import, Bestand,
  eigene Zustandsmaschine): dort ist sie der einzige Weg, die letzte
  Unterhaltung fortzusetzen statt jedes Mal neu zu beginnen;
- bei **Follow-up-Karten** ist sie bereits vom Host gesetzt; im Follow-up-Dialog
  wird sie deshalb als erzwungen angezeigt (angehakt und deaktiviert, siehe
  unten).

Ohne Wirkung ist sie im normalen Pfad Klärung → Implementierung → Test (die
Klärungsregel bzw. der Testlauf erzwingen dieselbe Session), bei
Rework-Läufen und beim ersten Follow-up-Lauf.

## 2. Verhältnis zum Follow-up

| | Checkbox `reuseSession` | Follow-up |
| --- | --- | --- |
| Einheit | dieselbe Karte | neue Karte |
| Text | unverändert | neuer Titel/Text/Prompt; Quelltext eingefroren |
| Branch/Worktree | unverändert | geerbt und geteilt |
| Quellkarte | unberührt | gesperrt, solange das Follow-up existiert (kein Lauf, keine Freigabe, kein Löschen) |
| Erster Lauf | — | Quellsession + `FOLLOW-UP:`-Rahmen |
| Reichweite | pro Karte, jederzeit umschaltbar | strukturell in der neuen Karte verankert |

Ein Follow-up **setzt die Checkbox-Mechanik voraus und schaltet sie fest**:
`withFollowUpLink()` setzt `reuseSession: true`, friert die Quellsession als
`followUp.sessionId` ein und der erste Lauf nimmt sie
(`src/host-ledger.ts`). Die beiden Konzepte überlappen sich nur im Ziel
„Unterhaltung fortsetzen", nicht in der Sache.

Echte Redundanzen und Inkonsistenzen (Befund; Punkte 1 und 3 sind umgesetzt):

1. **Follow-up-Dialog:** Die Checkbox startete aus und wirkte wie eine Wahl,
   obwohl der Host sie ohnehin auf `true` setzt. Sie wird jetzt angehakt und
   deaktiviert angezeigt, mit eigenem Hinweis (`exec.reuseSessionFollowUpHint`),
   und der Dialog sendet `reuseSession: true` passend zum sichtbaren Zustand.
2. **Karten mit Klärungs-Chat:** „an" und „aus" führen in der Regel zur selben
   Session (Regel 3), der Schalter ist dort meist wirkungslos.
3. **Hinweistext:** war veraltet (Ruhe-/Namensregister-Prüfung gibt es nicht
   mehr); `exec.reuseSessionHint` beschreibt jetzt die tatsächliche Regel.
4. **AGENTS.md:** die Formulierung „默认每次 execution 创建独立会话" beschreibt
   nicht mehr die volle Regel, weil die Klärungssession immer fortgesetzt wird.

## 3. Beobachtung am produktiven Ledger (06.11.2026)

- 396 Karten; 9 mit `reuseSession: true`, davon 5 Follow-up-Karten (vom Host
  erzwungen), 4 ältere Karten ohne Klärungs-Chat.
- 106 Karten mit Ausführungen, aber ohne `clarificationSessionId` (alle
  archiviert: 104 in Done, je 1 in Tested/Clarification) — für sie ist die
  Checkbox der einzige Fortsetzungs-Schalter.
- 33 Karten, deren neueste abgeschlossene Session von der Klärungssession
  abweicht (alle archiviert, historisch) — der Unterschied ist real, aber unter
  der heutigen Regel selten.

## 4. Einschätzung

Die Checkbox hat einen **eigenständigen Zweck** und ist **nicht deckungsgleich**
mit dem Follow-up-Konzept; Follow-up baut darauf auf und erzwingt sie. Sie ist
aber **teilweise redundant zur Klärungsregel**; der frühere Hinweis und der
wirkungslose Zustand im Follow-up-Dialog machten das schwer erkennbar.

Umgesetzt: Die Checkbox bleibt. `exec.reuseSessionHint` beschreibt jetzt die
tatsächliche Regel (neueste abgeschlossene Session, sonst Klärungs-Chat/neu;
belegte Session wird eingereiht, nicht fortsetzbare scheitert sichtbar), und im
Follow-up-Dialog ist sie angehakt und deaktiviert, mit eigenem Hinweis. Die
Laufregel selbst (`reusableSessionId`) ist unverändert.
