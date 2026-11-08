import { readFileSync } from 'node:fs';
import type { GameData } from '../core/room/types';

/** Same as core/data.ts, but reads the Markdown prompts with fs (Node has no `?raw` imports). */
export function loadGameData(): GameData {
  const json = (p: string) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
  const md = (p: string) => readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8');
  return {
    props: json('props.json'),
    materials: json('materials.json'),
    ambience: json('ambience.json'),
    templates: json('templates.json'),
    prompts: {
      world: md('themes/office.md'),
      roomSystem: md('prompts/room-system.md'),
      roomUser: md('prompts/room-user.md'),
      narratorSystem: md('prompts/narrator-system.md'),
      narratorUser: md('prompts/narrator-user.md'),
      dossierSystem: md('prompts/dossier-system.md'),
      dossierUser: md('prompts/dossier-user.md'),
    },
    layout: json('layout.json'),
    tasks: json('tasks.json'),
  };
}
