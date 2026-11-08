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
2. Which test: from the pool, weighted by `data/layout.json` × how much the
   test is expected to reveal (adaptive selection, below). Never over its cap,
   never the previous room's test (unless nothing else is left).
3. Which layout: one of the test's `candidates`, with its door count.
4. The test's `params` are made from that layout.

Filler rooms use `fillerLayouts` from `data/layout.json`, nudged by the profile.
Anomalies and messy/upside-down variants are decoration: they can appear in any
room except set pieces (`setPiece: true`) and the finale.

## Adaptive selection (Bayesian, expected information gain)

Each trait in the profile is a posterior over 0–1 (`core/profile/bayes.ts`), not
a single number: the dossier shows its mean and ± one standard deviation. Each
test declares what it reveals in `measures`, as item-response (2PL) items:
`{ trait, a, b }`, where `a` is how sharply the outcome separates low from high
(about 3 = weak, 9 = very clear) and `b` is the trait level at which the outcome
is a coin flip.

When a room is planned, `scoreTests` works out each eligible test's expected
information gain: the mutual information between its outcome and the traits it
measures, given what the profile currently believes. A trait that is already
pinned down, or an item that can't separate anything, gives close to nothing.
The draw is still random so runs vary, but tilted towards the best test:

    score = pool weight × (0.1 + bits / best bits) ^ focus

`focus` (in `data/layout.json`, or `?focus=`) is the one knob: 0 ignores the
information, 4 is the default, and 8 or more nearly always takes the single best
test. `npm run bench` prints what each value buys in accuracy and costs in
variety. Each test room records why it was drawn (`RoomSpec.selection`: the
trait, the expected bits, the chance it had), shown in "How this world was built".

Two guards keep it honest. Exposure control: each earlier use of a test in the
run multiplies its score by 0.35, so one very informative test doesn't take over.
And a test that ran but moved none of the traits it measures (a countdown left
at a middling time) still counts: on leaving, those traits get a neutral
response (`Profile.neutral`), which firms the estimate up without moving it, so
the scheduler moves on instead of asking the same question again.

`"selection": "weighted"` (or `?select=weighted`) switches back to the old
hand-written `weight(traits)` rules.

## Adding a test

1. Write `kinds/my_test.ts`:

   ```ts
   import type { TestKind } from '../types';

   export const myTest: TestKind = {
     id: 'my_test',
     candidates: [{ archetype: 'hub', exits: [2, 3] }, { archetype: 'l_gallery', exits: 2 }],
     measures: [{ trait: 'curiosity', a: 6, b: 0.5 }],         // what it reveals, for adaptive selection
     weight: (t) => 1 + 2 * Math.max(0, t.curiosity - 0.5),   // optional, for "selection": "weighted"
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

`measures` should name the traits its `profile.adjust` calls move. A test without
`measures` scores as average, so it is drawn about as often as the rest.

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
