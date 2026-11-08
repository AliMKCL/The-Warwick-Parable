# whack: context for Claude sessions

Hackathon entry for the track "New Worlds" (about 20 h build, submission due Sun 8 Nov 2026).
A first-person 3D game in the browser where **no room exists until the player reaches it**: seeded code
lays out each room, and a local LLM writes everything in it from how the player has behaved. The run
ends with a personnel-file "dossier" of what the building learned about the player.

Read `docs/progress.md` (live log and decisions) and `docs/demo.md` (demo checklist) before changing anything.
The original design plan is the Claude doc "Procedural Narrative Game — Build Plan"
(https://claude.ai/artifact/Bz3XUUfRhY57MbsegkUM78); where it differs from this file, this file wins.

## People and machine
- Owner: Ali (GitHub AliMKCL, repo https://github.com/AliMKCL/whack). Nobody on the team writes code; Claude does all of it.
- Runs on Ali's MacBook Pro M5 Pro, 64 GB. Project folder: `/Users/alimuratkeceli/Desktop/Projects/Hackaton/whack`.
- Model: Ollama with `qwen3.6:35b-a3b` (works; `npm run check:llm` passes). Speed is acceptable; Ali will optimise later.
- Ali asked to pause after each phase for input. Keep doing that for larger pieces of work.

## Run and test
```
cp .env.example .env.local      # LLM_PROVIDER, LLM_BASE_URL, LLM_MODEL (+ ElevenLabs keys if used)
npm install
npm run check:llm               # model reachable, JSON output, speed
npm run try:room                # scripted player + real model: prints the next room, rule, profile, narrator lines
npm run dev                     # http://127.0.0.1:5188  (?debug=1 ?seed= ?rooms=5 ?post=0 ?ambience= ?mute=1 ?observe=)
npm test                        # vitest: core + telemetry (50 tests)
npm run typecheck               # tsc for web + core, plus core purity check
npm run test:e2e                # Playwright; see "Working from Claude's sandbox" below
npm run mock:llm                # fake Ollama + fake ElevenLabs on :11999
npm run try:voice               # ElevenLabs sample line → voice-sample.mp3 (-- <voiceId> | --list)
npm run analyze                 # Supabase play data → per-player metrics + population stats (-- --all --json f --csv f)
```

## Architecture (the rule that matters most)
- `core/` is engine-free TypeScript: no `three`, no DOM types, no Node built-ins. `core/tsconfig.json` has
  `lib: ES2022` only and `tools/check-core-purity.mjs` fails the typecheck on banned imports. Timers, fetch,
  AbortController and TextDecoder are reached through `globalThis` casts or injected deps.
  This keeps a Godot fallback cheap: core can run as a Node sidecar behind a WebSocket; only `web/` would be rewritten.
- Core and adapter talk only through JSON messages in `core/protocol.ts`:
  adapter → core `GameEvent` (room_entered, looked_at, inspected, pressed, door_hovered, door_chosen, door_tried,
  idle, motion, run_started); core → adapter `CoreMessage` (load_room, narrator_line [streamed, lineId + final],
  gen_status, rule_effect, profile, run_ended).
- `web/` is the Three.js adapter. It draws RoomSpecs and reports events; it never decides game logic.
- `data/` is engine-neutral content the team can edit: `props.json` (23 props as recipes of boxes/cylinders/
  spheres/cones), `materials.json`, `ambience.json` (cold/warm/sickly/dim incl. colour grade), `templates.json`
  (fallback text and rule lines), `prompts/*.md` (model prompts with {{placeholders}}), `themes/office.md`
  (world bible + narrator voice guide). Browser loads `.md` via `?raw`; Node tools use `tools/data-node.ts`.

## Core modules
- `core/room/`: types (RoomSpec, Layout, PropRecipe…), `layouts.ts` (4 archetypes: waiting_room, corridor,
  open_office, hub; built with the entrance on the south wall, then rotated so it matches the door the player
  came through), `place.ts` (slot placement that drops anything that collides, covers a door or cuts off an
  exit), `validate.ts`, `templates.ts` (fallback furnishing and text). 1 m grid; prop front faces +z.
- `core/run/run.ts`: the Run. On entering a room it plans the room behind each exit (layout immediately),
  watches the player for `observeMs` (8 s, or until they linger at a door), then generates content for one
  exit at a time, lingered-at door first. Choosing a door cancels the others, waits up to 15 s, else templates.
  Room 0 is always the template waiting room with the button. Final room (index runLength-1) has one exit
  and no plans; going through it ends the run.
- `core/run/core.ts`: the CorePort. Streams a live narrator reaction on door choice (only when the next room
  is already ready), says the entry line, starts the room's rule after the entry line has been read, and on
  the final door writes the verdict and emits `run_ended`.
- `core/director/selfcheck.ts`: `measure` (risk from gambles, patience from countdowns or time per room, social from
  the button and narrator recommendations, exploration from share inspected; 1–5 with one evidence line; `estimated`
  when there was no test), `compareSelf` (said vs did, headline = biggest gap of 2+ on measured traits, else
  "You know yourself well."), `findPatterns` (hesitant+impulsive or curious+impulsive → one sentence).
- `core/director/`: `content.ts` (picks up to 8 slots for the model, builds messages, schema-constrained call,
  one repair round), `schema.ts` (per-room JSON Schema: enums of real slot/prop/door/thread ids), `summary.ts`
  (events → plain sentences), `prompts.ts` (fill, story stages, RUN_LENGTH=7), `dossier.ts` (verdict + Dossier).
- `core/profile/profile.ts`: traits hesitation/curiosity/compliance/impulsivity, start 0.5, moved only by
  evidence with per-room caps; every change logged with a reason (shown in the dossier and sent to the model).
- `core/rules/rules.ts`: lights_dim_on_idle, inspect_to_unlock, exit_timer, narrator_suggests (may lie), gamble.
  Chosen against the player's tendencies, never repeated back to back, none in the first or last room.
  Gambles are placed by `gamblePlan` in `run.ts`, not chosen: 3 rooms in a 7-room run (1, 3, 5; never adjacent;
  none in runs of 4 rooms or fewer), the middle one on a 15 s clock that then locks the 50/50 door. Two exits, labels
  tagged "· CERTAIN" / "· 50/50", stakes always from templates (`params.stakes`). The coin is tossed from the seed when
  the room is planned. Certain = next room as planned (always has a task); 50/50 = shortcut (next room's task removed;
  before the last room, skips it and ends the run) or setback (a detour room: `run.last` grows by one).
  `RuleRuntime.start(t, history)` picks up current state (e.g. already standing still).
- `core/llm/client.ts`: Ollama native API (`format` = schema, `think:false`, `keep_alive`) or OpenAI-compatible
  (`response_format: json_schema`); `completeJson`, `streamText`, `ping`. Errors are typed: unreachable / http /
  bad_output / aborted. An unreachable server switches the whole run to templates.

## Web adapter
- `web/game.ts` orchestrates; `web/room/buildRoom.ts` (merged walls/floor/ceiling, doors with swing, lock
  indicator lights, light panels, flicker, dimming), `buildProp.ts`, `textTexture.ts` (canvas text by style),
  `materials.ts`; `web/player/player.ts` (pointer-lock FPS, circle-vs-box collision, `standingFor`, `stepped`);
  `web/render/post.ts` (GTAO, bloom on panels only, finish shader with per-mood grade);
  `web/audio/sound.ts` (everything synthesised with Web Audio, no files); `web/ui/hud.ts` (subtitle queue with
  streaming, timer, waiting text), `web/ui/dossier.ts` (ending + "How this world was built").
- The browser reaches the model through the Vite proxy `/llm` → `LLM_BASE_URL` (no CORS issues, no keys in the bundle).
- Narrator voice: `web/audio/voice.ts` posts final narrator lines to `/tts`; the Vite proxy rewrites to
  ElevenLabs `/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream` and adds `xi-api-key` server-side. Off when
  `ELEVENLABS_API_KEY` is empty. Cached by text, queued (max 2 waiting), capped by `ELEVENLABS_MAX_CHARS`,
  ducks the ambience; plays through the shared Web Audio context (Safari-safe); on 402/403/404 falls back to
  built-in George (`JBFqnCBsd6RMkjVDRZzb`). Ali uses voice `pqHfZKP75CvOlQylNhV4` (confirmed working with try:voice).
  Free plan refuses voice-library voices via the API. Model `eleven_flash_v2_5`.
  Do not clone the Stanley Parable actor's voice (no consent); use a library voice or Voice Design. See `docs/voice.md`.
  E2E: `tests/e2e/voice.spec.ts` with `ELEVENLABS_API_KEY=test ELEVENLABS_BASE_URL=http://127.0.0.1:11999` and the mock running.
- Play-data telemetry (Supabase, `supabase/schema.sql`): `web/telemetry/telemetry.ts` (startSession/logEvent/endSession,
  batched, never throws, warns and does nothing when `VITE_SUPABASE_*` is unset or unreachable) and `recorder.ts`, which
  listens through `Game.tap` (events to core, messages from core, clicks) and logs raw rows. Choices carry trait/trait_value
  (risk, patience, social, exploration); pressure (timer or narrator recommendation) is in `meta`. Only with the start
  screen consent box ticked. The four 1–5 self-rating sliders are required to begin (consent too, when Supabase
  is configured) and travel to core in `run_started.selfRatings`. Gamble choices are tagged risk safe|risky with
  `meta.gamble` {timed, expired, outcome}. The session `profile` column holds `said_did`, `measured`, `gambles`, `patterns`. Analysis in `tools/analyze.ts` + `tools/analysis/metrics.ts`.
- `window.__WHACK__` test hooks: begin (`{ telemetry: selfRatings }` to record, `{ selfRatings }` for the dossier only), state, lookFrom, useDoor, interact, effect, soundCheck.

## Working from Claude's sandbox (cloud sessions)
- The device shell (`mcp__remote-devices__device_bash`) is a **Linux VM** on Ali's Mac, not macOS: it can't
  reach the Mac's Ollama on localhost, and `npm install` there would fetch Linux binaries. Ali runs the game natively.
- Workflow used so far: develop and test in the cloud workspace (`/home/claude/whack`, which may not survive
  a new session: re-create it by staging the repo from the Mac folder or cloning GitHub), then tar the source
  (excluding node_modules, dist, test-results, artifacts), `device_commit_files` it into `.sync/` in the Mac
  folder, untar in the VM, delete `.sync`, and `git commit` there with author AliMKCL. Deleting in that folder
  needs `device_request_delete_permission` once per session (git needs it for lock files).
  Commits are local; Ali pushes. Do not push without asking.
- Cloud workspace has `/usr/bin/google-chrome` but no GPU: run Playwright with `CHROME_PATH=/usr/bin/google-chrome`,
  and use `post=0` in URLs for speed (about 1 fps with post-processing). kenney.nl and other asset sites are blocked.
- Package-lock includes the darwin-arm64 optional binaries, so Ali's `npm install` works.

## Decisions worth keeping
- No hand-written rooms, ever (track theme). Fallbacks are generated too (layout generator + templates).
- Props are JSON recipes, not downloaded models; any recipe could later be swapped for a CC0 .glb.
- Three.js over Unity/Godot: nobody knows an engine, and Claude can build and test everything in code.
- Model never makes geometry; it fills named slots from a catalogue, under a strict schema; placement re-validates.
- Narrator voice: dry, observant, never cruel, never mentions AI (see `data/themes/office.md`).

## Status (7 Nov 2026, 22:00)
All six planned phases are done and committed locally in Ali's folder (Phase 6 = 2782ea9), plus this file
and the ElevenLabs voice. Nothing has been pushed to GitHub yet. Real-model runs so far: `check:llm` passed
on the Mac; Ali said generation speed is fine for now. Not yet confirmed by Ali: a full real-model run to the
dossier, the sound mix, the voice with a real key.

## Possible next steps
- Performance: generation speed with the real model, `OLLAMA_NUM_PARALLEL`, smaller model fallback.
- Content: more props/rules, a second visual kit, Godot port only if the look is rejected.
