import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "./db";
import { authMiddleware } from "./session-middleware";
import { nid } from "./utils";
import { parse } from "./validate";
import type { AuditInput } from "./server/audit.server";

/* ───────── vocabulary shared with the UI ───────── */

export const STORY_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;
export const SCRUM_ROLES = ["scrum_master", "product_owner"] as const;
export type ScrumRole = (typeof SCRUM_ROLES)[number];
export const SCRUM_ROLE_LABEL: Record<ScrumRole, string> = {
  scrum_master: "اسکرام مستر",
  product_owner: "مالک محصول (PO)",
};
export const NOTE_KINDS = [
  "impediment",
  "retro_good",
  "retro_improve",
  "retro_action",
  "dod",
  "standup",
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type SprintStatus = "planned" | "active" | "completed";

export type Sprint = {
  id: string;
  boardId: string;
  name: string;
  goal: string;
  startDate: string | null;
  endDate: string | null;
  status: SprintStatus;
  startedAt: string | null;
  completedAt: string | null;
  committedPoints: number;
  completedPoints: number;
};
export type ScrumCard = {
  cardId: string;
  points: number | null;
  sprintId: string | null;
};
export type ScrumNote = {
  id: string;
  sprintId: string | null;
  kind: NoteKind;
  body: string;
  author: string;
  resolved: boolean;
  createdAt: string;
};
export type ScrumSnapshot = {
  sprintId: string;
  day: string;
  remaining: number;
  total: number;
};
export type ScrumData = {
  sprints: Sprint[];
  cards: ScrumCard[];
  roles: { username: string; role: ScrumRole }[];
  notes: ScrumNote[];
  snapshots: ScrumSnapshot[];
  /** may this user start / complete sprints and plan the backlog? (admin, scrum master, product owner) */
  canManage: boolean;
  /** may this user assign roles? (admin, scrum master) */
  canAssignRoles: boolean;
  /** how many story points are already finished in the active sprint (from the board's last column) */
  doneCardIds: string[];
};

/* ───────── helpers ───────── */

type WsShape = {
  boards?: {
    id: string;
    title?: string;
    lists?: { cards?: { id: string; title?: string; archived?: boolean }[] }[];
  }[];
};

/** Reads the board from the shared workspace JSON: which cards exist and which are in the last ("done") column. */
async function boardCards(
  boardId: string,
): Promise<{
  title: string;
  cards: Map<string, { title: string; done: boolean }>;
} | null> {
  const sql = await getSql();
  const rows = await sql<{
    data: unknown;
  }>`select data from workspace_state where id = 'main'`;
  const raw = rows[0]?.data;
  const ws = (
    typeof raw === "string" ? JSON.parse(raw) : raw
  ) as WsShape | null;
  const board = ws?.boards?.find((b) => b.id === boardId);
  if (!board) return null;
  const lists = board.lists ?? [];
  const cards = new Map<string, { title: string; done: boolean }>();
  lists.forEach((l, i) => {
    for (const c of l.cards ?? []) {
      if (c.archived) continue;
      cards.set(c.id, { title: c.title ?? "", done: i === lists.length - 1 });
    }
  });
  return { title: board.title ?? "", cards };
}

async function rolesOf(
  boardId: string,
): Promise<{ username: string; role: ScrumRole }[]> {
  const sql = await getSql();
  const rows = await sql<{
    username: string;
    role: string;
  }>`select username, role from app_scrum_roles where board_id = ${boardId}`;
  return rows
    .filter((r) => (SCRUM_ROLES as readonly string[]).includes(r.role))
    .map((r) => ({ username: r.username, role: r.role as ScrumRole }));
}

async function rights(
  boardId: string,
  user: { username: string; isAdmin: boolean },
) {
  const roles = await rolesOf(boardId);
  const mine = roles
    .filter((r) => r.username === user.username)
    .map((r) => r.role);
  return {
    roles,
    canManage: user.isAdmin || mine.length > 0,
    canAssignRoles: user.isAdmin || mine.includes("scrum_master"),
  };
}

async function safeAudit(
  entry: Parameters<(typeof import("./server/audit.server"))["audit"]>[0],
) {
  try {
    const { audit } = await import("./server/audit.server");
    await audit(entry);
  } catch {
    /* logging must never break the action */
  }
}

type SprintRow = {
  id: string;
  board_id: string;
  name: string;
  goal: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  committed_points: number;
  completed_points: number;
};

const day10 = (v: string | null) => (v ? String(v).slice(0, 10) : null);

function mapSprint(r: SprintRow): Sprint {
  return {
    id: r.id,
    boardId: r.board_id,
    name: r.name,
    goal: r.goal,
    startDate: day10(r.start_date),
    endDate: day10(r.end_date),
    status:
      r.status === "active" || r.status === "completed" ? r.status : "planned",
    startedAt: r.started_at,
    completedAt: r.completed_at,
    committedPoints: r.committed_points,
    completedPoints: r.completed_points,
  };
}

async function loadSprint(id: string): Promise<Sprint | null> {
  const sql = await getSql();
  const rows =
    await sql<SprintRow>`select id, board_id, name, goal, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, status, started_at, completed_at, committed_points, completed_points from app_scrum_sprints where id = ${id}`;
  return rows[0] ? mapSprint(rows[0]) : null;
}

const MANAGE_ERROR =
  "فقط ادمین، اسکرام مستر یا مالک محصول می‌تواند این کار را انجام دهد.";

/* ───────── read ───────── */

export const getScrum = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ boardId: z.string().min(1).max(100) })))
  .handler(async ({ data, context }): Promise<ScrumData> => {
    const sql = await getSql();
    const { roles, canManage, canAssignRoles } = await rights(
      data.boardId,
      context.user,
    );
    const board = await boardCards(data.boardId);

    const sprintRows =
      await sql<SprintRow>`select id, board_id, name, goal, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, status, started_at, completed_at, committed_points, completed_points from app_scrum_sprints where board_id = ${data.boardId} order by created_at asc`;
    const sprints = sprintRows.map(mapSprint);
    const cardRows = await sql<{
      card_id: string;
      points: number | null;
      sprint_id: string | null;
    }>`
      select card_id, points, sprint_id from app_scrum_cards where board_id = ${data.boardId}
    `;
    // forget rows of cards that were deleted from the board
    const cards = cardRows
      .filter((r) => !board || board.cards.has(r.card_id))
      .map((r) => ({
        cardId: r.card_id,
        points: r.points,
        sprintId: r.sprint_id,
      }));
    const doneCardIds = board
      ? [...board.cards.entries()].filter(([, v]) => v.done).map(([id]) => id)
      : [];

    // burndown: one snapshot per day for the active sprint, taken whenever someone opens the page
    const active = sprints.find((s) => s.status === "active");
    if (active && board) {
      const inSprint = cards.filter((c) => c.sprintId === active.id);
      const total = inSprint.reduce((n, c) => n + (c.points ?? 0), 0);
      const remaining = inSprint
        .filter((c) => !board.cards.get(c.cardId)?.done)
        .reduce((n, c) => n + (c.points ?? 0), 0);
      await sql`
        insert into app_scrum_snapshots (sprint_id, day, remaining, total)
        values (${active.id}, ${new Date().toISOString().slice(0, 10)}::date, ${remaining}, ${total})
        on conflict (sprint_id, day) do update set remaining = excluded.remaining, total = excluded.total
      `;
    }
    const snaps = await sql<{
      sprint_id: string;
      day: string;
      remaining: number;
      total: number;
    }>`
      select s.sprint_id, to_char(s.day, 'YYYY-MM-DD') as day, s.remaining, s.total from app_scrum_snapshots s
      join app_scrum_sprints p on p.id = s.sprint_id where p.board_id = ${data.boardId} order by s.day asc
    `;
    const noteRows = await sql<{
      id: string;
      sprint_id: string | null;
      kind: string;
      body: string;
      author: string;
      resolved: boolean;
      created_at: string;
    }>`select id, sprint_id, kind, body, author, resolved, created_at from app_scrum_notes where board_id = ${data.boardId} order by created_at asc limit 1000`;

    return {
      sprints,
      cards,
      roles,
      canManage,
      canAssignRoles,
      doneCardIds,
      snapshots: snaps.map((s) => ({
        sprintId: s.sprint_id,
        day: day10(s.day)!,
        remaining: s.remaining,
        total: s.total,
      })),
      notes: noteRows
        .filter((n) => (NOTE_KINDS as readonly string[]).includes(n.kind))
        .map((n) => ({
          id: n.id,
          sprintId: n.sprint_id,
          kind: n.kind as NoteKind,
          body: n.body,
          author: n.author,
          resolved: n.resolved,
          createdAt: n.created_at,
        })),
    };
  });

