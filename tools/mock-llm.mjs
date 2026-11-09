// A fake Ollama server for testing without a model: `npm run mock:llm`, then
// set LLM_BASE_URL=http://127.0.0.1:11999 in .env.local. It answers room
// requests by reading the prompt (slot IDs, allowed props, door IDs) and
// streams narrator lines word by word. Delay with MOCK_DELAY_MS (default 1500).
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 11999);
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 1500);
let n = 0;
let ttsCalls = 0;
const stats = { openai: 0, auth: null, reasoning: null, provider: null };
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

function roomContent(prompt) {
  n++;
  const slots = [...prompt.matchAll(/^- (s\d+): .*Allowed: (.+)$/gm)].map((m) => ({ slot: m[1], props: m[2].split(', ') }));
  const doors = [...prompt.matchAll(/^- (d\d+): on the/gm)].map((m) => m[1]);
  const waited = /Did nothing for (\d+) s/.exec(prompt)?.[1];
  return {
    title: pick(['Hall of Pauses', 'The Second Lobby', 'Records of You', 'Quiet Floor']) + ` ${n}`,
    ambience: pick(['cold', 'warm', 'sickly', 'dim']),
    slots: slots.map((s) => ({
      slot: s.slot,
      prop: pick(s.props),
      text: pick(['YOU ARE LATE', 'HESITATION\nLOGGED', waited ? `${waited} SECONDS` : 'WELCOME BACK', 'KEEP GOING']),
      inspect: pick(['It has your handwriting on it.', 'Someone filed this under your name.', 'It was here before you were.']),
    })),
    doors: doors.map((d, i) => ({ door: d, label: pick(['STAFF', 'ARCHIVE', 'YOU', 'LATER', 'EXIT']) + (i ? '' : ''), line: 'That one? Bold.' })),
    suggest_door: /recommends one exit/.test(prompt) ? doors[0] : undefined,
    rule_line: /# This room's rule\nNone/.test(prompt) ? '' : pick(['The doors are shy today. Look around.', 'Stand still and see what happens.', 'Clock is ticking.', 'Take the first door. Trust me.']),
    rule_done_line: /# This room's rule\nNone/.test(prompt) ? '' : 'There. Happy now?',
    narrator_enter: waited ? `You waited ${waited} seconds back there. This room waited longer.` : 'Another room, built just for you.',
    thread_plant: pick(['', 'A badge with your photo, but not your name.', 'A meeting scheduled for you, in a room that does not exist yet.']),
    thread_resolve: /^- (t\d+):/m.exec(prompt)?.[1] ?? 'none',
    fact: `Room ${n} keeps a copy of everything you read.`,
  };
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json');
    // Like the real services, accept calls from a web page (players' own keys on the published site).
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, xi-api-key, accept');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.url.startsWith('/v1/text-to-speech/')) {
      // Fake ElevenLabs: half a second of silence as WAV, and a check that the key arrived.
      if (!req.headers['xi-api-key']) { res.statusCode = 401; return res.end('{"detail":"missing key"}'); }
      // Behave like the free plan: library voices are refused through the API.
      if (process.env.MOCK_REFUSE_VOICE && req.url.includes(process.env.MOCK_REFUSE_VOICE)) {
        res.statusCode = 402;
        return res.end('{"detail":{"status":"payment_required","message":"Free users cannot use library voices via the API."}}');
      }
      ttsCalls++;
      const rate = 8000, n = rate / 2, wav = Buffer.alloc(44 + n);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + n, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28);
      wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(n, 40); wav.fill(128, 44);
      res.setHeader('content-type', 'audio/wav');
      return res.end(wav);
    }
    if (req.url === '/tts-calls') return res.end(JSON.stringify({ ttsCalls }));
    if (req.url === '/mock-stats') return res.end(JSON.stringify(stats));
    // OpenAI-compatible (OpenRouter-style) endpoints, served under /api like OpenRouter.
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ data: [{ id: process.env.LLM_MODEL || 'qwen/qwen3.6-35b-a3b' }] }));
    if (req.url === '/api/v1/chat/completions') {
      const b = JSON.parse(body);
      stats.openai++;
      stats.auth = req.headers.authorization || null;
      stats.reasoning = b.reasoning || null;
      stats.provider = b.provider || null;
      const prompt = b.messages.map((m) => m.content).join('\n');
      if (b.stream) {
        res.setHeader('content-type', 'text/event-stream');
        for (const w of pick(['Interesting choice.', 'That door? Of course.']).split(' ')) {
          await new Promise((r) => setTimeout(r, 80));
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w + ' ' } }] })}\n\n`);
        }
        return res.end('data: [DONE]\n\n');
      }
      await new Promise((r) => setTimeout(r, DELAY));
      const schema = b.response_format?.json_schema?.schema;
      const content = schema?.properties?.summary
        ? JSON.stringify({ name: 'The Patient Applicant', summary: 'You waited.', hesitation: 'a', curiosity: 'b', compliance: 'c', impulsivity: 'd', closing: 'Goodbye.' })
        : JSON.stringify(roomContent(prompt));
      return res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1800, completion_tokens: 420 } }));
    }
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: process.env.LLM_MODEL || 'qwen3.6:35b-a3b' }] }));
    if (req.url !== '/api/chat') { res.statusCode = 404; return res.end('{}'); }
    const b = JSON.parse(body);
    const prompt = b.messages.map((m) => m.content).join('\n');
    if (b.stream) {
      const words = (b.messages.length === 1 ? 'OK' : pick(['Interesting choice.', 'That door? Of course.', 'You always pick the left one.'])).split(' ');
      for (const w of words) {
        await new Promise((r) => setTimeout(r, 120));
        res.write(JSON.stringify({ message: { content: w + ' ' }, done: false }) + '\n');
      }
      return res.end(JSON.stringify({ message: { content: '' }, done: true, eval_count: words.length }) + '\n');
    }
    await new Promise((r) => setTimeout(r, DELAY));
    const content = b.format?.properties?.summary
      ? JSON.stringify({
          name: 'The Patient Applicant',
          summary: 'You waited before every door and read everything twice. The building found this reassuring.',
          hesitation: 'You stood still long enough for the lights to give up.',
          curiosity: 'You read the memos. Nobody reads the memos.',
          compliance: 'You did roughly what you were told.',
          impulsivity: 'You pressed the button once, after due consideration.',
          closing: 'Your file is complete. Please wait to be called.',
        })
      : JSON.stringify(roomContent(prompt));
    res.end(JSON.stringify({ message: { content }, prompt_eval_count: 1800, eval_count: 420, eval_duration: 6e9 }));
  });
}).listen(PORT, () => console.log(`Mock model server on http://127.0.0.1:${PORT}`));
