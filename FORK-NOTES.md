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

1. **WIP-Limit (`maxConcurrentRuns`, Default `1`)** — Host-seitig erzwungen, nicht
   nur im Browser:
   - Neue Einstellung im Settings-Namespace `task-board`, editierbar in der
     Plugin-Settings-Karte (Feld „Maximum concurrent runs (WIP)").
   - `TaskBoardHostService` führt eine FIFO-Warteschlange: Läufe über dem Limit
     warten, bis eine laufende Ausführung **settled** und damit ihren Platz
     freigibt. Das Anhängen der Session allein gibt den Platz nicht frei, sonst
     wäre das Board nur beim Start gedrosselt statt echt seriell.
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
4. **`lib/` wird committet** — damit `dsh plugin --profile web add
   github:kaiserfr/dsh-next-task-board` ohne Build-Schritt und ohne
   `allowBuilds`-Freigabe installiert. Es gibt bewusst **keinen**
   `prepare`-Hook. Nach Änderungen an `src/` also `pnpm build` ausführen und das
   gebaute `lib/` mitcommitten.

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
- Das WIP-Limit gilt für **alle** Läufe (manuell, per Cron), weil beide durch
  dieselbe Launch-Queue gehen.
- Der frühere In-place-Patch (`task-board-serial/patch-wip1.py`) ist mit diesem
  Fork überflüssig und darf nicht mehr angewendet werden.

## Pflege

Upstream-Änderungen manuell nachziehen (`git remote add upstream …`,
`git diff`/`cherry-pick`) und dabei die vier Punkte oben erhalten. Nach jedem
Quell-Änderungslauf: `pnpm typecheck && pnpm test && pnpm build`, danach `lib/`
mitcommitten.