/* ───────── sprints ───────── */

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

export const createSprint = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        boardId: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(80),
        goal: z.string().trim().max(500).optional(),
        startDate: dateSchema,
        endDate: dateSchema,
      }),
    ),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
      const { canManage } = await rights(data.boardId, context.user);
      if (!canManage) return { ok: false, error: MANAGE_ERROR };
      if (data.startDate && data.endDate && data.endDate < data.startDate) {
        return { ok: false, error: "تاریخ پایان قبل از شروع است." };
      }
      const board = await boardCards(data.boardId);
      if (!board) return { ok: false, error: "تخته پیدا نشد." };
      const id = nid();
      const sql = await getSql();
      await sql`
      insert into app_scrum_sprints (id, board_id, name, goal, start_date, end_date, created_by)
      values (${id}, ${data.boardId}, ${data.name}, ${data.goal ?? ""}, ${data.startDate ?? null}, ${data.endDate ?? null}, ${context.user.username})
    `;
      await safeAudit({
        actor: context.user.username,
        actorName: context.user.displayName,
        category: "board",
        action: "scrum.sprint.create",
        summary: `اسپرینت «${data.name}» ساخته شد`,
        boardId: data.boardId,
        boardTitle: board.title,
        details: { id },
      });
      return { ok: true, id };
    },
  );

