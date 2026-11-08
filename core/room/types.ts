/**
 * The room data model. Core produces RoomSpecs; adapters only draw them.
 *
 * Units: metres. The room grid has 1 m cells; cell (cx, cz) covers
 * x in [cx, cx+1], z in [cz, cz+1]. Y is up. A prop's local front faces +z.
 */

export type Side = 'n' | 's' | 'e' | 'w'; // n = -z, s = +z, w = -x, e = +x

// ---------- Prop recipes (data/props.json) ----------

export type PartShape = 'box' | 'cyl' | 'sphere' | 'cone';

export interface PropPart {
  shape: PartShape;
  /** box: [w, h, d] · cyl: [radiusTop, radiusBottom, height] · sphere: [r] · cone: [r, h] */
  size: number[];
  /** Centre of the part, local to the prop (origin = floor centre of its footprint). */
  pos: [number, number, number];
  /** Euler rotation in degrees. */
  rot?: [number, number, number];
  /** Key into data/materials.json */
  mat: string;
}

export type TextStyle = 'sign' | 'poster' | 'screen' | 'paper' | 'whiteboard' | 'label' | 'led';

export interface TextSurface {
  /** Centre of the text plane, local to the prop; the plane faces +z. */
  pos: [number, number, number];
  size: [number, number];
  style: TextStyle;
}

/** 'fixture': placed by the layout at an exact spot, never in a slot (see Layout.fixtures). */
export type SlotKind = 'floor' | 'wall' | 'wall_mounted' | 'center' | 'fixture';

export interface PropRecipe {
  id: string;
  name: string;
  tags: string[];
  /** Which slot kinds this prop may be placed in. */
  fits: SlotKind[];
  /** Bounding size [w, h, d] in metres at rotation 0. */
  size: [number, number, number];
  /** Blocks movement. */
  solid: boolean;
  /** Player can look at it and press E to read its text. */
  inspectable: boolean;
  /** Mounting height for wall_mounted props (centre of the prop). */
  mountHeight?: number;
  text?: TextSurface;
  interact?: 'button';
  /** Prompt verb for a button, e.g. "Call the lift" (default "Press"). */
  verb?: string;
  parts: PropPart[];
}

export interface MaterialDef {
  color: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
}

export interface AmbiencePreset {
  /** Ceiling light colour and strength. */
  light: string;
  intensity: number;
  /** Fill from the hemisphere light. */
  sky: string;
  ground: string;
  hemi: number;
  fog: string;
  fogDensity: number;
  exposure: number;
  /** 0 = steady, 1 = constant flicker. */
  flicker: number;
  wall: string;
  floor: string;
  ceiling: string;
  sound: string;
  /** Colour grade applied after rendering. */
  grade?: { tint: [number, number, number]; contrast: number; vignette: number; grain: number };
}

// ---------- Layout (made by the generator, no model) ----------

export interface Door {
  color?: string;
  concealed?: boolean;
  id: string;
  cx: number;
  cz: number;
  /** Which edge of the cell the door sits on. */
  side: Side;
  label: string;
  /** The way in: locked behind the player. */
  entrance: boolean;
  /** The label is part of the room's design (e.g. MAINTENANCE): the model may not rename it. */
  fixedLabel?: boolean;
}

export interface Slot {
  id: string;
  kind: SlotKind;
  /** Anchor cell. */
  cx: number;
  cz: number;
  /** For wall and wall_mounted slots: which wall of the anchor cell. */
  side?: Side;
  /** Area in cells available at the anchor, [along x, along z]. */
  span: [number, number];
  /** For floor and center slots: which way the prop's front should face. */
  face?: Side;
  tags: string[];
}

export interface Layout {
  archetype: string;
  width: number;
  depth: number;
  ceiling: number;
  /** One string per row (z); '.' floor, '#' solid. */
  cells: string[];
  doors: Door[];
  slots: Slot[];
  /** Where the player stands on arrival, and the direction they face (radians, 0 = facing -z). */
  spawn: { x: number; z: number; yaw: number };
  /** Props the layout puts at exact spots (e.g. a lift), placed before any slot is filled. */
  fixtures?: Fixture[];
}

