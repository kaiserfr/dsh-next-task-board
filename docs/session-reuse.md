# Weitergabe der Kartensession (Ursache, Änderung, Verifikation)

Diese Datei dokumentiert den Fehler „zwei Sessions für eine Karte" beim Übergang
**Klärung → In Progress** und beim anschließenden **automatischen Testlauf**
(In Progress → Testing), die Korrektur in `src/core/session-reuse.ts` und den
Stand der Verifikation.

## Symptom

Nach dem Ziehen einer Karte von *Klärung* nach *In Progress* waren für die Karte
zwei Sessions sichtbar, und der Agent bekam den vollständigen Karten-Prompt
erneut statt nur des Go-Aheads „Bitte jetzt implementieren.".

## Ursache

Die Entscheidung, ob ein Lauf die vorhandene Unterhaltung fortsetzt, lag in
`reusableSessionId()`. Sie prüfte jeden Kandidaten zusätzlich gegen
`idleSessionIds` — einen **zwischengespeicherten Namensregister-Snapshot**, den
`TaskBoardHostService` bei jedem Poll bzw. 5-Sekunden-Sync aus `session/list`
neu setzte (`host-service.ts`). Nur wenn die Session in genau diesem Snapshot
als *nicht laufend* stand, wurde sie weiterverwendet; sonst entstand eine neue
Session.

Ein solcher Snapshot ist immer einen Moment alt:

- Der **automatische Testlauf** wird synchron in `HostTaskLedger.settle()`
  geöffnet und sofort gestartet. Der Snapshot stammt damit aus der Zeit **vor**
  dem Ende der Implementierungssession — sie steht dort noch als *running*, und
  der Lauf startete eine zweite Session mit dem vollen Prompt plus Testblock
  statt mit „Bitte jetzt testen.".
- Beim **Go-Ahead** (Klärung → In Progress) ist der Snapshot je nach Poll-Takt
  bis zu 60 Sekunden alt (5-Sekunden-Sync nur bei aktiver Ereignisspur), und eine
  noch laufende Klärungssession galt zusätzlich als „busy" und damit als nicht
  wiederverwendbar. Die alte Session wurde dabei nur im Ledger storniert, nicht
  gestoppt.
- Ein unbekanntes Namensregister (`known: false`, z. B. direkt nach einem
  Host-Neustart) schaltete die Wiederverwendung komplett ab.

Der Widerspruch zum Entwurf: `settle()` setzt bereits voraus, dass die Session
zur Ruhe gekommen ist (`inspect()` verlangt `turn/end` und eine bestätigt
ruhende Session). Das Ledger weiß also längst, dass die Unterhaltung beendet
ist — nur die Wiederverwendungsregel fragte stattdessen den veralteten Snapshot.

### Messung in der produktiven Historie (`$DSH_HOME/task-board/ledger-v2.json`)

| Übergang | Läufe | davon neue Session |
| --- | --- | --- |
| Klärung → Implementierung | 187 | 15 (8 %) |
| Implementierung → automatischer Test | 17 | 16 (94 %) |

Beispiel `40060525`: Klärungssession endet 13:46:09.948, die Implementierung
startet 13:46:15.014 in einer **neuen** Session mit vollem Prompt. Gegenprobe
`5f06f7ab` (17:40): alle drei Läufe in derselben Session — der Fehler ist ein
Timing-Rennen, keine harte Sperre.

## Änderung

`src/core/session-reuse.ts` entscheidet jetzt allein anhand des Ledgers; das
Namensregister ist kein Kriterium mehr (Feld `idleSessionIds` und seine
Zuweisungen in `host-service.ts` sind entfallen). Die Kandidaten bleiben in
dieser Reihenfolge:

1. die Quell-Unterhaltung eines Follow-ups, solange der Follow-up-Rahmen noch
   nicht geschrieben wurde (`followUp.injectedAt` fehlt),
2. die Session der neuesten **abgeschlossenen** Ausführung, wenn die Karte
   `reuseSession` gesetzt hat, der Lauf eine Rückweisung bearbeitet (`rework`)
   oder es der Testlauf ist (`test`),
