/** The shape the model must return for a room. Enums are built per room so only real slots, doors and props can appear. */
export interface ModelRoomContent {
  title: string;
  ambience: string;
  slots: { slot: string; prop: string; text: string; inspect: string }[];
  doors: { door: string; label: string; line: string }[];
  suggest_door?: string;
  rule_line: string;
  rule_done_line: string;
  narrator_enter: string;
  thread_plant: string;
  thread_resolve: string;
  fact: string;
}

export function roomContentSchema(o: {
  slotIds: string[];
  propIds: string[];
  exitIds: string[];
  ambiences: string[];
  minSlots: number;
  maxSlots: number;
  threadIds: string[];
  suggest: boolean;
}): Record<string, unknown> {
  const str = (maxLength: number) => ({ type: 'string', maxLength });
  return {
    type: 'object',
    additionalProperties: false,
    // Order matters: the model writes the room before the lines that describe it.
    required: [
      'title', 'ambience', 'slots', 'doors', ...(o.suggest ? ['suggest_door'] : []),
      'rule_line', 'rule_done_line', 'narrator_enter', 'thread_plant', 'thread_resolve', 'fact',
    ],
    properties: {
      title: str(40),
      ambience: { type: 'string', enum: o.ambiences },
      slots: {
        type: 'array',
        minItems: o.minSlots,
        maxItems: o.maxSlots,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slot', 'prop', 'text', 'inspect'],
          properties: {
            slot: { type: 'string', enum: o.slotIds },
            prop: { type: 'string', enum: o.propIds },
            text: str(90),
            inspect: str(170),
          },
        },
      },
      doors: {
        type: 'array',
        minItems: o.exitIds.length,
        maxItems: o.exitIds.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['door', 'label', 'line'],
          properties: { door: { type: 'string', enum: o.exitIds }, label: str(16), line: str(130) },
        },
      },
      ...(o.suggest ? { suggest_door: { type: 'string', enum: o.exitIds } } : {}),
      rule_line: str(170),
      rule_done_line: str(170),
      narrator_enter: str(230),
      thread_plant: str(120),
      thread_resolve: { type: 'string', enum: ['none', ...o.threadIds] },
      fact: str(150),
    },
  };
}
