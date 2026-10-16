import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "./db";
import { adminMiddleware, authMiddleware } from "./session-middleware";
import { parse } from "./validate";

export type AuditCategory =
  | "card"
  | "list"
  | "board"
  | "people"
  | "label"
  | "account"
  | "report"
  | "security"
  | "system";

export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  card: "کارت",
  list: "ستون",
  board: "تخته",
  people: "افراد",
  label: "برچسب",
  account: "حساب کاربری",
  report: "گزارش",
  security: "امنیت و ورود",
  system: "سیستم",
};

/** Categories every logged-in user may see (the rest — logins, accounts, reports — are admin only). */
export const PUBLIC_AUDIT_CATEGORIES: AuditCategory[] = ["card", "list", "board", "people", "label"];

export type AuditEntry = {
  id: string;
  createdAt: string;
  actor: string;
  actorName: string;
  category: AuditCategory;
  action: string;
  boardId: string | null;
  boardTitle: string | null;
  cardId: string | null;
  cardTitle: string | null;
  summary: string;
  ip: string | null;
};

type Row = {
  id: string;
  created_at: string;
  actor: string;
  actor_name: string;
  category: string;
  action: string;
  board_id: string | null;
  board_title: string | null;
  card_id: string | null;
  card_title: string | null;
  summary: string;
  ip: string | null;
};

const COLUMNS =
  "id, created_at, actor, actor_name, category, action, board_id, board_title, card_id, card_title, summary, ip";

function mapRow(r: Row, showIp: boolean): AuditEntry {
  return {
    id: r.id,
    createdAt: r.created_at,
    actor: r.actor,
    actorName: r.actor_name || r.actor,
    category: r.category as AuditCategory,
    action: r.action,
    boardId: r.board_id,
    boardTitle: r.board_title,
    cardId: r.card_id,
    cardTitle: r.card_title,
    summary: r.summary,
    ip: showIp ? r.ip : null,
  };
}

const filterSchema = z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(30).optional(),
  actor: z.string().max(64).optional(),
  boardId: z.string().max(100).optional(),
  cardId: z.string().max(100).optional(),
  /** ISO dates (yyyy-mm-dd or full ISO) */
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  /** cursor: only rows older than this created_at */
  before: z.string().max(40).optional(),
  /** id of the last row of the previous page (breaks ties inside the same millisecond) */
  beforeId: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export type AuditFilter = z.input<typeof filterSchema>;

function validDate(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The activity log. Admins see everything; everybody else only board/card/list/label/people events. */
export const listAuditLog = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(parse(filterSchema))
  .handler(async ({ data, context }): Promise<{ entries: AuditEntry[]; hasMore: boolean }> => {
    const isAdmin = context.user.isAdmin;
    const limit = data.limit ?? 100;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sqlText: string, value: unknown) => {
      params.push(value);
      where.push(sqlText.replace("?", `$${params.length}`));
    };

    if (!isAdmin) {
      add("category = any(?::text[])", PUBLIC_AUDIT_CATEGORIES);
    } else if (data.category) {
      add("category = ?", data.category);
    }
    if (!isAdmin && data.category && PUBLIC_AUDIT_CATEGORIES.includes(data.category as AuditCategory)) {
      add("category = ?", data.category);
    }
    if (data.actor) add("actor = ?", data.actor.trim().toLowerCase());
    if (data.boardId) add("board_id = ?", data.boardId);
    if (data.cardId) add("card_id = ?", data.cardId);
    const from = validDate(data.from);
    if (from) add("created_at >= ?::timestamptz", from);
    const to = validDate(data.to);
    if (to) add("created_at <= ?::timestamptz", to);
    const before = validDate(data.before);
    if (before) {
      params.push(before);
      const t = `$${params.length}::timestamptz`;
      params.push(data.beforeId ?? "");
      const i = `$${params.length}`;
      where.push(
        `(date_trunc('milliseconds', created_at) < ${t} or (date_trunc('milliseconds', created_at) = ${t} and id < ${i}))`,
      );
    }
    const q = data.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like);
      const n = `$${params.length}`;
      where.push(`(summary ilike ${n} or card_title ilike ${n} or board_title ilike ${n} or actor_name ilike ${n} or actor ilike ${n})`);
    }

    const sql = await getSql();
    const rows = await sql.query<Row>(
      `select ${COLUMNS} from app_audit_log ${where.length ? `where ${where.join(" and ")}` : ""}
       order by date_trunc('milliseconds', created_at) desc, id desc limit ${limit + 1}`,
      params,
    );
    const hasMore = rows.length > limit;
    return { entries: rows.slice(0, limit).map((r) => mapRow(r, isAdmin)), hasMore };
  });

/** Full history of ONE card (kept even after the card is deleted). */
export const listCardAudit = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ cardId: z.string().min(1).max(100) })))
  .handler(async ({ data }): Promise<AuditEntry[]> => {
    const sql = await getSql();
    const rows = await sql.query<Row>(
      `select ${COLUMNS} from app_audit_log where card_id = $1 order by created_at desc, id desc limit 500`,
      [data.cardId],
    );
    return rows.map((r) => mapRow(r, false));
  });

export type AuditStats = {
  days: number;
  total: number;
  byCategory: { category: string; n: number }[];
  byActor: { actor: string; actorName: string; n: number }[];
  byDay: { day: string; n: number }[];
};

/** Admin only: small numbers for the header of the log page. */
export const auditStats = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .validator(parse(z.object({ days: z.number().int().min(1).max(90).optional() })))
  .handler(async ({ data }): Promise<AuditStats> => {
    const days = data.days ?? 14;
    const sql = await getSql();
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const byCategory = await sql<{ category: string; n: number }>`
      select category, count(*)::int as n from app_audit_log where created_at >= ${since}::timestamptz
      group by category order by n desc
    `;
    const byActor = await sql<{ actor: string; actor_name: string; n: number }>`
      select actor, max(actor_name) as actor_name, count(*)::int as n from app_audit_log
      where created_at >= ${since}::timestamptz group by actor order by n desc limit 8
    `;
    const byDay = await sql<{ day: string; n: number }>`
      select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as n
      from app_audit_log where created_at >= ${since}::timestamptz group by 1 order by 1
    `;
    return {
      days,
      total: byCategory.reduce((a, b) => a + b.n, 0),
      byCategory,
      byActor: byActor.map((r) => ({ actor: r.actor, actorName: r.actor_name || r.actor, n: r.n })),
      byDay,
    };
  });
