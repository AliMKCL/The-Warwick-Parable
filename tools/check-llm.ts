/**
 * npm run check:llm
 *
 * Confirms the local model server is up, the model is installed, and it can
 * return schema-valid JSON fast enough. Runs the same request twice: the
 * second run shows the effect of prompt caching.
 */
import { createLlmClient, LlmError } from '../core/llm/client';
import { llmConfigFromEnv, loadProjectEnv } from './env';

loadProjectEnv();
const config = llmConfigFromEnv();
const client = createLlmClient(config, { fetch: (url, init) => fetch(url, init as RequestInit), now: () => performance.now() });

const PROPS = ['desk_office', 'chair_office', 'filing_cabinet', 'water_cooler', 'plant_dead', 'sign_wall'] as const;

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['room_name', 'narrator_line', 'slots'],
  properties: {
    room_name: { type: 'string', maxLength: 40 },
    narrator_line: { type: 'string', maxLength: 200 },
    slots: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'prop', 'text'],
        properties: {
          slot: { type: 'string', enum: ['corner_a', 'wall_b', 'center'] },
          prop: { type: 'string', enum: [...PROPS] },
          text: { type: 'string', maxLength: 120 },
        },
      },
    },
  },
};

const messages = [
  {
    role: 'system' as const,
    content:
      'You design rooms for a game set in an unsettling, sterile office. You are also its narrator: dry, sarcastic, observant. Use only the prop IDs allowed by the schema. Keep every text short.',
  },
  {
    role: 'user' as const,
    content:
      'The player waited 45 seconds before pressing the first button, moving the mouse around it nervously. Design the next room: name it, fill the three slots, and write the narrator line said on entry.',
  },
];

function fmt(n: number | undefined, unit = '') {
  return n === undefined ? 'n/a' : `${Math.round(n * 10) / 10}${unit}`;
}

async function main() {
  console.log(`Model server: ${config.provider} at ${config.baseUrl}`);
  console.log(`Model:        ${config.model}\n`);

  const ping = await client.ping();
  if (!ping.ok) {
    console.error(`✗ Cannot reach the model server. ${ping.error}`);
    console.error(
      config.provider === 'ollama'
        ? '  Start Ollama (open the Ollama app, or run `ollama serve`) and try again.'
        : /openrouter/.test(config.baseUrl)
          ? '  Check your internet connection and LLM_API_KEY.'
          : '  Start the server in LM Studio (Developer tab → Start server) and try again.',
    );
    process.exit(1);
  }
  if (!ping.hasModel) {
    console.error(`✗ Server is up but "${config.model}" is not installed. Installed: ${ping.models.join(', ') || 'none'}`);
    if (config.provider === 'ollama') console.error(`  Run: ollama pull ${config.model}`);
    process.exit(1);
  }
  console.log('✓ Server reachable and model installed');

  for (const label of ['First request (cold)', 'Second request (prompt cached)']) {
    try {
      const res = await client.completeJson<{ room_name: string; narrator_line: string; slots: unknown[] }>({
        messages,
        schema,
        schemaName: 'room_test',
        maxTokens: 400,
      });
      const t = res.timings;
      const valid =
        typeof res.value.room_name === 'string' && Array.isArray(res.value.slots) && res.value.slots.length === 3;
      console.log(`\n${label}: ${valid ? '✓ valid JSON' : '✗ JSON missing fields'}`);
      console.log(
        `  total ${fmt(t.totalMs / 1000, ' s')} · prompt ${fmt(t.promptTokens)} tok · output ${fmt(t.outputTokens)} tok · ${fmt(t.outputTokensPerSec, ' tok/s')}`,
      );
      console.log(`  room: "${res.value.room_name}"`);
      console.log(`  narrator: "${res.value.narrator_line}"`);
    } catch (err) {
      const e = err as LlmError;
      console.error(`\n${label}: ✗ ${e.message}`);
      process.exit(1);
    }
  }
  console.log('\nDone. Under ~8 s for the cold request means room generation will keep up with play.');
}

main();
