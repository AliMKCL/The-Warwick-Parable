-- whack: play-data tables. Run once in the Supabase SQL editor (Project → SQL editor → New query).
-- Anonymous hackathon data only: no names, emails, IPs or any other personal information is ever stored.
-- Safe to re-run: tables and indexes are created only if missing, policies are replaced.

create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  world_id     int generated always as identity,
  consent      boolean not null,
  self_ratings jsonb,          -- {"risk":1-5|null, "patience":…, "social":…, "exploration":…}
  profile      jsonb,          -- the game's hidden trait profile at the end, with its evidence
  predictions  jsonb,          -- what the game concluded (dossier verdict and trait labels)
  completed    boolean default false,
  ended_at     timestamptz
);

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  session_id  uuid references public.sessions(id) on delete cascade,
  created_at  timestamptz not null default now(),
  room        text,
  type        text,            -- choice, task_start, task_done, task_skipped, interact, room_enter, room_exit, …
  choice      text,
  trait       text,            -- risk | patience | social | exploration | null
  trait_value text,            -- safe|risky, now|wait, follow|independent, explore|skip
  latency_ms  int,
  meta        jsonb
);

create index if not exists events_session_id_idx on public.events (session_id);
create index if not exists events_type_idx on public.events (type);

alter table public.sessions enable row level security;
alter table public.events enable row level security;

-- The browser uses the anon key: it may add sessions and events, close its session, and read for analysis.
drop policy if exists "anon insert sessions" on public.sessions;
create policy "anon insert sessions" on public.sessions for insert to anon with check (true);

drop policy if exists "anon update sessions" on public.sessions;
create policy "anon update sessions" on public.sessions for update to anon using (true) with check (true);

drop policy if exists "anon select sessions" on public.sessions;
create policy "anon select sessions" on public.sessions for select to anon using (true);

drop policy if exists "anon insert events" on public.events;
create policy "anon insert events" on public.events for insert to anon with check (true);

drop policy if exists "anon select events" on public.events;
create policy "anon select events" on public.events for select to anon using (true);

grant usage on schema public to anon;
grant select, insert, update on public.sessions to anon;
grant select, insert on public.events to anon;