export const updateSprint = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(80).optional(),
        goal: z.string().trim().max(500).optional(),
        startDate: dateSchema,
        endDate: dateSchema,
      }),
    ),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const sp = await loadSprint(data.id);
      if (!sp) return { ok: false, error: "اسپرینت پیدا نشد." };
      const { canManage } = await rights(sp.boardId, context.user);
      if (!canManage) return { ok: false, error: MANAGE_ERROR };
      if (sp.status === "completed")
        return { ok: false, error: "اسپرینت بسته‌شده قابل ویرایش نیست." };
      const start =
        data.startDate === undefined ? sp.startDate : data.startDate;
      const end = data.endDate === undefined ? sp.endDate : data.endDate;
      if (start && end && end < start)
        return { ok: false, error: "تاریخ پایان قبل از شروع است." };
      const sql = await getSql();
      await sql`
      update app_scrum_sprints
      set name = ${data.name ?? sp.name}, goal = ${data.goal ?? sp.goal}, start_date = ${start}, end_date = ${end}
      where id = ${data.id}
    `;
      await safeAudit({
        actor: context.user.username,
        actorName: context.user.displayName,
        category: "board",
        action: "scrum.sprint.update",
        summary: `اسپرینت «${data.name ?? sp.name}» ویرایش شد`,
        boardId: sp.boardId,
        details: { id: sp.id },
      });
      return { ok: true };
    },
  );

export const startSprint = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ id: z.string().min(1).max(100) })))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const sp = await loadSprint(data.id);
      if (!sp) return { ok: false, error: "اسپرینت پیدا نشد." };
      const { canManage } = await rights(sp.boardId, context.user);
      if (!canManage) return { ok: false, error: MANAGE_ERROR };
      if (sp.status !== "planned")
        return { ok: false, error: "این اسپرینت قبلاً شروع شده است." };
      if (!sp.endDate)
        return {
          ok: false,
          error: "برای شروع، تاریخ پایان اسپرینت را مشخص کنید.",
        };
      const sql = await getSql();
      const other = await sql<{
        id: string;
      }>`select id from app_scrum_sprints where board_id = ${sp.boardId} and status = 'active'`;
      if (other.length > 0)
        return {
          ok: false,
          error: "همین حالا یک اسپرینت فعال وجود دارد؛ اول آن را ببندید.",
        };
      const cards = await sql<{
        points: number | null;
      }>`select points from app_scrum_cards where sprint_id = ${sp.id}`;
      const committed = cards.reduce((n, c) => n + (c.points ?? 0), 0);
      const today = new Date().toISOString().slice(0, 10);
      await sql`
      update app_scrum_sprints
      set status = 'active', started_at = now(), committed_points = ${committed}, start_date = coalesce(start_date, ${today}::date)
      where id = ${sp.id}
    `;
      await safeAudit({
        actor: context.user.username,
        actorName: context.user.displayName,
        category: "board",
        action: "scrum.sprint.start",
        summary: `اسپرینت «${sp.name}» شروع شد (${committed} امتیاز، ${cards.length} کارت)`,
        boardId: sp.boardId,
        details: { id: sp.id, committed },
      });
      return { ok: true };
    },
  );

