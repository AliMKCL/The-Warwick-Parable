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
`?rooms=5` for a shorter run (default 7 rooms, counting the first),
`?layout=lift_lobby,l_gallery` to force room types (see "The lift lobby" below).

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

## Room layouts and the Choice Room

L-shaped galleries turn around one corner. U-shaped galleries have two wings
joined by a passage around a central wall. Both rotate to match the arrival
direction and use the same prop placement and exit checks as other rooms.

Each run schedules at most one `choice_room` after the opening, using the run
seed. The location is shared by every route. It never takes a gamble room, the
room behind a gamble (that room needs a task for a won 50/50 to skip) or the
final room (the finale is written by the model), so a normal 7-room run, whose
gambles are in rooms 1, 3 and 5, has none; shorter (`?rooms=3`, `?rooms=4`)
and longer (`?rooms=10`) runs do. Its two exits have stable IDs and markings,
blue **A** (`d1`) and orange **B** (`d2`). The existing `door_chosen` event
reports the player's selection.

## The lift lobby

A lift faces the player as they enter, with a call button beside it, and a
door labelled MAINTENANCE in a side wall is the only way on (the model cannot
rename it). The lift never comes: its floor indicator creeps down and stalls
(rule `lift_wait`), and the narrator hints at another way after 45–70 s.
Pressing the call button five times reads as impulsive, finding the door alone
as decisive, waiting for the hint as hesitant. At most once per run; never a
gamble room or the final room; no messy/ceiling variant or anomaly on top.

`?layout=lift_lobby,l_gallery,u_gallery` forces room types, each in the first
room it fits (room 1 is a gamble room in a normal run, so a forced lift lobby
comes after it).
