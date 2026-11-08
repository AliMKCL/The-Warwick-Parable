import type { PropRecipe } from '../room/types';

/** Reserved footprint is validated with the same placement rules as furniture. */
export const ANOMALY_ANCHOR: PropRecipe = {
  id: 'anomaly_anchor',
  name: 'Anomaly',
  tags: [],
  fits: ['wall'],
  size: [0.9, 2, 0.85],
  solid: true,
  inspectable: true,
  parts: [],
};

export const ANOMALIES = [
  {
    id: 'blue_door',
    name: 'The blue door',
    action: 'Examine the returns record',
    line: 'That door is the standard colour. We have updated the standard.',
    done: 'You took the blue door. Your previous decision has been returned to you.',
  },
  {
    id: 'ceiling_cabinet',
    name: 'Ceiling filing',
    action: 'Pull the hanging drawer handle',
    line: 'We moved the sensitive files out of reach. Apparently we left the handle.',
    done: 'Please read the fallen memo. It took considerable effort to misfile it.',
  },
  {
    id: 'false_exit',
    name: 'The omitted exit',
    action: 'Switch off the exit light',
    line: 'That switch is for emergencies. I see we have broadened the definition.',
    done: 'That exit was omitted from the evacuation plan for administrative reasons.',
  },
  {
    id: 'footprints',
    name: 'Carpet attendance',
    action: 'Read the attendance policy',
    line: 'You can withdraw your attendance. We do ask that you withdraw in order.',
    done: 'The carpet has accepted your correction.',
  },
  {
    id: 'floor_meeting',
    name: 'The floor meeting',
    action: 'Read the sunken agenda',
    line: 'We moved your item to the top. You seemed unusually invested.',
    done: 'The meeting has been minuted at floor level.',
  },
  {
    id: 'reflection',
    name: 'The impatient reflection',
    action: 'Sit in the chair',
    line: 'Thank you. The other side was beginning to take it personally.',
    done: 'There. Both of you are seated. We can begin.',
  },
  {
    id: 'queue_plant',
    name: 'The patient ficus',
    action: 'Take a queue ticket',
    line: 'I should mention that the ficus arrived before you.',
    done: 'The plant has reached the window. Its paperwork is immaculate.',
  },
  {
    id: 'borrowed_clock',
    name: 'Borrowed time',
    action: 'Read the clock notice',
    line: 'I will put those seconds down as a loan.',
    done: 'You have already borrowed against this minute.',
  },
  {
    id: 'disputed_ticket',
    name: 'Retrospective queue',
    action: 'Stamp the ticket DISPUTED',
    line: 'Your objection has been recorded. We now have paperwork about the paperwork.',
    done: 'A second stamp would constitute a separate appeal.',
  },
  {
    id: 'copier_route',
    name: 'The declined route',
    action: 'Collect the copied route',
    line: 'We keep copies of the decisions you leave behind. The originals are harder to store.',
    done: 'You found the annotation. Someone expected you to reconsider.',
  },
  {
    id: 'wandering_light',
    name: 'The lighting break',
    action: 'Follow the light and read the note',
    line: 'You followed the lighting to a private conversation. That is a first.',
    done: 'The lighting will be back at its post shortly.',
  },
  {
    id: 'hold_phone',
    name: 'The coat rack on hold',
    action: 'Pick up the receiver',
    line: 'Your enquiry will be answered in the order it was received. Please continue to hold.',
    done: '…in the order it was received. I was almost done.',
  },
  {
    id: 'weather_drawer',
    name: 'April in a drawer',
    action: 'Open the weather drawer',
    line: 'Facilities has been trying to resolve that since April.',
    done: 'Thank you. The weather is now contained in an approved receptacle.',
  },
  {
    id: 'permission_machine',
    name: 'Permission vending',
    action: 'Choose PERMISSION TO LEAVE',
    line: 'Your permission to leave has been dispensed. The illuminated door will accept it.',
    done: 'Of course. I will extend your break retroactively.',
  },
  {
    id: 'receipt',
    name: 'The visit receipt',
    action: 'Print an itemised visit receipt',
    line: 'Please retain this receipt. We already have a copy.',
    done: 'The first attempt was complimentary.',
  },
  {
    id: 'shadow_divider',
    name: 'A private meeting',
    action: 'Fold away the screen',
    line: 'That was a private meeting. It is over now.',
    done: 'The attendee has left through the wall. We discourage following.',
  },
] as const;
export type AnomalyId = (typeof ANOMALIES)[number]['id'];
export function definition(id: AnomalyId) {
  return ANOMALIES.find((a) => a.id === id)!;
}
