/**
 * npm run try:voice                 speak a sample line with ELEVENLABS_VOICE_ID, save it to voice-sample.mp3
 * npm run try:voice -- <voiceId>    try another voice
 * npm run try:voice -- --list       list the voices in your ElevenLabs account
 *
 * Reads ELEVENLABS_API_KEY and ELEVENLABS_MODEL from .env.local.
 */
import { writeFileSync } from 'node:fs';
import { loadProjectEnv } from './env';

loadProjectEnv();
const key = process.env.ELEVENLABS_API_KEY;
const base = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
const model = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const arg = process.argv[2];
const SAMPLE =
  'You waited thirty-one seconds before pressing the button. The building noticed. It has prepared a room for people like you.';

async function main() {
  if (!key) {
    console.error('Set ELEVENLABS_API_KEY in .env.local first (see docs/voice.md).');
    process.exit(1);
  }
  const headers = { 'xi-api-key': key, 'content-type': 'application/json' };
  if (arg === '--list') {
    const res = await fetch(`${base}/v1/voices`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
    for (const v of data.voices) console.log(`${v.voice_id}  ${v.name}  ${Object.values(v.labels ?? {}).join(', ')}`);
    return;
  }
  const voice = arg || process.env.ELEVENLABS_VOICE_ID || 'qxePw1S1QmBgjlU3GIy5';
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text: SAMPLE,
      model_id: model,
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 0.95 },
    }),
  });
  if (!res.ok) {
    console.error(`ElevenLabs answered ${res.status}: ${await res.text()}`);
    console.error(res.status === 401 ? 'Check the API key.' : res.status === 404 ? 'Unknown voice ID: add the voice to "My Voices" in the ElevenLabs app first.' : '');
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync('voice-sample.mp3', buf);
  console.log(`✓ ${voice} with ${model}: ${(performance.now() - t0).toFixed(0)} ms, ${(buf.length / 1024).toFixed(0)} KB → voice-sample.mp3 (open it to listen)`);
  console.log(`  That line cost about ${SAMPLE.length} characters of credit.`);
}

main();
