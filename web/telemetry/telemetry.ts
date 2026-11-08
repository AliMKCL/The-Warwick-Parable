import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Play-data collection in Supabase, for later analysis (tables in supabase/schema.sql).
 *
 * Everything here is best-effort: calls never throw, never block the game,
 * and when Supabase is unconfigured or unreachable they warn once and do nothing.
 * No personal information is ever sent: only behaviour inside the game.
 */

export type Trait = 'risk' | 'patience' | 'social' | 'exploration';
export type TraitValue = 'safe' | 'risky' | 'now' | 'wait' | 'follow' | 'independent' | 'explore' | 'skip';
/** The player's own 1–5 rating of each trait before playing; null when skipped. */
export type SelfRatings = Record<Trait, number | null>;

export interface TelemetryEvent {
  room?: string | null;
  type: string;
  choice?: string | null;
  trait?: Trait | null;
  trait_value?: TraitValue | null;
  latency_ms?: number | null;
  meta?: Record<string, unknown>;
}

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const FLUSH_MS = 1500;
const BATCH = 50;

/** True when the Supabase env vars are set; the start screen only offers data sharing then. */
export const telemetryConfigured = !!(URL && KEY);

let client: SupabaseClient | undefined;
let sessionId: string | undefined;
/** Resolves true once the session row exists, so events never arrive before it. */
let ready: Promise<boolean> = Promise.resolve(false);
let queue: Record<string, unknown>[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
let startedAt = 0;
const warned = new Set<string>();

function warn(key: string, detail?: unknown) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[telemetry] ${key}; the game continues without it.`, detail ?? '');
}

function getClient(): SupabaseClient | undefined {
  if (client) return client;
  if (!telemetryConfigured) {
    warn('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)');
    return undefined;
  }
  try {
    client = createClient(URL!, KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // keepalive lets the last batch finish even while the page is closing.
      global: { fetch: (input, init) => fetch(input, { ...init, keepalive: true }) },
    });
  } catch (e) {
    warn('could not create the Supabase client', e);
  }
  return client;
}

/** Opens a session for a player who agreed to share data. Resolves with its world_id, or null if it failed. */
export function startSession(selfRatings: SelfRatings | null): Promise<number | null> {
  const c = getClient();
  if (!c) return Promise.resolve(null);
  sessionId = crypto.randomUUID();
  startedAt = performance.now();
  seq = 0;
  const insert = (async () => {
    const { data, error } = await c
      .from('sessions')
      .insert({ id: sessionId, consent: true, self_ratings: selfRatings })
      .select('world_id')
      .single();
    if (error) throw error;
    return (data as { world_id: number } | null)?.world_id ?? null;
  })().catch((e: unknown) => {
    warn('could not start a session (has supabase/schema.sql been run?)', e);
    sessionId = undefined;
    queue = [];
    return null;
  });
  ready = insert.then(() => !!sessionId);
  addEventListener('pagehide', () => void flush());
  return insert;
}

/** Records one event. Fire-and-forget: returns at once, batches, and swallows every failure. */
export function logEvent(e: TelemetryEvent): void {
  try {
    if (!sessionId) return;
    queue.push({
      session_id: sessionId,
      room: e.room ?? null,
      type: e.type,
      choice: e.choice ?? null,
      trait: e.trait ?? null,
      trait_value: e.trait_value ?? null,
      latency_ms: e.latency_ms == null ? null : Math.round(e.latency_ms),
      // seq and t_ms order events exactly, since batches may land out of order.
      meta: { ...e.meta, seq: seq++, t_ms: Math.round(performance.now() - startedAt) },
    });
    if (queue.length >= BATCH) void flush();
    else flushTimer ??= setTimeout(() => void flush(), FLUSH_MS);
  } catch (err) {
    warn('could not queue an event', err);
  }
}

/** Sends whatever is queued. Never rejects. */
export async function flush(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  try {
    if (!(await ready) || !queue.length || !client) return;
    const rows = queue;
    queue = [];
    const { error } = await client.from('events').insert(rows);
    if (error) warn('could not save events', error);
  } catch (e) {
    warn('could not save events', e);
  }
}

/** Marks the session complete with the game's final profile and what it concluded. Never rejects. */
export async function endSession(profile: unknown, predictions: unknown): Promise<void> {
  try {
    await flush();
    if (!sessionId || !client) return;
    const { error } = await client
      .from('sessions')
      .update({ profile, predictions, completed: true, ended_at: new Date().toISOString() })
      .eq('id', sessionId);
    if (error) warn('could not close the session', error);
  } catch (e) {
    warn('could not close the session', e);
  }
}
