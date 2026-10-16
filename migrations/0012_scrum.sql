-- Scrum / agile: sprints, story points, backlog, roles, impediments, retrospectives, burndown snapshots.
-- Cards live in the workspace JSON, so these tables only reference card ids.

create table if not exists app_scrum_sprints (
  id text primary key,
  board_id text not null,
  name text not null,
  goal text not null default '',
  start_date date,
  end_date date,
  status text not null default 'planned',          -- planned | active | completed
  started_at timestamptz,
  completed_at timestamptz,
  committed_points int not null default 0,         -- scope when the sprint was started
  completed_points int not null default 0,         -- finished when the sprint was closed
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists app_scrum_sprints_board_idx on app_scrum_sprints (board_id, created_at desc);

create table if not exists app_scrum_cards (
  card_id text primary key,
  board_id text not null,
  points int,                                      -- story points (null = not estimated)
  sprint_id text references app_scrum_sprints (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists app_scrum_cards_board_idx on app_scrum_cards (board_id);
create index if not exists app_scrum_cards_sprint_idx on app_scrum_cards (sprint_id);

create table if not exists app_scrum_roles (
  board_id text not null,
  username text not null,
  role text not null,                              -- scrum_master | product_owner
  primary key (board_id, username)
);

-- impediments, retrospective items, definition-of-done lines, standup notes
create table if not exists app_scrum_notes (
  id text primary key,
  board_id text not null,
  sprint_id text references app_scrum_sprints (id) on delete cascade,
  kind text not null,                              -- impediment | retro_good | retro_improve | retro_action | dod | standup
  body text not null,
  author text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists app_scrum_notes_board_idx on app_scrum_notes (board_id, kind, created_at desc);

-- one row per sprint per day, written when the scrum page is opened (burndown chart)
create table if not exists app_scrum_snapshots (
  sprint_id text not null references app_scrum_sprints (id) on delete cascade,
  day date not null,
  remaining int not null,
  total int not null,
  primary key (sprint_id, day)
);