export const completeSprint = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ id: z.string().min(1).max(100) })))
  .handler(
    async ({
      data,
      context,
    }): Promise<
      | { ok: true; completedPoints: number; movedBack: number }
      | { ok: false; error: string }
    > => {
      const sp = await loadSprint(data.id);
      if (!sp) return { ok: false, error: "اسپرینت پیدا نشد." };
      const { canManage } = await rights(sp.boardId, context.user);
      if (!canManage) return { ok: false, error: MANAGE_ERROR };
      if (sp.status !== "active")
        return { ok: false, error: "فقط اسپرینت فعال بسته می‌شود." };
      const board = await boardCards(sp.boardId);
      const sql = await getSql();
      const cards = await sql<{
        card_id: string;
        points: number | null;
      }>`select card_id, points from app_scrum_cards where sprint_id = ${sp.id}`;
      const finished = cards.filter((c) => board?.cards.get(c.card_id)?.done);
      const unfinished = cards.filter(
        (c) => !board?.cards.get(c.card_id)?.done,
      );
      const completedPoints = finished.reduce((n, c) => n + (c.points ?? 0), 0);
      // unfinished work goes back to the backlog; finished cards stay linked to the sprint (history)
      for (const c of unfinished) {
        await sql`update app_scrum_cards set sprint_id = null, updated_at = now() where card_id = ${c.card_id}`;
      }
      await sql`
        update app_scrum_sprints set status = 'completed', completed_at = now(), completed_points = ${completedPoints}
        where id = ${sp.id}
      `;
      await safeAudit({
        actor: context.user.username,
        actorName: context.user.displayName,
        category: "board",
        action: "scrum.sprint.complete",
        summary: `اسپرینت «${sp.name}» بسته شد: ${completedPoints} از ${sp.committedPoints} امتیاز انجام شد، ${unfinished.length} کارت به بک‌لاگ برگشت`,
        boardId: sp.boardId,
        details: {
          id: sp.id,
          completedPoints,
          committed: sp.committedPoints,
          movedBack: unfinished.length,
        },
      });
      return { ok: true, completedPoints, movedBack: unfinished.length };
    },
  );

export const deleteSprint = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ id: z.string().min(1).max(100) })))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const sp = await loadSprint(data.id);
      if (!sp) return { ok: false, error: "اسپرینت پیدا نشد." };
      const { canManage } = await rights(sp.boardId, context.user);
      if (!canManage) return { ok: false, error: MANAGE_ERROR };
      if (sp.status !== "planned")
        return { ok: false, error: "فقط اسپرینت برنامه‌ریزی‌شده حذف می‌شود." };
      const sql = await getSql();
      await sql`delete from app_scrum_sprints where id = ${sp.id}`; // cards fall back to the backlog (on delete set null)
      await safeAudit({
        actor: context.user.username,
        actorName: context.user.displayName,
        category: "board",
        action: "scrum.sprint.delete",
        summary: `اسپرینت «${sp.name}» حذف شد`,
        boardId: sp.boardId,
        details: { id: sp.id },
      });
      return { ok: true };
    },
  );

/* ───────── story points & sprint planning ───────── */

export const setCardScrum = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        boardId: z.string().min(1).max(100),
        cardId: z.string().min(1).max(100),
        /** undefined = leave as is, null = clear */
        points: z.number().int().min(0).max(100).nullable().optional(),
        sprintId: z.string().max(100).nullable().optional(),
      }),
    ),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const board = await boardCards(data.boardId);
      const card = board?.cards.get(data.cardId);
      if (!board || !card) return { ok: false, error: "کارت پیدا نشد." };
      const sql = await getSql();
      const cur = await sql<{
        points: number | null;
        sprint_id: string | null;
      }>`select points, sprint_id from app_scrum_cards where card_id = ${data.cardId}`;
      const before = cur[0] ?? { points: null, sprint_id: null };
      const nextPoints =
        data.points === undefined ? before.points : data.points;
      let nextSprint =
        data.sprintId === undefined ? before.sprint_id : data.sprintId;
      let sprintName = "";
      if (data.sprintId !== undefined) {
        const { canManage } = await rights(data.boardId, context.user);
        if (!canManage) return { ok: false, error: MANAGE_ERROR };
        if (data.sprintId) {
          const sp = await loadSprint(data.sprintId);
          if (!sp || sp.boardId !== data.boardId)
            return { ok: false, error: "اسپرینت پیدا نشد." };
          if (sp.status === "completed")
            return { ok: false, error: "اسپرینت بسته شده است." };
          sprintName = sp.name;
        } else {
          nextSprint = null;
        }
      }
      await sql`
      insert into app_scrum_cards (card_id, board_id, points, sprint_id, updated_at)
      values (${data.cardId}, ${data.boardId}, ${nextPoints}, ${nextSprint}, now())
      on conflict (card_id) do update set points = excluded.points, sprint_id = excluded.sprint_id, updated_at = now()
    `;
      const entries: AuditInput[] = [];
      const base = {
        actor: context.user.username,
        actorName: context.user.displayName,
        category: "card" as const,
        boardId: data.boardId,
        boardTitle: board.title,
        cardId: data.cardId,
        cardTitle: card.title,
      };
      if (nextPoints !== before.points) {
        entries.push({
          ...base,
          action: "scrum.points",
          summary: `امتیاز کارت از ${before.points ?? "—"} به ${nextPoints ?? "—"} تغییر کرد`,
        });
      }
      if (nextSprint !== before.sprint_id) {
        entries.push({
          ...base,
          action: "scrum.sprint.assign",
          summary: nextSprint
            ? `کارت به اسپرینت «${sprintName}» اضافه شد`
            : "کارت به بک‌لاگ برگشت",
        });
      }
      if (entries.length) await safeAudit(entries);
      return { ok: true };
    },
  );

