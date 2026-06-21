create table if not exists bot_users (
  telegram_user_id bigint primary key,
  username text,
  first_name text,
  last_name text,
  display_name text,
  language_code text,
  is_bot boolean,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists analytics_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null,
  telegram_user_id bigint references bot_users(telegram_user_id),
  chat_id bigint,
  username text,
  display_name text,
  metadata jsonb not null default '{}'::jsonb
);

alter table reports
  add column if not exists telegram_user_id bigint references bot_users(telegram_user_id),
  add column if not exists chat_id bigint,
  add column if not exists username text,
  add column if not exists reporter_name text;

create index if not exists analytics_events_created_at_idx
  on analytics_events(created_at desc);

create index if not exists analytics_events_user_day_idx
  on analytics_events(telegram_user_id, created_at desc);

create index if not exists analytics_events_type_day_idx
  on analytics_events(event_type, created_at desc);

create index if not exists reports_user_day_idx
  on reports(telegram_user_id, created_at desc);
