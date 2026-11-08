# Progress log

Read this first when picking up the work. Newest entries at the top.

## Schedule (about 20 hours to submission, set 7 Nov 2026 17:00)

| Phase | Budget | Status |
| --- | --- | --- |
| 1. Setup | 1 h | Done |
| 2. Walking skeleton and look test | 4 h | Done |
| 3. Generation loop | 5 h | Done |
| 4. Profile and story (4 rules) | 3.5 h | Done |
| 5. Look pass (lighting and sound) | 1.5 h | Done |
| 6. Dossier ending and demo prep | 2 h | Done |
| Buffer | 3 h | |

## Decisions

- **No room is written by hand.** Every room, including the fallback used when the model fails, is generated at runtime from the player's behaviour. The fallback uses the seeded layout generator plus text templates, with no model call.
- **Props are data recipes.** Each prop in `data/props/` is a short JSON list of simple shapes (boxes, cylinders) with materials. Both Three.js and Godot can build them, and no downloads are needed. CC0 `.glb` models can replace any recipe later.
- **Model:** Ollama with `qwen3.6:35b-a3b` by default; LM Studio or a cloud API via the `openai` provider. The browser reaches it through the Vite proxy at `/llm`.
- **Engine boundary:** `core/` may not import Three.js, browser APIs or Node built-ins; `npm run typecheck` enforces it.

## Log

