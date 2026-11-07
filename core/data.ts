import ambience from '../data/ambience.json';
import materials from '../data/materials.json';
import narratorSystem from '../data/prompts/narrator-system.md?raw';
import narratorUser from '../data/prompts/narrator-user.md?raw';
import roomSystem from '../data/prompts/room-system.md?raw';
import roomUser from '../data/prompts/room-user.md?raw';
import props from '../data/props.json';
import templates from '../data/templates.json';
import world from '../data/themes/office.md?raw';
import type { GameData } from './room/types';

/** All shared game data, typed. Both the browser and Node scripts load it from here. */
export const gameData: GameData = {
  props: props as GameData['props'],
  materials: materials as GameData['materials'],
  ambience: ambience as unknown as GameData['ambience'],
  templates: templates as unknown as GameData['templates'],
  prompts: { world, roomSystem, roomUser, narratorSystem, narratorUser },
};