/** A prop at an exact position, rotated with the layout. Its id is stable so a rule can refer to it. */
export interface Fixture {
  id: string;
  recipe: string;
  x: number;
  z: number;
  /** Height of the prop's origin. */
  y: number;
  /** Which way the prop's front faces. */
  face: Side;
  surfaceText?: string;
  inspectText?: string;
}

// ---------- Room spec (what the adapter draws) ----------

export interface PlacedProp {
  /** Unique within the room, used in player events. */
  id: string;
  recipe: string;
  slot: string;
  x: number;
  y: number;
  z: number;
  /** Radians about Y. */
  rotY: number;
  /** Text drawn on the prop's text surface, if it has one. */
  surfaceText?: string;
  /** Shown when the player inspects it. */
  inspectText?: string;
  /**
   * Placed on purpose: one of the model's chosen slots, or a template room's
   * chosen piece. Filler (rows of desks, partitions, a model room's background
   * furniture) is not, so it doesn't count as something worth exploring.
   */
  featured?: boolean;
}

export interface RoomSpec {
  variant?: 'messy' | 'ceiling';
  anomaly?: import('../anomalies/anomalies').AnomalySpec;
  id: string;
  index: number;
  seed: number;
  layout: Layout;
  props: PlacedProp[];
  ambience: string;
  narrator: {
    onEnter: string;
    /** Spoken when the player looks at a door for a moment. */
    doors: Record<string, string>;
  };
  /** Where the content came from: the model, or templates when the model was unavailable. */
  source: 'model' | 'template';
  /** Short name for the room, used in the story memory and the dossier. */
  title: string;
  /** One fact this room establishes, for the story memory. */
  fact?: string;
  /** How long generation took, for the debug overlay. */
  genMs?: number;
  /** The mechanic running in this room, if any (see core/rules). */
  rule?: { id: 'lights_dim_on_idle' | 'inspect_to_unlock' | 'exit_timer' | 'narrator_suggests' | 'gamble' | 'lift_wait'; params: Record<string, number | string>; line: string; doneLine: string };
  /** Set when the player arrived through a gamble's 50/50 door: what the coin decided. */
  gambleResult?: 'shortcut' | 'setback';
  /** A story thread this room opens, and the id of one it pays off. */
  thread?: { plant?: string; resolves?: string };
  /** What the model was given to write this room, for the "how this world was built" view. */
  provenance?: { behaviour: string[]; profile: string[]; story: string[]; repaired?: boolean; error?: string };
}

export interface GameData {
  props: PropRecipe[];
  materials: Record<string, MaterialDef>;
  ambience: Record<string, AmbiencePreset>;
  templates: TextTemplates;
  prompts: Prompts;
}

/** Markdown prompt templates from data/prompts and data/themes, with {{placeholders}}. */
export interface Prompts {
  world: string;
  roomSystem: string;
  roomUser: string;
  narratorSystem: string;
  narratorUser: string;
  dossierSystem: string;
  dossierUser: string;
}

export interface TextTemplates {
  signs: string[];
  posters: string[];
  screens: string[];
  whiteboards: string[];
  papers: string[];
  labels: string[];
  inspect: Record<string, string[]>;
  doorLabels: string[];
  narratorFirst: string[];
  narratorEnter: Record<string, string[]>;
  narratorDoor: string[];
  narratorPress: string[];
  rules: Record<'lights_dim_on_idle' | 'inspect_to_unlock' | 'exit_timer' | 'narrator_suggests' | 'gamble' | 'lift_wait', { line: string[]; done: string[]; tried?: string[] }>;
  /** Gamble rooms: the stakes said before the choice, and what the coin decided. */
  gamble: { timedLine: string[]; safeDoor: string[]; riskyDoor: string[]; shortcut: string[]; setback: string[]; shortcutEnd: string[] };
}
