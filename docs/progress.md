# Progress log

Read this first when picking up the work. Newest entries at the top.

## Schedule (about 20 hours to submission, set 7 Nov 2026 17:00)

| Phase | Budget | Status |
| --- | --- | --- |
| 1. Setup | 1 h | Done |
| 2. Walking skeleton and look test | 4 h | Done |
| 3. Generation loop | 5 h | Done, awaiting a real-model run on the MacBook |
| 4. Profile and story (4 rules) | 3.5 h | Next |
| 5. Look pass (lighting only) | 1.5 h | |
| 6. Dossier ending and demo prep | 2 h | |
| Buffer | 3 h | |

## Decisions

- **No room is written by hand.** Every room, including the fallback used when the model fails, is generated at runtime from the player's behaviour. The fallback uses the seeded layout generator plus text templates, with no model call.
- **Props are data recipes.** Each prop in `data/props/` is a short JSON list of simple shapes (boxes, cylinders) with materials. Both Three.js and Godot can build them, and no downloads are needed. CC0 `.glb` models can replace any recipe later.
- **Model:** Ollama with `qwen3.6:35b-a3b` by default; LM Studio or a cloud API via the `openai` provider. The browser reaches it through the Vite proxy at `/llm`.
- **Engine boundary:** `core/` may not import Three.js, browser APIs or Node built-ins; `npm run typecheck` enforces it.

## Log

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
