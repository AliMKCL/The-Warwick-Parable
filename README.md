# whack

A first-person game in which no room exists until you reach it. Each room is
generated from how you have played so far: how long you hesitate, what you
inspect, whether you do what the narrator says. A local language model writes
the room's contents and the narrator's lines; seeded code builds the space.

## Run it (macOS)

You need **Node 22.12 or newer** (`node -v`) and **Ollama 0.30 or newer**.

```bash
# 1. Download the model once (about 23 GB)
ollama pull qwen3.6:35b-a3b

# 2. Local settings (defaults point at Ollama on this Mac)
cp .env.example .env.local

# 3. Install and check the model end to end
npm install
npm run check:llm     # should print ✓ lines and the generation speed

# 4. Play
npm run dev           # then open http://127.0.0.1:5188
```

The model that writes the rooms is chosen in `.env.local` with `MODEL_BACKEND`:
`ollama` (local, offline), `openrouter` (cloud, fastest; needs `OPENROUTER_API_KEY`) or `lmstudio`.
`npm run dev` prints "Rooms written by: …" when it starts. See `docs/speed.md`.

## Controls and options

WASD to move, mouse to look, **E** or click to interact, **M** for sound, Esc to pause. Best with headphones.

Add to the URL: `?seed=123` to replay a run, `?debug=1` for frame rate and room info,
`?post=0` to turn off post-processing, `?dpr=2` for full Retina resolution,
`?observe=8` seconds to watch the player before generating the next rooms,
`?ambience=warm` to see every room in one mood, `?mute=1` to start muted,
`?tests=4&fillers=2&pool=exit_timer,lift_wait` to set the run's layout (see "Run layout" below),
`?rooms=5` for a shorter run (default 7 rooms, counting the first and the finale),
`?layout=lift_lobby,l_gallery` to force room types.

A run ends in the final room: its single door leads to the player's file. Demo notes: `docs/demo.md`.

Writing is in plain files: the world and narrator voice in `data/themes/office.md`,
the prompts in `data/prompts/`, fallback text in `data/templates.json`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Game at http://127.0.0.1:5188 with hot reload |
| `npm run check:llm` | Model server reachable, model installed, JSON output, speed |
| `npm run try:room` | Plays the first room with a scripted player and prints the room the model writes next, with timings |
| `npm run mock:llm` | Fake model server for testing without Ollama (set `LLM_BASE_URL=http://127.0.0.1:11999`) |
| `npm run try:voice` | Speak a sample narrator line with ElevenLabs into `voice-sample.mp3` (see `docs/voice.md`) |
| `npm test` | Core unit tests |
| `npm run typecheck` | Type checks, plus a check that `core/` has no 3D or browser code |
| `npm run build` | Production build into `dist/` |
| `npm run test:e2e` | Browser smoke test (run `npx playwright install chromium` once first) |

## Layout

| Folder | Holds | Ports to Godot? |
| --- | --- | --- |
| `core/` | Everything that decides what happens: story, profile, layout, rules, model client. No Three.js, no browser APIs. | As is |
| `web/` | The Three.js adapter: draws rooms, moves the player, reports what they do | Rewritten |
| `data/` | Prop recipes, room types, rules, prompts, themes | As is |
| `server/` | Optional Node process: cloud-model proxy, Godot sidecar | As is |
| `tools/` | Scripts: model check, asset import, run simulator | As is |
| `tests/` | Core unit tests and browser smoke tests | Core tests as is |
| `docs/` | Progress log | |

See `docs/progress.md` for what is done and what is next, `docs/voice.md` for the narrator voice,
`docs/speed.md` to cut the wait between rooms,
and `CLAUDE.md` for the full project context (written for AI coding sessions, useful for people too).

## Anomaly encounters

Change `MAX_ANOMALIES_PER_RUN` in `core/anomalies/config.ts` to set the maximum
number of distinct anomalies encountered during one run. The default is `6`.
Set it to `0` to disable encounters. Restart the development server or rebuild
a production bundle after changing the value.

The seed and chosen route select from sixteen encounters. An eligible room has
a 65% chance of receiving one, with at most one anomaly per room and an ordinary
room between encounters. Opening and ending rooms stay ordinary. A default
seven-room run therefore has room for up to three encounters. Longer runs can
reach the configured cap. Some encounters also require a compatible rule or
prior choice. Unvisited branches never consume the budget.

The blue door, ceiling cabinet, false exit, numbered footprints, floor meeting,
delayed mirror, queueing plant, borrowed clock, disputed ticket, route copier,
wandering light, hold telephone, weather drawer, permission machine, visit
receipt and moving silhouette each have authored interactions and narrator
responses. Recorded encounters also feed subsequent model narration. These
encounters work with template narration when the model is offline.

The permission machine offers a fold-out break seat for STAY. The copier shows
a textual route record with a second inspection, and the mirror combines a live
reflection with an animated chair silhouette. These fit the existing procedural
wall slots.

## Run layout: test rooms and filler rooms

A run is the waiting room, then a number of **test rooms** (a room running a
test: a countdown, locked doors, a gamble, the lift…) and **filler rooms**
(furnished, inspectable, no test), then the **finale**: a hallway whose far
door glows brighter and warmer than any door before it and leads to the
player's file. Set the counts and the pool of tests in `data/layout.json`:

```json
{ "tests": 5, "fillers": 2,
  "pool": { "exit_timer": 1, "gamble": { "weight": 1, "max": 2 }, "lift_wait": 0.6, "choice": 0.6 } }
```

The order is not fixed: each room is decided as the player reaches it (test or
filler, which test, which of its layouts), weighted by the pool and by how the
player has behaved, and the totals always come out exact. A lost gamble adds
one filler room. URL overrides: `?tests=4&fillers=2&pool=exit_timer,lift_wait`.
`?rooms=N` still works (N rooms in all). Adding a test is one file plus a
registry line: see `core/testrooms/README.md`.

Tests in the pool by default: `exit_timer`, `inspect_to_unlock`,
`lights_dim_on_idle`, `narrator_suggests`, `gamble` (always followed by another
test room, so a won 50/50 has a task to skip; the second gamble of a run is
timed), `lift_wait` (the lift lobby: a lift that never comes and a MAINTENANCE
door as the only way on), `choice` (Kaan's room with a blue **A** and an
orange **B** door; the `door_chosen` event reports the pick), and the seven
office tasks from PR #6, each with its own room and scored when the player
leaves: `balloons`, `coffee`, `canteen`, `renumbered`, `pitch`, `loan`,
`lockdown` (see `core/testrooms/README.md`). To try one on its own:
`?tests=1&fillers=0&pool=balloons`.

L-shaped and U-shaped galleries are room shapes for both filler and test rooms.

`?layout=lift_lobby,l_gallery,u_gallery` forces room types, each in the first
room it fits; a test's own room (the lift lobby, the choice room) makes that
room the test.
