# Task scoring

How the office tasks' results become trait scores, how those meet the
start-screen sliders, and where they end up. Code: `core/director/taskscore.ts`
(the table), `core/director/selfcheck.ts` (`measure`, `compareSelf`).

## What a task reports

Each task reports one `TaskResult` when it finishes (the `task_result` core
message, defined in `core/protocol.ts`, same shape as on the office-tasks
branch):

```ts
{ task: 'lift', room: 2, title: '…', params: { timeout: 90, … },
  metrics: { seconds_waited: 47, button_presses: 3, … },   // number | null
  notes: ['…'], version?: 'office' | 'mine' }               // version absent = office
```

Tasks 1–5 (`core/tasks/metrics.ts`) and tasks 6–11 (`core/tasks/office/*`, via
`core/tasks/score.ts`) all use this format. Tasks put a metric at `null` when
they had nothing to measure it from. Scoring reads only `metrics` and `params`,
so a session can be rescored later from its stored results.

## From result to trait

Each entry in `TASKS` turns one result into one value from 0 to 1 per trait it
feeds (higher = more of the trait), plus a weight and one evidence sentence.
A rule that needs a `null` or missing metric gives **no measurement**, never 0.
Adding a task means adding one entry. Office and mine versions are scored the
same way, and the version is recorded.

Slider traits and their code names:

| Slider | Code name |
|---|---|
| "I take risks" | `risk` |
| "I am patient" | `patience` |
| "I do what I'm told" (obedience) | `social` |
| "I explore everything" (curiosity) | `exploration` |

## The tasks

