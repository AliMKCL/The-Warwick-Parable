/** The shape the model must return for a room. Enums are built per room so only real slots, doors and props can appear. */
export interface ModelRoomContent {
  title: string;
  ambience: string;
  slots: { slot: string; prop: string; text: string; inspect: string }[];
  doors: { door: string; label: string; line: string }[];
  narrator_enter: string;
  fact: string;
}

export function roomContentSchema(o: {
  slotIds: string[];
  propIds: string[];
  exitIds: string[];
  ambiences: string[];
  minSlots: number;
  maxSlots: number;
}): Record<string, unknown> {
  const str = (maxLength: number) => ({ type: 'string', maxLength });
  return {
    type: 'object',
    additionalProperties: false,
    // Order matters: the model writes the room before the lines that describe it.
    required: ['title', 'ambience', 'slots', 'doors', 'narrator_enter', 'fact'],
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
      narrator_enter: str(230),
      fact: str(150),
    },
  };
}
