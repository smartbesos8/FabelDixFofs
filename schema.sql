-- Fabel — run this once in your Supabase project's SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run).

create table if not exists rooms (
  code text primary key,
  host_id text not null,
  phase text not null default 'lobby',
  round int not null default 0,
  players jsonb not null default '[]',
  deck_urls jsonb not null default '[]',
  deck_size int not null default 84,
  pile jsonb not null default '[]',
  discard jsonb not null default '[]',
  hands jsonb not null default '{}',
  storyteller_idx int not null default 0,
  clue text not null default '',
  storyteller_card int,
  submissions jsonb not null default '[]',
  votes jsonb not null default '{}',
  result jsonb,
  stamp bigint not null default 0,
  created_at timestamptz not null default now()
);

alter table rooms enable row level security;

-- Trust model, matching the earlier prototype: anyone who knows the 4-letter
-- room code can read and write that room. Good enough for a private family
-- game shared over WhatsApp; not a substitute for real per-player auth.
-- (Real hidden hands would need each player authenticated and RLS scoped to
-- their own row — a bigger change, worth doing later if this ever leaves
-- "family game night" and needs to resist a determined snooper.)
create policy "anyone can read rooms" on rooms for select using (true);
create policy "anyone can insert rooms" on rooms for insert with check (true);
create policy "anyone can update rooms" on rooms for update using (true);

-- Push updates to every connected player instead of polling.
alter publication supabase_realtime add table rooms;

-- Optional housekeeping: rooms older than 14 days are almost certainly
-- abandoned test games. Safe to run occasionally by hand; not scheduled.
-- delete from rooms where created_at < now() - interval '14 days';

-- ---------------------------------------------------------------
-- Voice clues — run this once too (same SQL Editor → New query → Run).
-- Lets the storyteller record a short clip instead of typing a clue.
-- ---------------------------------------------------------------

-- Carries the recorded clip's URL alongside the existing text clue.
alter table rooms add column if not exists clue_audio_url text;

-- A public bucket for the clips themselves. Same trust model as the
-- rooms table above — anyone with the link can play a clip, nobody
-- needs to be logged in to record or listen. Capped at 5MB and to
-- audio types only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clue-audio', 'clue-audio', true, 5242880, array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'])
on conflict (id) do nothing;

create policy "anyone can read clue audio" on storage.objects for select using (bucket_id = 'clue-audio');
create policy "anyone can upload clue audio" on storage.objects for insert with check (bucket_id = 'clue-audio');
