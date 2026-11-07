# Narrator voice (ElevenLabs)

The narrator speaks every line it writes, using ElevenLabs text to speech. Subtitles stay on.
Without a key the game works exactly as before, subtitles only.

## Set it up (about 5 minutes)
1. Make an account at https://elevenlabs.io. The free plan (10,000 credits a month, personal use only)
   is enough to try it and for a few demo runs. Starter ($6/month) adds 30,000 credits and a commercial licence.
2. Create an API key: in the ElevenLabs app, open **Developers → API keys** (or your profile menu → API keys),
   create a key and allow **Text to Speech** (plus **Voices: read** if you want `--list` below). Copy it.
3. Add to `.env.local`:
   ```
   ELEVENLABS_API_KEY=your-key
   ELEVENLABS_VOICE_ID=qxePw1S1QmBgjlU3GIy5
   ELEVENLABS_MODEL=eleven_flash_v2_5
   ```
4. Hear it: `npm run try:voice` writes `voice-sample.mp3` with a sample line. Open it.
   Try other voices with `npm run try:voice -- <voiceId>`; list yours with `npm run try:voice -- --list`.
5. Restart `npm run dev`. The start screen should say **Voice: ElevenLabs (eleven_flash_v2_5)**.

The key stays on your Mac: the browser calls `/tts` on the dev server, which adds the key and forwards
to ElevenLabs. It is never in the page or the build.

## Choosing a voice "like Stanley"
The Stanley Parable narrator is a real actor's voice, so we don't clone or imitate it directly: cloning a
real person's voice needs their consent. Aim for the same qualities instead: an older British
(RP) man, unhurried, dry, faintly amused, quietly judging you.

- **Default: "Older Joe"** (`qxePw1S1QmBgjlU3GIy5`), an older British RP narrator from the voice library,
  in the classic newsreader/documentary style.
- Other library voices worth auditioning: **George** (warm British storyteller), **Julian** (deep, mature
  British, `7p1Ofvcwsv7UBPoFNcpI`), **Alistair** (British narrator, `rvugSNzdY0NcpG2PKe4B`).
  Library voices must be added to **My Voices** in the app before the API can use them.
- **Best match: design your own** with ElevenLabs **Voice Design** (Voices → Create → Voice Design) and a
  prompt like:
  > A middle-aged English man with a refined Received Pronunciation accent, speaking slowly and clearly in a
  > dry, wry, faintly amused tone, like a polite documentary narrator who is quietly judging the listener.
  > Close microphone, studio quality.

  Save it, copy its voice ID into `ELEVENLABS_VOICE_ID`. The result is an original voice in that style.

## Tuning
- `eleven_flash_v2_5` (default) is the fastest and uses about half the credits per character. For a richer,
  more theatrical delivery try `ELEVENLABS_MODEL=eleven_multilingual_v2` (slower, costs more).
- Delivery settings are in `web/audio/voice.ts` (`voice_settings`): stability 0.55, similarity 0.8,
  style 0.15, speed 0.95. Higher stability = flatter and drier; higher style = more dramatic.

## Credits
- A 5-room run speaks roughly 20 to 35 lines, about 2,000 to 3,000 characters. Repeated lines are cached
  and cost nothing.
- `ELEVENLABS_MAX_CHARS` (default 6,000) stops the voice for the rest of a page load once reached, so a
  runaway session can't drain the account. Reload to reset.

## Notes
- The voice needs internet. Offline, lines that fail are simply skipped and the subtitles carry on.
- **M** mutes both the sound and the narrator. The background ducks while the narrator speaks.
- The narrator's live reaction line is spoken after it finishes streaming, so it starts about half a
  second after the subtitle.