/* ───────── roles ───────── */

export const setScrumRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        boardId: z.string().min(1).max(100),
        username: z.string().trim().toLowerCase().min(1).max(64),
        role: z.enum(SCRUM_ROLES),
        on: z.boolean(),
      }),
    ),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const { canAssignRoles } = await rights(data.boardId, context.user);
      if (!canAssignRoles)
        return {
          ok: false,
          error: "فقط ادمین یا اسکرام مستر می‌تواند نقش بدهد.",
        };
      const sql = await getSql();
      const u = await sql<{
        display_name: string;
      }>`select display_name from login_users where username = ${data.username}`;
      if (u.length === 0) return { ok: false, error: "کاربر پیدا نشد." };
      if (data.on) {
        await sql`
        insert into app_scrum_roles (board_id, username, role) values (${data.boardId}, ${data.username}, ${data.role})
        on conflict do nothing
      `;
      } else {
        await sql`delete from app_scrum_roles where board_id = ${data.boardId} and username = ${data.username} and role = ${data.role}`;
      }
      await safeAudit({
        actor: context.user.username,
        actorName: context.user.displayName,
        category: "board",
        action: "scrum.role",
        summary: `${u[0]!.display_name || data.username} ${data.on ? "به‌عنوان" : "از نقش"} ${SCRUM_ROLE_LABEL[data.role]} ${data.on ? "تعیین شد" : "برداشته شد"}`,
        boardId: data.boardId,
        details: { username: data.username, role: data.role, on: data.on },
      });
      return { ok: true };
    },
  );

/* ───────── impediments, retrospective, definition of done ───────── */

export const addScrumNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        boardId: z.string().min(1).max(100),
        sprintId: z.string().max(100).nullable().optional(),
        kind: z.enum(NOTE_KINDS),
        body: z.string().trim().min(1).max(1000),
      }),
    ),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (data.kind === "dod") {
        const { canManage } = await rights(data.boardId, context.user);
        if (!canManage) return { ok: false, error: MANAGE_ERROR };
      }
      const sql = await getSql();
      if (data.sprintId) {
        const sp = await loadSprint(data.sprintId);
        if (!sp || sp.boardId !== data.boardId)
          return { ok: false, error: "اسپرینت پیدا نشد." };
      }
      await sql`
      insert into app_scrum_notes (id, board_id, sprint_id, kind, body, author)
      values (${nid()}, ${data.boardId}, ${data.sprintId ?? null}, ${data.kind}, ${data.body}, ${context.user.username})
    `;
      await safeAudit({
        actor: context.user.username,
        actorName: context.user.displayName,
        category: "board",
        action: `scrum.${data.kind}`,
        summary: `${NOTE_LABEL[data.kind]}: ${data.body.slice(0, 160)}`,
        boardId: data.boardId,
        details: { sprintId: data.sprintId ?? null },
      });
      return { ok: true };
    },
  );

const NOTE_LABEL: Record<NoteKind, string> = {
  impediment: "مانع جدید",
  retro_good: "ریتروسپکتیو · خوب بود",
  retro_improve: "ریتروسپکتیو · باید بهتر شود",
  retro_action: "ریتروسپکتیو · اقدام",
  dod: "تعریف «انجام‌شده» (DoD)",
  standup: "یادداشت استندآپ",
};

