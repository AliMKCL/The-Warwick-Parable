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
  /** A small idle motion the adapter plays: 'type' bobs the part like hands on a keyboard. */
  anim?: 'type';
}

export type TextStyle = 'sign' | 'poster' | 'screen' | 'paper' | 'whiteboard' | 'label' | 'led' | 'sticky';

export interface TextSurface {
  /** Centre of the text plane, local to the prop; the plane faces +z. */
  pos: [number, number, number];
  size: [number, number];
  style: TextStyle;
}

/** 'fixture': placed only by an office task at an exact spot, never in a slot (see Layout.fixtures). */
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
  /** button: press once (sends `pressed`) · hold: keep E held for a while (sends hold_start / hold_end). */
  interact?: 'button' | 'hold';
  /** Prompt verb for button and hold props, e.g. "Call the lift" (default "Press"). */
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
  /** Props an office task puts at exact spots (rotated with the layout). */
  fixtures?: Fixture[];
  /** Circular trigger areas an office task watches (rotated with the layout). */
  zones?: Zone[];
}

/** A prop at an exact position, placed before any slot is filled. Its id is stable so a task can refer to it. */
export interface Fixture {
  id: string;
  recipe: string;
  x: number;
  z: number;
  /** Height of the prop's origin (e.g. on top of a desk). */
  y: number;
  /** Which way the prop's front faces. */
  face: Side;
  surfaceText?: string;
  inspectText?: string;
  /** Interaction range in metres when shorter than usual (horizontal distance from the player). */
  reach?: number;
  /** For hold props: seconds of holding needed. */
  holdSeconds?: number;
}

export interface Zone {
  id: string;
  x: number;
  z: number;
  r: number;
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
  /** Interaction range in metres, when shorter than usual. */
  reach?: number;
  /** For hold props: seconds of holding needed. */
  holdSeconds?: number;
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
  rule?: { id: 'lights_dim_on_idle' | 'inspect_to_unlock' | 'exit_timer' | 'narrator_suggests'; params: Record<string, number | string>; line: string; doneLine: string };
  /** A story thread this room opens, and the id of one it pays off. */
  thread?: { plant?: string; resolves?: string };
  /** What the model was given to write this room, for the "how this world was built" view. */
  provenance?: { behaviour: string[]; profile: string[]; story: string[]; repaired?: boolean; error?: string };
  /** The office task staged in this room (see core/tasks). Rooms with a task have no rule. */
  task?: { id: string; params: Record<string, number | string | boolean> };
}

export interface GameData {
  props: PropRecipe[];
  materials: Record<string, MaterialDef>;
  ambience: Record<string, AmbiencePreset>;
  templates: TextTemplates;
  prompts: Prompts;
  /** Fixed lines and texts for the office tasks (data/tasks.json). */
  tasks: TaskTexts;
}

/**
 * The office tasks' wording. The measured instructions are fixed so every
 * player gets the same test; only decoration around them is generated.
 */
export interface TaskTexts {
  two_doors: { title: string; brief: string; instruction: string[]; allowedLabel: string; forbiddenLabel: string };
  lift: { title: string; brief: string; enter: string; hint: string; stairsLabel: string; floors: string[] };
  desk: { title: string; brief: string; enter: string; exitLabel: string; items: Record<string, { name: string; text: string; reading: boolean; surface?: string }> };
  meeting: { title: string; brief: string; enter: string; ask: string; thanks: string; late: string; boardLabel: string; secretLabel: string; timerLabel: string };
  smoke: { title: string; brief: string; enter: string; fileTaken: string; alarm: string; locked: string; workersBefore: string[]; workers: string[]; fileLabel: string; exitLabel: string; otherLabel: string };
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
  rules: Record<'lights_dim_on_idle' | 'inspect_to_unlock' | 'exit_timer' | 'narrator_suggests', { line: string[]; done: string[]; tried?: string[] }>;
}
