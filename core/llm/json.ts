/**
 * Pull a JSON value out of model text. Constrained decoding usually returns
 * clean JSON, but some servers wrap it in a <think> block or a code fence.
 */
export function extractJson(text: string): unknown {
  let s = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.search(/[{[]/);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error(`Model output is not JSON: ${s.slice(0, 160)}`);
  }
}