export const toggleScrumNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ id: z.string().min(1).max(100) })))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const sql = await getSql();
    const rows = await sql<{
      board_id: string;
      kind: string;
      body: string;
      resolved: boolean;
    }>`
      update app_scrum_notes set resolved = not resolved where id = ${data.id} returning board_id, kind, body, resolved
    `;
    const r = rows[0];
    if (!r) return { ok: false };
    await safeAudit({
      actor: context.user.username,
      actorName: context.user.displayName,
      category: "board",
      action: "scrum.note.toggle",
      summary: `«${r.body.slice(0, 100)}» ${r.resolved ? "حل / انجام شد" : "دوباره باز شد"}`,
      boardId: r.board_id,
    });
    return { ok: true };
  });

export const deleteScrumNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ id: z.string().min(1).max(100) })))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const sql = await getSql();
    const rows = await sql<{
      board_id: string;
      author: string;
      body: string;
    }>`select board_id, author, body from app_scrum_notes where id = ${data.id}`;
    const r = rows[0];
    if (!r) return { ok: false };
    const { canManage } = await rights(r.board_id, context.user);
    if (r.author !== context.user.username && !canManage) return { ok: false };
    await sql`delete from app_scrum_notes where id = ${data.id}`;
    await safeAudit({
      actor: context.user.username,
      actorName: context.user.displayName,
      category: "board",
      action: "scrum.note.delete",
      summary: `«${r.body.slice(0, 100)}» حذف شد`,
      boardId: r.board_id,
    });
    return { ok: true };
  });

/* ───────── daily standup ───────── */

export type StandupEntry = {
  day: string;
  yesterday: string;
  today: string;
  blockers: string;
};

/** Standup rows are notes of kind "standup" whose body is JSON; unreadable rows are skipped. */
export function parseStandup(body: string): StandupEntry | null {
  try {
    const v = JSON.parse(body) as Partial<StandupEntry>;
    if (typeof v.day !== "string") return null;
    return {
      day: v.day,
      yesterday: String(v.yesterday ?? ""),
      today: String(v.today ?? ""),
      blockers: String(v.blockers ?? ""),
    };
  } catch {
    return null;
  }
}

/** One standup per person per day per sprint (saving again the same day edits it). A blocker also becomes an impediment. */
export const saveStandup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        boardId: z.string().min(1).max(100),
        sprintId: z.string().min(1).max(100),
        /** the user's own local day (yyyy-mm-dd), so "today" matches their calendar */
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        yesterday: z.string().trim().max(600),
        today: z.string().trim().max(600),
        blockers: z.string().trim().max(600),
      }),
    ),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!data.yesterday && !data.today && !data.blockers)
        return { ok: false, error: "حداقل یکی از سه بخش را پر کنید." };
      const sp = await loadSprint(data.sprintId);
      if (!sp || sp.boardId !== data.boardId || sp.status !== "active")
        return { ok: false, error: "اسپرینت فعال پیدا نشد." };
      const sql = await getSql();
      const u = context.user.username;
      const body = JSON.stringify({
        day: data.day,
        yesterday: data.yesterday,
        today: data.today,
        blockers: data.blockers,
      });
      const existing = await sql<{ id: string; body: string }>`
      select id, body from app_scrum_notes
      where board_id = ${data.boardId} and sprint_id = ${sp.id} and kind = 'standup' and author = ${u}
        and body like ${`%"day":"${data.day}"%`}
      limit 1
    `;
      let previousBlockers = "";
      if (existing[0]) {
        previousBlockers = parseStandup(existing[0].body)?.blockers ?? "";
        await sql`update app_scrum_notes set body = ${body} where id = ${existing[0].id}`;
      } else {
        await sql`
        insert into app_scrum_notes (id, board_id, sprint_id, kind, body, author)
        values (${nid()}, ${data.boardId}, ${sp.id}, 'standup', ${body}, ${u})
      `;
      }
      if (data.blockers && data.blockers !== previousBlockers) {
        await sql`
        insert into app_scrum_notes (id, board_id, sprint_id, kind, body, author)
        values (${nid()}, ${data.boardId}, ${sp.id}, 'impediment', ${data.blockers}, ${u})
      `;
      }
      await safeAudit({
        actor: u,
        actorName: context.user.displayName,
        category: "board",
        action: "scrum.standup",
        summary: `استندآپ ${data.day}${data.blockers ? ` · مانع: ${data.blockers.slice(0, 100)}` : ""}`,
        boardId: data.boardId,
        details: { sprintId: sp.id, day: data.day },
      });
      return { ok: true };
    },
  );
