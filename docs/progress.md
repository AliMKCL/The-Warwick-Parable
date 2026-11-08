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

### Faster rooms
- Parallel generation (`PARALLEL_ROOMS`), LM Studio support for Qwen thinking, setup in `docs/speed.md`.

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
