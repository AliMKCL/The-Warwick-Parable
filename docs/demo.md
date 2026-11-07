# Demo guide

## The pitch in one line
**A building that doesn't exist until you walk into it, built from the way you behave.**
Every room is generated the moment you commit to a door: seeded code lays it out, and a local language
model writes everything in it from what you have done so far. At the end, the building hands you its file on you.

## Before you go on (10 minutes before)
- [ ] MacBook on power, Low Power Mode off, other heavy apps closed.
- [ ] Ollama running; `npm run check:llm` prints ✓ lines.
- [ ] `npm run dev`, then open **http://127.0.0.1:5188/?rooms=5** full screen (Ctrl+Cmd+F). Five rooms takes about 4 to 6 minutes.
- [ ] Wait on the start screen until it says **Model: … ready**. The model loads into memory while that screen is up.
- [ ] Headphones or speakers on, volume about half. **M** mutes if the room is loud.
- [ ] Play one full run end to end. If it goes well, note its seed (shown on the dossier) as a backup: `?rooms=5&seed=<that number>` replays the same layouts.
- [ ] Optional: turn Wi-Fi off to show it runs fully offline.
- [ ] Backup: a screen recording of one good run (Cmd+Shift+5 → Record Entire Screen).

## How to play it on stage (about 5 minutes)
1. **Start screen (15 s).** "No room exists until you reach it." Click to begin.
2. **The waiting room (45 s).** There is a button. *Wait* before pressing it, visibly. Read the notice board. That hesitation is being recorded.
3. **Room 1 (60 s).** Point out a sign or screen that mentions what you just did. Inspect two things. If the doors are locked, the room wants your attention; if a countdown starts, it's pressuring a hesitant player.
4. **Rooms 2–3 (90 s).** Linger at one door so the narrator comments, then take a different one. If the narrator recommends a door, ignore it.
5. **The final room → the file (60 s).** Walk through the last door. Read the verdict name aloud. Point at one trait and its evidence ("waited 31 s before pressing the button").
6. **"How this world was built" (30 s).** Show the trait chart moving across rooms, and open one room's notes: this is exactly what the model was told about you when it wrote that room.

## Talking points for judges
- **What's generated:** every room's layout (seeded code, guaranteed playable), and its contents, every piece of text, door names, the narrator's lines, story threads and the final verdict (local model). The prop catalogue, room types and rule mechanics are the fixed building blocks.
- **Why it's coherent:** the model never invents geometry. It picks from a catalogue for named slots, its output is held to a strict schema, and every room is checked for blocked exits before you see it. Story facts and open threads carry from room to room.
- **Why it reacts:** a hidden profile (hesitation, curiosity, compliance, impulsivity) moves only on concrete evidence, and the dossier shows every piece of it. The profile picks the room type, the number of doors, the room's rule and the tone of the writing.
- **Why it's fast enough:** the building watches you for a few seconds in each room, then writes the rooms behind each door in the background, starting with the one you linger at. You only wait if you sprint.
- **Runs on a laptop, offline:** Qwen 3.6 35B-A3B through Ollama on a MacBook. No cloud calls.
- **Engine-free core:** all game logic is plain TypeScript with no 3D code (enforced by a check), so a Godot port only replaces the rendering layer.

## If something goes wrong
| What you see | What to do |
| --- | --- |
| Start screen says the model is not reachable | Start Ollama, reload the page. The game still works with template text. |
| A long "the building is preparing something" pause | The model is slow; it falls back to templates after 15 s. Linger at doors for a few seconds next time. |
| Low frame rate | Add `&post=0` to the URL. |
| The room is too loud / quiet | **M** toggles sound. |
| Anything else | Play the backup recording. |
