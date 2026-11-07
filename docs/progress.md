# Progress log

Read this first when picking up the work. Newest entries at the top.

## Schedule (about 20 hours to submission, set 7 Nov 2026 17:00)

| Phase | Budget | Status |
| --- | --- | --- |
| 1. Setup | 1 h | Done |
| 2. Walking skeleton and look test | 4 h | Next |
| 3. Generation loop | 5 h | |
| 4. Profile and story (4 rules) | 3.5 h | |
| 5. Look pass (lighting only) | 1.5 h | |
| 6. Dossier ending and demo prep | 2 h | |
| Buffer | 3 h | |

## Decisions

- **No room is written by hand.** Every room, including the fallback used when the model fails, is generated at runtime from the player's behaviour. The fallback uses the seeded layout generator plus text templates, with no model call.
- **Props are data recipes.** Each prop in `data/props/` is a short JSON list of simple shapes (boxes, cylinders) with materials. Both Three.js and Godot can build them, and no downloads are needed. CC0 `.glb` models can replace any recipe later.
- **Model:** Ollama with `qwen3.6:35b-a3b` by default; LM Studio or a cloud API via the `openai` provider. The browser reaches it through the Vite proxy at `/llm`.
- **Engine boundary:** `core/` may not import Three.js, browser APIs or Node built-ins; `npm run typecheck` enforces it.

## Log

### Phase 1: setup (done)
- Project structure, Vite + TypeScript + Three.js 0.187, Vitest, Playwright.
- `core/llm`: model client for Ollama and OpenAI-compatible servers, schema-constrained JSON, thinking off, timing.
- `npm run check:llm`: end-to-end model check with speed report.
- Setup scene: a lit waiting room with a pedestal and button, plus status for renderer and model server.
- Verified in Claude's workspace: unit tests (8), type checks, core purity check, production build, browser render test.
- Not yet verified on the MacBook: `npm install`, the model check, the scene in Safari or Chrome.
