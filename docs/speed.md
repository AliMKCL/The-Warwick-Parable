# Faster rooms: parallel generation, MLX, LM Studio and cloud

Most of the wait after a door comes from rooms being generated one after another. The game can now
generate the rooms behind all of a room's doors **at the same time**. The game side is one setting,
`LLM_PARALLEL` in `.env.local`; the model server has to allow parallel requests too.

Check the effect with `http://127.0.0.1:5188/?debug=1`: the panel shows `model on ×3` and, when it works,
every door says `generating` together and finishes at about the same time.

## A. Parallel with Ollama (try this first, 2 minutes)
1. Tell the Ollama app to accept 3 requests at once (the app ignores `export` lines in your shell):
   ```
   launchctl setenv OLLAMA_NUM_PARALLEL 3
   ```
2. Quit Ollama from the menu bar and open it again.
3. In `.env.local`: `LLM_PARALLEL=3`. Restart `npm run dev`.
4. Check it really runs in parallel: `npm run try:room` prints `Generating 3 room(s) at a time` and each door's time.
   If all doors take about the same time, it works. If the times grow (e.g. 6 s, 12 s, 18 s), Ollama is still
   running them one by one. On Apple Silicon some model types are run one at a time regardless of the setting;
   the server log says so: `grep -i parallel ~/.ollama/logs/server.log | tail`. Then use LM Studio (B).

To undo: `launchctl unsetenv OLLAMA_NUM_PARALLEL`, restart Ollama, set `LLM_PARALLEL=1`.

## B. LM Studio (faster engine on Apple Silicon, about 20 minutes incl. download)
1. Install LM Studio 0.4 or newer from https://lmstudio.ai and open it.
2. **Download the model**: search `Qwen3.6 35B A3B` and pick **lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit**
   (MLX is Apple's own engine, usually 30–40% faster on M-series chips). About 20 GB.
3. **Quit Ollama** (menu bar → Quit) so two copies of the model don't share your 64 GB.
4. **Load it with the right settings**: Developer tab (or the model picker) → select the model →
   turn on *Manually choose model load parameters* → *Show advanced settings*:
   - **Context length**: 8192 is plenty (a room prompt is about 3,000 tokens).
   - **Max Concurrent Predictions**: 3. If this option is not offered for the MLX model, parallel isn't
     available for MLX in your LM Studio version: either keep `LLM_PARALLEL=1` (MLX alone is already faster),
     or download the GGUF version instead (`Qwen3.6-35B-A3B` Q4_K_M), which supports parallel.
   - **Thinking / reasoning**: off, if the model shows that toggle. The game also asks the server to skip
     thinking on every request; thinking makes rooms several times slower.
5. **Start the server**: Developer tab → *Start server* (port 1234). Copy the model's **API identifier**
   shown there (something like `qwen3.6-35b-a3b-mlx`).
6. **Point the game at it**, in `.env.local`:
   ```
   LLM_PROVIDER=openai
   LLM_BASE_URL=http://127.0.0.1:1234
   LLM_MODEL=<the API identifier>
   LLM_PARALLEL=3        # or 1 if Max Concurrent Predictions wasn't available
   ```
7. **Measure**: `npm run check:llm` (compare tokens/s with your Ollama numbers), then `npm run try:room`.
   Restart `npm run dev` and watch `?debug=1`.

If `check:llm` says the JSON is missing fields, thinking is still on: switch it off in the model settings.

To go back to Ollama, restore the three Ollama lines in `.env.local` (see `.env.example`).

## C. Cloud through OpenRouter (fastest, needs internet)
Hosted servers run the same model on much faster hardware and handle parallel requests, so every door's room
is generated at once in a few seconds, and your Mac's GPU is left to the rendering.

1. Make an account at https://openrouter.ai, add a little credit (a few dollars lasts a long time for this
   model), and create an API key under **Keys**.
2. In `.env.local`:
   ```
   LLM_PROVIDER=openai
   LLM_BASE_URL=https://openrouter.ai/api
   LLM_MODEL=qwen/qwen3.6-35b-a3b
   LLM_API_KEY=sk-or-...
   LLM_PARALLEL=3
   ```
   Same model as locally, so the writing stays the same; only the speed changes.
3. `npm run check:llm`, then `npm run try:room`, then restart `npm run dev`.

What the game does for you: the key is added by the dev server (never in the browser); every request asks
OpenRouter to use only providers that enforce the room's JSON format (`require_parameters`) and to switch the
model's reasoning off. If the internet drops mid-demo, rooms fall back to templates; switch the five lines back
to Ollama to run offline.

**Free models (`:free` IDs)** work too, but are a poor fit for a live demo: 20 requests a minute and only 50 a day
unless you have bought at least $10 of credit (then 1,000 a day). One run uses about 30 to 40 requests (up to three
rooms per doorway, plus narrator lines and the verdict), so 50 a day is one or two runs. They are also throttled at
busy times, can disappear without notice, and not all of them enforce JSON formats.

**Bigger models** write a little better but are usually slower per room, and speed is the goal here. Any OpenRouter
model ID works in `LLM_MODEL` if you want to compare; check it lists "structured outputs" on its model page.

## Which to keep
Pick whichever makes `try:room` finish all doors soonest. With good internet, the cloud (C) will usually win;
keep Ollama as the offline backup. For 2–3 doors, three rooms in parallel usually beats
one faster room at a time; MLX with parallel is best if your LM Studio offers it.
