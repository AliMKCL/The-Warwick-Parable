import ambience from '../data/ambience.json';
import materials from '../data/materials.json';
import props from '../data/props.json';
import templates from '../data/templates.json';
import type { GameData } from './room/types';

/** All shared game data, typed. Both the browser and Node scripts load it from here. */
export const gameData: GameData = {
  props: props as GameData['props'],
  materials: materials as GameData['materials'],
  ambience: ambience as GameData['ambience'],
  templates: templates as unknown as GameData['templates'],
};
