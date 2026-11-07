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

Using LM Studio instead of Ollama: start its local server, then set
`LLM_PROVIDER=openai`, `LLM_BASE_URL=http://127.0.0.1:1234` and `LLM_MODEL` to
the name LM Studio shows, in `.env.local`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Game at http://127.0.0.1:5188 with hot reload |
| `npm run check:llm` | Model server reachable, model installed, JSON output, speed |
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

See `docs/progress.md` for what is done and what is next.