| # | Task (office / mine) | Status | Trait | Rule (0..1) | Weight | Evidence | Research basis |
|---|---|---|---|---|---|---|---|
| 1 | Two Doors | ready | obedience | `compliance` 1 → 1, 0 → 0; complied after `forbidden_approaches` > 0 → 0.5 | 2 | `compliance_latency` | Brehm (1966), psychological reactance |
| 2 | The Lift That Never Comes | ready | patience | `seconds_waited`: < 10 s → 0, 10–30 → 0.25, 30–60 → 0.5, 60–89 → 0.75, reached the hint (`timeout`, 90 s, or `self_rescue` 0) → 1. Bands in `LIFT_PATIENCE_BANDS`, **provisional until calibrated on real player data** | 2 | `button_presses`, `restlessness` | Frustration tolerance (Amsel 1958; Harrington 2005) |
| 3 | The Abandoned Desk | ready | curiosity | `items_inspected` (0–1) | 2 | `reading_depth` | Need for cognition (Cacioppo & Petty 1982) |
| 4 | Late for the Meeting | ready | helpfulness *(measured only)* | `helped` 1 → 1; `abandoned_midway` or `came_back` → 0.5; else 0. Not asked (`helped` null) → nothing | 1 | `clock_at_help` | Darley & Batson (1973), "From Jerusalem to Jericho" |
| 5 | The Smoky Corridor | ready | obedience, **reversed**, only when `crowd` = 1 | `kept_on_task` 1 → 1 (went along with the others); `raised_alarm`, or acting on the smoke first (fire exit, vent) → 0. With `crowd` = 0 it is recorded, not scored | 2 | Says it measures going along with others, not following instructions | Latané & Darley (1968), smoke-filled room |
| 6 | Party balloons / ore drill | ready (office) | risk | `adjusted_avg_pumps` / `maxPumps` (mean pumps on balloons that didn't pop, as a share of the maximum) | 2 | `post_loss_shift` (reaction to losses) | Lejuez et al. (2002), BART |
| 7 | Coffee machines / tunnels | ready (office) | learning *(measured only)*; obedience | learning: 1 − `advice_reliance` (share of the last 5 picks from a good machine). Obedience: `advice_reliance` | 1, 1 | picks from the good machines / from the recommended one | Bechara et al. (1994), Iowa Gambling Task |
| 8 | Canteen queue / lamp oil | ready (office) | patience | `later_share` (share of "wait for the bigger reward" choices) | 2 | waits out of offers, `abandon_rate` | Delay discounting (Mazur 1987; Kirby & Maraković 1996) |
| 9 | Renumbered floor / chalk arrows | ready (office) | adaptability *(measured only)* | 1 / (1 + `perseverative_errors`) | 1 | `junctions_to_adapt` | Wisconsin Card Sorting Test (Grant & Berg 1948; Heaton 1981) |
| 10a | The pitch / cart jump | ready (office) | calibration *(measured only)* | 1 − \|`overconfidence`\| (mean confidence − success rate) | 1 | `mean_confidence`, `success_rate` | Calibration (Lichtenstein, Fischhoff & Phillips 1982; Moore & Healy 2008) |
| 10b | Token loan / stranded miner | ready (office) | trust; trustworthiness *(both measured only)* | trust: `initial_trust` (share lent in round 1); trustworthiness: `trustworthiness` (share returned) | 1, 1 | tokens lent, share returned | Berg, Dickhaut & McCabe (1995), trust game |
| 11 | Lockdown drill | ready (office) | coping with boredom *(measured only)* | `time_to_first_buzz` / `lock_seconds`; never pressed → 1 | 1 | lock length, presses | Wilson et al. (2014), "Just think" |

None of tasks 6–11 is in the default run yet (only `?try=` on office-tasks).
The mine versions don't exist yet. Their results will score the same way once
they report `version: 'mine'`.

## Combining into a slider score

Per slider trait, the score is the **weighted average of every measurement this
run**, mapped to 1–5 (`1 + 4 × share`):

- **Ordinary signals weigh 1 each:** every gamble (risk), countdown (patience),
  button room or narrator recommendation (obedience), and room with something
  to inspect (curiosity).
- **Each task measurement carries its own weight** (table above).
- **Desk room not double-counted:** a room a task already scores for curiosity
  isn't also counted as an ordinary inspecting room.
- **Task scores are real measurements, not estimates.** A trait with no
  measurement at all stays "not tested this run": its rough estimate from the
  hidden profile is shown in grey, but it is never a gap and never the
  headline.
- **One observation:** a trait resting on a single yes/no moment is labelled
  "(one observation)". It is never the headline or a highlighted gap. The
  headline needs 2+ measurements or 1 graded one (a time or a share, e.g. the
  lift).
- **Headline evidence:** the headline quotes the source that supports its
  direction: the lowest-scoring one for "less than you said", the highest for
  "more".
- **No change before the tasks arrive:** with no task results in the run, all
  of the above is skipped and the output is exactly as before
  (`tests/core/fixtures/no-tasks-golden.json` proves it). The one-observation
  rule therefore only applies in runs where a task has reported.

Measured-only traits (helpfulness, learning, adaptability, calibration, trust,
trustworthiness, coping with boredom) have no slider, so they get no said/did
comparison. They are shown under "Also measured" in the dossier.

## Where it goes

- **Dossier (`web/ui/dossier.ts`)**
  - Each slider row lists its task evidence lines.
  - "Also measured" lists the traits with no slider.
  - Nothing new appears until a task reports.
- **Supabase, `events`:** one `task_measure` row per measurement.
  - Columns: `trait` = the trait, `choice` = the task id.
  - `meta`: task, version, `task_room`, `value`, `weight`, `graded`, `counts`, `evidence`, raw `metrics`, `params`, `notes`.
  - A result that measured nothing still gets one row, with `trait` null.
- **Supabase, `sessions.profile.scoring`:**
  - per slider trait: score, n, `not_tested`, `one_observation`, the ordinary part, each task measurement, evidence lines
  - `also_measured`
  - every `task_measures` entry, including recorded-only ones
  - No schema change.
- **`npm run analyze`:**
  - prints every task measurement, a per-task summary, and the lift waits (to calibrate the bands)
  - adds `task_<trait>` (0..1) and `score_<trait>` (1–5) columns per player

## Wiring in a task (checklist)

1. **Report the result.** The task emits a `TaskResult` through `task_result`, and the run pushes it to `Run.taskResults`. Use `Run.finalTaskResults()` when results need rescoring at the end, as on office-tasks.
2. **Add or check its entry in `TASKS`.**
   - Metric names must match what the scorer outputs.
   - Set `status: 'ready'`.
   - Add `'mine'` to `versions` if it has a mine version, and report `version: 'mine'` from it.
3. **Add a fake result** in its exact format to `tests/core/taskscore.test.ts` and test the rule, including all-null metrics.
4. **New measured-only trait?** Add it to `MeasuredOnlyTrait` (`core/protocol.ts`), to `MEASURED_ONLY_LABELS`, and to `MEASURED_ONLY` in `tools/analysis/tasks.ts`.
5. **Run `npm run typecheck && npm test`.**
