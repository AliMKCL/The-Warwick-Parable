# Test rooms

A run is: the waiting room (room 0, the button), then `tests` test rooms and
`fillers` filler rooms in an order decided as the player goes, then the finale
hallway with its glowing door. The counts and the pool of tests are in
`data/layout.json`; the URL can override them (`?tests=4&fillers=2&pool=exit_timer,lift_wait`).

| File | What it does |
| --- | --- |
| `types.ts` | `TestKind`: everything a test declares |
| `kinds/*.ts` | One file per test |
| `registry.ts` | The list of tests |
| `config.ts` | Reads `data/layout.json` and overrides into a `LayoutConfig` |
| `schedule.ts` | `pickRoom`: decides each room as the player reaches it |
| `office/` | The office tasks from PR #6 (balloons, coffee, canteen, renumbered, pitch, loan, lockdown) and `adapter.ts`, which runs each one as a test |
| `../rules/rules.ts` | `RuleRuntime`: runs the current room's test, owns its timers |

## How a room is decided

When the player enters a room, the room behind each of its doors is planned
(`Run.plan` → `pickRoom`):

1. Test or filler: drawn in proportion to what is left, so the totals are exact
   whatever the order. A test that `needsNextTest` (the gamble) forces a test next.
2. Which test: from the pool, weighted by `data/layout.json` × the test's
   `weight(traits)`. Never over its cap, never the previous room's test (unless
   nothing else is left).
3. Which layout: one of the test's `candidates`, with its door count.
4. The test's `params` are made from that layout.

Filler rooms use `fillerLayouts` from `data/layout.json`, nudged by the profile.
Anomalies and messy/upside-down variants are decoration: they can appear in any
room except set pieces (`setPiece: true`) and the finale.

## Adding a test

1. Write `kinds/my_test.ts`:

   ```ts
   import type { TestKind } from '../types';

   export const myTest: TestKind = {
     id: 'my_test',
     candidates: [{ archetype: 'hub', exits: [2, 3] }, { archetype: 'l_gallery', exits: 2 }],
     weight: (t) => 1 + 2 * Math.max(0, t.curiosity - 0.5),   // optional
     maxPerRun: 2,                                             // optional
     params: ({ rng }) => ({ seconds: 20 }),
     describe: (p) => `What happens, for the model. "rule_line" is said when…`,
     start(h, t) { h.say(h.rule.line); h.after('end', Number(h.rule.params.seconds), () => h.say(h.rule.doneLine)); },
     onEvent(h, e) { if (e.type === 'door_chosen') h.profile.adjust('impulsivity', 0.05, 'why, in words', h.room, e.t); },
   };
   ```

2. Add it to `TEST_KINDS` in `registry.ts`.
3. Give it lines in `data/templates.json` under `rules.my_test` (`line`, `done`, optional `tried`).
4. Add it to `pool` in `data/layout.json` with a weight.

A test that needs its own room shape (like the lift) adds a builder to
`core/room/layouts.ts` and lists only that archetype in `candidates`. A test
with no runtime rule (like the choice room) returns `null` from `params`.
`tests/core/layout.test.ts` ("adding a test") plugs in a test this way.

## The office tasks (PR #6)

Seven tasks with their own rooms, scripted logic and scoring: `balloons`
(risk), `coffee` (learning vs advice), `canteen` (patience), `renumbered`
(adaptability), `pitch` (confidence), `loan` (trust), `lockdown` (what you do
when you can't leave). Each module in `office/` is unchanged from the PR apart
from import paths; `office/adapter.ts` turns it into a `TestKind` with its own
room (`room` hook), runs it on the room's events, and when the player leaves,
scores it, nudges the profile and reports a `task_result` (telemetry, and a
"Measured:" line in what the model is told). Their wording is in
`data/tasks.json`; their weights are in the `pool` in `data/layout.json`.

They use a few things the other tests don't: 10 Hz position samples (`move`
events, not kept in the run's event log), raw input (`input`), on-screen
questions (`ask` effect → `answer` event), a status line, props that scale or
turn, and the player's baseline from the waiting room. To add another office
task, write a module like those in `office/` and add it to `OFFICE_MODULES`
in `office/index.ts`.
