/** Profile weighting helper: how far a trait is above neutral (0 when at or below 0.5). */
export const up = (v: number) => Math.max(0, v - 0.5);

/** Ordinary room layouts a general-purpose test can run in. */
export const ORDINARY = ['waiting_room', 'corridor', 'open_office', 'hub', 'l_gallery', 'u_gallery'] as const;
