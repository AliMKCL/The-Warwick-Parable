// Fails if anything in core/ imports Three.js, the web adapter, or Node built-ins.
// Core has to run unchanged in the browser, in Node and next to Godot.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../core/', import.meta.url));
const banned = [/^three(\/|$)/, /^node:/, /(^|\/)web\//, /^(fs|path|http|https|os|child_process)$/];
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) check(p);
  }
}

function check(file) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1] ?? m[2];
    if (banned.some((re) => re.test(spec))) problems.push(`${relative(process.cwd(), file)} imports "${spec}"`);
  }
}

walk(root);
if (problems.length) {
  console.error('core/ must stay engine-free:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('core purity: ok');