3. die Klärungssession der Karte (`clarificationSessionId`), immer.

Verhaltensfolgen (bewusst):

- **Belegte Session:** Der Prompt wird in die laufende Unterhaltung eingereiht
  (die Laufzeit hängt ihn an den nächsten Turn). Es entsteht keine zweite
  Session; der Go-Ahead landet nach dem Turn, den der Mensch gerade sieht.
- **Namensregister unbekannt oder Session nicht (mehr) gelistet:** Die im Ledger
  vermerkte Unterhaltung wird trotzdem fortgesetzt. Lässt sie sich gar nicht
  fortsetzen, scheitert der Lauf **sichtbar** auf der Karte (die Session-ID
  steht in der Fehlermeldung), statt still eine zweite Unterhaltung zu öffnen.
- Der kurze Go-Ahead („Bitte jetzt implementieren.") bzw. der kurze Testauftrag
  („Bitte jetzt testen.") greift damit zuverlässig; der volle Karten-Prompt wird
  nur noch bei der ersten Session einer Karte bezahlt.

Nicht geändert: die Klärungsrunde selbst, das Stornieren einer überholten Runde
im Ledger, die Siedlungslogik (`settle`) und der Prompt-Inhalt der Läufe.

## Nachweis (automatisiert)

Neu bzw. angepasst: `tests/session-reuse.spec.ts`,
`tests/host-service.spec.ts`, `tests/clarification-step.spec.ts`,
`tests/follow-up.spec.ts`.

Die beiden Regressionstests der Service-Ebene bilden genau die beiden
Fehlerbilder ab:

- `continues the clarification conversation although the roster still shows it running`
  — Go-Ahead bei veraltetem Namensregister: eine Session, kurzer Go-Ahead.
- `continues the implementation conversation in the automatic test run without a roster`
  — Testlauf, der in `settle()` entsteht: keine Namensregister-Abfrage, eine
  Session, kurzer Testauftrag.

Gegenprobe: mit dem alten Stand (`git stash push -- src/…`) schlagen alle vier
neuen Prüfungen fehl, mit der Änderung laufen sie durch.

## Verifikation am echten Board (Testphase)

Der echte Kartenzug findet in einer **isolierten zweiten DSH-Instanz** statt
(eigenes `DSH_HOME`, eigener Port, Wegwerf-Karte) — nicht im laufenden Board,
damit die produktive Oberfläche unberührt bleibt:

1. Plugin bauen (`pnpm build`), isolierte Instanz mit diesem Profil starten.
2. Wegwerf-Karte in *Klärung* ziehen (Klärungsrunde antwortet mit einer Frage),
   Frage im Chat beantworten, Karte nach *In Progress* ziehen.
   Erwartung: **eine** Session; der Chat enthält Frage, Antwort und den
   Go-Ahead — keine zweite Unterhaltung.
3. Implementierung abschließen lassen (kurzer Auftrag genügt).
   Erwartung: der automatische Testlauf setzt **dieselbe** Session fort, der
   kurze Testauftrag erscheint dort.
4. Ergebnis im Bericht des Testlaufs festhalten (die Testphase ändert keinen
   Code, deshalb steht das Ergebnis dort und nicht in dieser Datei).

Deployment-Hinweis: Das deployte Plugin ist dieser Haupt-Checkout (Symlink in
`$DSH_HOME/profiles/web/node_modules`). Ein Neustart des laufenden Hosts ist
erst sinnvoll, wenn die Karte in einer Ruhespalte steht — ein Neustart während
eines offenen Laufs beendet dessen Session ohne `turn/end`, und der Lauf würde
als „session ended before the run completed a turn" scheitern.

## Siehe auch

- [Die Checkbox „Continue in the same conversation" (`reuseSession`)](reuse-session-checkbox.md)
  — was die Kartenoption steuert, wann sie zu aktivieren ist und wie sie sich
  zum Follow-up-Konzept verhält.
