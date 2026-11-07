# Faster rooms: parallel generation and LM Studio

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

## Which to keep
Pick whichever makes `try:room` finish all doors soonest. For 2–3 doors, three rooms in parallel usually beats
one faster room at a time; MLX with parallel is best if your LM Studio offers it.
