// A fake Ollama server for testing without a model: `npm run mock:llm`, then
// set LLM_BASE_URL=http://127.0.0.1:11999 in .env.local. It answers room
// requests by reading the prompt (slot IDs, allowed props, door IDs) and
// streams narrator lines word by word. Delay with MOCK_DELAY_MS (default 1500).
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 11999);
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 1500);
let n = 0;
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
    narrator_enter: waited ? `You waited ${waited} seconds back there. This room waited longer.` : 'Another room, built just for you.',
    fact: `Room ${n} keeps a copy of everything you read.`,
  };
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json');
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
    const content = JSON.stringify(roomContent(prompt));
    res.end(JSON.stringify({ message: { content }, prompt_eval_count: 1800, eval_count: 420, eval_duration: 6e9 }));
  });
}).listen(PORT, () => console.log(`Mock model server on http://127.0.0.1:${PORT}`));
