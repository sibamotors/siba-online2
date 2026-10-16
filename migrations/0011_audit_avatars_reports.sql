-- Audit log, profile pictures, presence, richer work reports, message reactions.

-- Profile picture (small, resized in the browser) + last-seen time for "online" dots.
alter table login_users add column if not exists avatar bytea;
alter table login_users add column if not exists avatar_mime text;
alter table login_users add column if not exists avatar_updated_at timestamptz;
alter table login_users add column if not exists last_seen_at timestamptz;

-- One row per thing that happened (cards, boards, accounts, reports …).
-- Kept in its own table so it survives card/board deletion.
create table if not exists app_audit_log (
  id text primary key,
  created_at timestamptz not null default now(),
  actor text not null,
  actor_name text not null default '',
  category text not null,          -- card | list | board | people | label | account | report | security | system
  action text not null,            -- e.g. card.update, card.move, login.failed
  board_id text,
  board_title text,
  card_id text,
  card_title text,
  summary text not null,           -- human readable Persian sentence
  details jsonb,                   -- optional structured before/after
  ip text
);
create index if not exists app_audit_created_idx on app_audit_log (created_at desc);
create index if not exists app_audit_card_idx on app_audit_log (card_id, created_at desc);
create index if not exists app_audit_board_idx on app_audit_log (board_id, created_at desc);
create index if not exists app_audit_actor_idx on app_audit_log (actor, created_at desc);

-- Work reports: subject, type, priority, review status, several attachments.
alter table app_work_reports add column if not exists subject text not null default '';
alter table app_work_reports add column if not exists kind text not null default 'general';
alter table app_work_reports add column if not exists priority text not null default 'normal';
alter table app_work_reports add column if not exists status text not null default 'sent';
alter table app_work_reports add column if not exists status_note text not null default '';
alter table app_work_reports add column if not exists reviewed_at timestamptz;
alter table app_work_reports add column if not exists reviewed_by text;
alter table app_work_reports add column if not exists group_id text;
alter table app_work_reports add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table app_work_reports add column if not exists archived_by_to boolean not null default false;
alter table app_work_reports add column if not exists archived_by_from boolean not null default false;
create index if not exists app_work_reports_group_idx on app_work_reports (group_id);
create index if not exists app_work_reports_status_idx on app_work_reports (to_username, status);

-- Discussion / feedback thread under one report (sender and recipient only).
create table if not exists app_work_report_comments (
  id text primary key,
  report_id text not null references app_work_reports (id) on delete cascade,
  author text not null,
  body text not null,
  kind text not null default 'comment',   -- comment | status
  created_at timestamptz not null default now()
);
create index if not exists app_work_report_comments_idx on app_work_report_comments (report_id, created_at);

-- Emoji reactions on direct and group messages (message ids are globally unique).
create table if not exists app_message_reactions (
  message_id text not null,
  username text not null,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, username, emoji)
);
create index if not exists app_message_reactions_msg_idx on app_message_reactions (message_id);