### Task scoring connected to the report (PR #7, 8 Nov)
- Merged Abhinav's task scoring layer (`core/director/taskscore.ts`, `docs/scoring.md`). It was written before the office tasks were ported, so it was waiting for results that now arrive: each office task's `TaskResult` becomes 0–1 scores on the start-screen traits (risk, patience, obedience, curiosity) and on measured-only traits (learning, trust, calibration…), with a weight and an evidence line each. "You said / you did" averages them with the ordinary signals; the dossier lists task evidence per trait and an "Also measured" section; telemetry logs one `task_measure` row per measurement.
- Merge fixes: duplicate `TaskResult`/`TaskEvent`/`Run.taskResults` declarations removed; the telemetry recorder had two `case 'task_result'` branches (the second, PR #7's, never ran), now one; the no-tasks golden fixture re-captured on today's run (verified identical with and without the layer).
- New: `tests/core/office-tasks.test.ts` plays the canteen and coffee tasks through to the dossier and checks their scores and evidence appear.

### Consistent walking speed (8 Nov)
- Removed duplicate player and active-room updates from `Game.update`. All rooms and transfer corridors now use one world-space collision update per frame at the existing 2.7 m/s speed; doorway crossings preserve movement and walking cadence. Idle timers and room animations also advance once per frame.
- Dijkstra's edge costs are distances in metres (1 or √2), so they do not change with speed. Path commitment uses actual timestamps, and office-task speed metrics use the player's measured waiting-room baseline.
- Regression checks measure each unobstructed step through complete runs with uneven frame times, including both corridor thresholds and scene rebasing; path analysis verifies unchanged distances and longer travel time at 2.7 m/s.

### Distance fields, path analysis and adaptive test selection (8 Nov)
- **Distance fields** (`core/room/fields.ts`): on entering a room, the walking distance from every floor cell to every exit, around walls and furniture (Dijkstra on the 1 m grid, 8-connected, no corner cutting). Mean 62 µs per room, once.
- **Path analysis** (`core/profile/path.ts`): the 10 Hz position samples, read against the fields: walking up to a door and turning back (reversals), when the player committed to the door they took (deliberation vs. walking time), route efficiency, floor coverage. 0.2 µs per sample, 91× faster than searching per sample. Adds small profile nudges (turned back from doors → hesitation; covered most of the room → curiosity; straight to the door → less curiosity) and one `Path:` line per room for the model. Shown in "How this world was built".
- **Bayesian profile** (`core/profile/bayes.ts`): each trait is now a posterior on a 51-point grid. Evidence nudges are read as 2PL item responses (a nudge of 0.1 = one response), so the first clue moves a trait about as much as before, later ones less, and contradicting clues cancel. `traits` is the posterior mean, so the rest of the game is unchanged; `sd()` is the uncertainty, shown as a ± band on each trait in the dossier.
- **Adaptive test selection** (`schedule.ts` `scoreTests`): every test declares `measures` (2PL items per trait); the scheduler draws in favour of the test with the highest expected information gain, tilted by `focus` (default 4), with exposure control (× 0.35 per earlier use) so one test can't take over. A test that ran without moving any trait it measures gives a neutral response on leaving, so it isn't asked again for nothing. Simulated players: the same accuracy with 3.7 tests instead of 5 (26% fewer rooms), 7% lower error after 5, untested traits 0.06 instead of 0.51 per run; costs variety (265 different 5-test sets per 1000 runs instead of 840). `"selection": "weighted"` / `?select=weighted` restores the old heuristics.
- `npm run bench` prints all of this (runtime, convergence, the focus trade-off). The heuristic weights turned out no more accurate than plain pool weights in the simulation.
- Fixed the corridor merge's HUD mock (it lacked the `ask`/`status` methods added with the office tasks; 6 tests failed on `main`).

### The office tasks from PR #6, in the test pool (8 Nov)
- PR #6 couldn't merge: it was built on the reverted office-task system (`core/tasks`), so it edited files `main` had deleted, and both sides had rewritten the run, protocol and adapter since. Instead its seven tasks are ported onto `main`'s test rooms: balloons, coffee, canteen, renumbered, pitch, loan, lockdown.
- The task modules are unchanged (`core/testrooms/office/`); `adapter.ts` runs each as a test with its own room. Drawn from `pool` in `data/layout.json` like any test, at most once per run each.
- New plumbing they need: 10 Hz position samples and raw input (not stored in the event log), on-screen questions with answers, a status line, scaling/turning/glancing props, sounds, a teleport, the player's baseline from the waiting room, and a `task_result` message (logged by telemetry). Props, materials and wording (`data/tasks.json`) come from the PR. Divyansh's five original office tasks stay out.
- Tests: the PR's bot tests for each task, ported (`tests/core/office-tasks.test.ts`), plus pool tests; `tests/e2e/office-tasks.spec.ts` opens and uses each task in the browser.

### Run layout: test rooms, filler rooms, finale hallway (8 Nov)
- `data/layout.json` sets how many test rooms and filler rooms a run has, and the pool of tests (weights, caps). The order is decided room by room as the player goes (`core/testrooms/schedule.ts`); the totals are always exact. URL: `?tests= ?fillers= ?pool=`; `?rooms=N` still works.
- Tests are pluggable: one `TestKind` file each in `core/testrooms/kinds/` (candidate layouts and door counts, profile weighting, settings, the model's description, runtime behaviour), listed in `registry.ts`. `RuleRuntime` is now a generic host. Replaces `chooseRule`, `gamblePlan`, `choiceRoomFor` and the lift's room-type weight.
- The finale is always a hallway (`finale_hall`) ending in one door that glows brighter and warmer than the rest.
- Gambles are always followed by another test room, so a won gamble no longer skips the last room.
- Tests: 90 unit tests (new `tests/core/layout.test.ts`, including plugging in a new test); e2e checks the finale door.

### Kaan's rooms back, plus the lift lobby (8 Nov)
- Restored Kaan's three commits from the reverted PR #3 on top of PRs #4 and #5: anomalies (`core/anomalies`), messy / upside-down room variants, L and U rooms, and the two-door choice room. Divyansh's office tasks were left out (they replace rooms 1–5).
- The choice room now avoids gamble rooms, the room behind a gamble, and the final room, so a 7-room run has none; it appears in shorter and longer runs.
- New lift lobby: a lift that never comes and a MAINTENANCE door (rule `lift_wait`). At most once per run.
- Fixed: a hub could be the final room and give the finale two doors. Fixed the anomaly browser test, whose `**/llm/**` route also blocked `/core/llm/client.ts`.
- `?layout=` forces room types. 81 unit tests; `tests/e2e/shaped-rooms.spec.ts` and `anomalies.spec.ts` walk the new rooms.

### Dossier fixes: exploration, untested traits, consistent title (8 Nov 2026)
- Exploration is now per room: "You inspected something in 1 of 5 rooms you entered (3 of 14 objects)", scored on the share of rooms. Only rooms the player entered count, and only props placed on purpose (`featured`: the model's chosen slots, or a template room's chosen pieces), not filler desks and partitions. Rooms that required inspecting are left out.
- A trait with no real test this run (e.g. patience with no countdown) shows "You did: not tested this run" in grey with a rough estimate; it has no gap, never gets the red highlight and is never the headline.
- The archetype title and summary are checked against the measured scores; if they contradict a tested score (e.g. "The Patient Applicant" for 1/5 patience), both are rewritten from the measured scores. The "How this world was built" note says when that happened.

### Gambles, required self-ratings and "you said / you did" (8 Nov 2026)
- Start screen: four required 1–5 sliders (I take risks, I am patient, I do what I'm told, I explore everything). Begin stays disabled until all four are set and, when Supabase is configured, consent is ticked.
- Gamble rooms: three per default run (rooms 1, 3, 5), two doors tagged CERTAIN and 50/50. The narrator spells out the stakes before the choice; looking at either door repeats them. The middle gamble has a 15 s clock, after which the 50/50 door locks. The 50/50 is a real coin toss (seeded): shortcut (the next room's task is removed; at the last gamble, the last room is skipped) or setback (one extra detour room). The outcome is announced on arrival.
- Dossier: opens with the biggest gap between the self-rating and measured behaviour in large type ("You said you take risks. You chose the certain door every time."), or "You know yourself well." when no gap is 2 points or more. Below it, each trait with "You said / You did" on 1–5 and one evidence line. Estimates (no test this run) are labelled and never headlined.
- Contradictions: when hesitation and impulsivity (or curiosity and impulsivity) are both high, the two labels are replaced by one sentence from the evidence, e.g. "You wait when the building makes you, and rush when it doesn't."
- Telemetry: gamble choices logged as trait risk, safe|risky, with pressure and `meta.gamble.outcome`; `gamble_offer`, `gamble_expired`, `gamble_result` events; the session profile stores `said_did`, `measured`, `gambles`, `patterns`.

### Play-data collection (Supabase)
- `supabase/schema.sql`: `sessions` and `events` tables, run by hand in the Supabase SQL editor.
- The start screen asks for consent (and optional 1–5 self-ratings on risk, patience, following instructions, exploring) only when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set. Without consent nothing is sent.
- Raw behaviour is logged: room enter/exit, interactions, looks, door hovers, idles, locked doors tried, attempts to go back, tasks (button, inspect-to-unlock, beat the timer) and every choice with latency and its trait. Gameplay is unchanged; the recorder only listens.
- `npm run analyze` prints per-player metrics and population mean and percentiles.

### After Phase 6: context file and narrator voice
- `CLAUDE.md`: everything a new Claude session needs (architecture, how to run and test, workflow, decisions).
- Narrator voice with ElevenLabs, off unless `ELEVENLABS_API_KEY` is set; setup in `docs/voice.md`; `npm run try:voice` to audition voices.

### Phase 6: ending and demo prep (done)
- A run lasts 7 rooms by default (`?rooms=5` for a shorter demo). The final room has one exit, which leads to the player's file instead of another room.
- The dossier: a verdict written by the model (name, summary, one line per trait, closing line; template fallback), each trait's score with the moments that moved it most, the path through the building, story threads and whether they were explained, and stats.
- "How this world was built": a chart of the traits as the player entered each room, and a room-by-room table of layout, seed, model or template, generation time, rule and exactly what the model was told about the player.
- `docs/demo.md`: checklist, a five-minute walkthrough, talking points and what to do if something goes wrong.

### Phase 5: look and sound (done)
- Each mood (cold, warm, sickly, dim) has its own colour grade: tint, contrast, vignette and grain, set in `data/ambience.json`.
- Walls get a faint plaster texture.
- Sound, all synthesised in the browser (no files): fluorescent hum, distant office, or near-silence per mood, crossfading between rooms; the hum drops when the lights dim; footsteps, door latch and swing, locked-door rattle, button click, paper rustle when inspecting, buzz on light flicker, countdown ticks in the last 10 seconds. M toggles sound; `?mute=1` starts muted.
- Debug: `?ambience=warm` draws every room in one mood.

### Phase 4: profile and story (done)
- `core/profile`: four hidden traits (hesitation, curiosity, compliance, impulsivity), starting at 0.5, moved only by clear evidence (time to press the button, inspections, stares, standing still, door hesitation, how fast the player leaves, following or ignoring the narrator), capped per room, every change logged with its reason for the dossier.
- The profile shapes the next rooms: room type weights, number of exits (hesitant players get three, impulsive ones fewer), which rule runs, and the prompt ("Who the player seems to be").
- `core/rules`: four room rules chosen against the player's tendencies, never repeating back to back, none in the first or last room:
  - lights dim when the player stands still, and come back when they move;
  - exits stay locked until the player inspects 2 or 3 things;
  - a 25 to 40 s countdown, after which all exits but one lock (the one they ignored);
  - the narrator recommends a door, sometimes lying; following or ignoring it moves compliance.
- The model writes each rule's lines, plants story threads and pays them off in later rooms; the prompt shows the room number out of 6 and the story stage.
- Adapter: lights fade, doors lock with red and green indicator lights and rattle when tried, a countdown at the top, traits and the latest evidence in the debug panel.
- Tests: 28 unit tests; browser test sees three rules working.

### Phase 3: generation loop (done)
- The model writes each room: title, mood, props and every text on them, inspect text, door labels, the line said when the player hesitates at each door, the entry line, and one fact for the story memory. Prompts are Markdown in `data/prompts/`, the world and narrator voice in `data/themes/office.md`.
- Output is held to a per-room JSON Schema (only real slot, door and prop IDs). Bad answers get one repair round; then templates take over. A server that can't be reached switches the run to templates.
- Pipeline: on entering a room the player is watched for 8 s (or until they linger at a door), then the room behind each exit is generated one at a time, the lingered-at door first. Choosing a door cancels the others and waits up to 15 s, then falls back to templates.
- Live reaction: when the next room is ready, the narrator streams a one-line reaction to the choice and the behaviour in the room just left.
- What the model sees: story so far (titles and facts), and a plain account of what the player did (waits, presses, inspections, stares, standing still, door hesitations and choices).
- Tools: `npm run try:room` runs this against the real model with a scripted player; `npm run mock:llm` is a fake Ollama for testing without a model.
- Tests: fake model covers good, repaired, failing, unreachable and slow answers, door priority and the live reaction; browser test walks 3 model rooms.

### Phase 2: walking skeleton (done)
- `core/room`: room data model, 4 archetypes (waiting room, corridor, open office, hub), seeded layout generator that rotates each room so its entrance matches the door the player came through, slot-based prop placement that drops anything blocking a door or an exit, and a validator.
- `core/run`: a run creates each room only when the player walks through a door. Text comes from `data/templates.json` for now (the model takes over in Phase 3).
- `data/props.json`: 23 props as recipes of simple shapes. `data/materials.json`, `data/ambience.json` (cold, warm, sickly, dim).
- `web/`: room builder (merged walls, floors and ceilings, doors that swing open, light panels, flicker), canvas-drawn text on signs, posters, screens, whiteboards and notes, first-person controls with collision, look-and-press interaction, narrator subtitles, fades, start and pause screen, post-processing (ambient occlusion, bloom, vignette, grain).
- Tests: 1,200 generated rooms checked for playability; a browser test presses the button, inspects a prop and walks through 5 doors.
- URL options: `?seed=123`, `?debug=1`, `?post=0`, `?dpr=2`.

### Phase 1: setup (done)
- Project structure, Vite + TypeScript + Three.js 0.187, Vitest, Playwright.
- `core/llm`: model client for Ollama and OpenAI-compatible servers, schema-constrained JSON, thinking off, timing.
- `npm run check:llm`: end-to-end model check with speed report.
- Setup scene: a lit waiting room with a pedestal and button, plus status for renderer and model server.
- Verified in Claude's workspace: unit tests (8), type checks, core purity check, production build, browser render test.
- Not yet verified on the MacBook: `npm install`, the model check, the scene in Safari or Chrome.
