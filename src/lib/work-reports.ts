import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "./db";
import { authMiddleware, workspaceWriteLock } from "./session-middleware";
import { pushCardActivity } from "./work-reports-helpers";
import { nid } from "./utils";
import { parse } from "./validate";

/* ───────── shared vocabulary (used by server and UI) ───────── */

export const REPORT_KINDS = [
  "general",
  "daily",
  "weekly",
  "issue",
  "request",
  "completion",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  general: "عمومی",
  daily: "روزانه",
  weekly: "هفتگی",
  issue: "مشکل / مانع",
  request: "درخواست",
  completion: "تحویل کار",
};

export const REPORT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type ReportPriority = (typeof REPORT_PRIORITIES)[number];
export const REPORT_PRIORITY_LABEL: Record<ReportPriority, string> = {
  low: "کم",
  normal: "عادی",
  high: "مهم",
  urgent: "فوری",
};

export const REPORT_STATUSES = [
  "sent",
  "seen",
  "in_review",
  "approved",
  "needs_revision",
  "rejected",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  sent: "ارسال شده",
  seen: "دیده شد",
  in_review: "در حال بررسی",
  approved: "تأیید شد",
  needs_revision: "نیاز به اصلاح",
  rejected: "رد شد",
};
/** Statuses a recipient may set by hand (sent / seen are automatic). */
const REVIEW_STATUSES = [
  "in_review",
  "approved",
  "needs_revision",
  "rejected",
] as const;

export type ReportAttachment = {
  fileId: string;
  name: string;
  size: number;
  mime: string;
};

export type WorkReport = {
  id: string;
  fromUsername: string;
  toUsername: string;
  boardId: string | null;
  boardTitle: string | null;
  cardId: string | null;
  cardTitle: string | null;
  subject: string;
  kind: ReportKind;
  priority: ReportPriority;
  status: ReportStatus;
  statusNote: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  groupId: string | null;
  body: string;
  /** legacy single attachment (kept so old reports still open) */
  fileId: string | null;
  filename: string | null;
  attachments: ReportAttachment[];
  parentId: string | null;
  createdAt: string;
  readAt: string | null;
  archived: boolean;
  commentCount: number;
};

export type ReportComment = {
  id: string;
  reportId: string;
  author: string;
  body: string;
  kind: "comment" | "status";
  createdAt: string;
};

type Row = {
  id: string;
  from_username: string;
  to_username: string;
  board_id: string | null;
  board_title: string | null;
  card_id: string | null;
  card_title: string | null;
  subject: string | null;
  kind: string | null;
  priority: string | null;
  status: string | null;
  status_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  group_id: string | null;
  body: string;
  file_id: string | null;
  filename: string | null;
  attachments: unknown;
  parent_id: string | null;
  created_at: string;
  read_at: string | null;
  archived_by_to: boolean | null;
  archived_by_from: boolean | null;
  comment_count?: number | null;
};

function pick<T extends string>(
  list: readonly T[],
  v: string | null | undefined,
  fallback: T,
): T {
  return (list as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
}

function parseAttachments(
  raw: unknown,
  legacyId: string | null,
  legacyName: string | null,
): ReportAttachment[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = [];
    }
  }
  const out: ReportAttachment[] = [];
  if (Array.isArray(value)) {
    for (const a of value) {
      if (
        a &&
        typeof a === "object" &&
        typeof (a as { fileId?: unknown }).fileId === "string"
      ) {
        const x = a as Partial<ReportAttachment>;
        out.push({
          fileId: String(x.fileId),
          name: String(x.name ?? "file"),
          size: Number(x.size ?? 0),
          mime: String(x.mime ?? ""),
        });
      }
    }
  }
  if (out.length === 0 && legacyId) {
    out.push({
      fileId: legacyId,
      name: legacyName || "file",
      size: 0,
      mime: "",
    });
  }
  return out;
}

function mapRow(r: Row, me: string): WorkReport {
  return {
    id: r.id,
    fromUsername: r.from_username,
    toUsername: r.to_username,
    boardId: r.board_id,
    boardTitle: r.board_title,
    cardId: r.card_id,
    cardTitle: r.card_title,
    subject: r.subject ?? "",
    kind: pick(REPORT_KINDS, r.kind, "general"),
    priority: pick(REPORT_PRIORITIES, r.priority, "normal"),
    status: pick(REPORT_STATUSES, r.status, "sent"),
    statusNote: r.status_note ?? "",
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
    groupId: r.group_id,
    body: r.body,
    fileId: r.file_id,
    filename: r.filename,
    attachments: parseAttachments(r.attachments, r.file_id, r.filename),
    parentId: r.parent_id,
    createdAt: r.created_at,
    readAt: r.read_at,
    archived:
      r.to_username === me
        ? Boolean(r.archived_by_to)
        : Boolean(r.archived_by_from),
    commentCount: r.comment_count ?? 0,
  };
}

const COUNT_SQL = `(select count(*)::int from app_work_report_comments c where c.report_id = r.id and c.kind = 'comment') as comment_count`;

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

async function notify(
  to: string,
  title: string,
  body: string,
  href = "/reports-inbox",
) {
  try {
    const sql = await getSql();
    await sql`
      insert into app_notifications (id, username, kind, title, body, href, read_at, created_at)
      values (${nid()}, ${to}, 'work_report', ${title.slice(0, 160)}, ${body.slice(0, 160)}, ${href}, null, ${new Date().toISOString()})
    `;
  } catch {
    /* notifications table may lag */
  }
}

/* ───────── sending ───────── */

const sendSchema = z.object({
  /** several recipients are allowed: one report row per person, tied together by group_id */
  toUsernames: z
    .array(z.string().trim().toLowerCase().min(1).max(64))
    .min(1)
    .max(30),
  subject: z.string().trim().max(160).optional(),
  kind: z.enum(REPORT_KINDS).optional(),
  priority: z.enum(REPORT_PRIORITIES).optional(),
  boardId: z.string().max(100).optional(),
  boardTitle: z.string().max(200).optional(),
  cardId: z.string().max(100).optional(),
  cardTitle: z.string().max(200).optional(),
  body: z.string().max(20_000),
  attachments: z
    .array(
      z.object({
        fileId: z.string().min(1).max(100),
        name: z.string().max(200),
        size: z.number().int().min(0).max(50_000_000),
        mime: z.string().max(120),
      }),
    )
    .max(6)
    .optional(),
  parentId: z.string().max(100).optional(),
});

// workspaceWriteLock: this also appends to a card's activity log inside the shared workspace JSON
export const sendWorkReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware, workspaceWriteLock])
  .validator(parse(sendSchema))
  .handler(async ({ data, context }) => {
    const from = context.user.username; // always the logged-in user
    const fromName = context.user.displayName;
    const recipients = Array.from(new Set(data.toUsernames)).filter(
      (u) => u !== from,
    );
    if (recipients.length === 0) throw new Error("گیرنده الزامی است.");
    const body = data.body.trim();
    const attachInput = data.attachments ?? [];
    if (!body && attachInput.length === 0)
      throw new Error("متن یا فایل گزارش لازم است.");

    const sql = await getSql();
    const found = await sql.query<{ username: string; display_name: string }>(
      `select username, display_name from login_users where username = any($1::text[])`,
      [recipients],
    );
    if (found.length !== recipients.length) throw new Error("گیرنده پیدا نشد.");

    // only files this user uploaded may be attached (real name / size / type come from the database)
    let attachments: ReportAttachment[] = [];
    if (attachInput.length > 0) {
      const files = await sql.query<{
        id: string;
        filename: string;
        mime: string;
        size_bytes: number;
      }>(
        `select id, filename, mime, size_bytes from app_files where id = any($1::text[]) and uploaded_by = $2`,
        [attachInput.map((a) => a.fileId), from],
      );
      if (files.length !== new Set(attachInput.map((a) => a.fileId)).size)
        throw new Error("فایل نامعتبر است.");
      attachments = files.map((f) => ({
        fileId: f.id,
        name: f.filename,
        size: f.size_bytes,
        mime: f.mime,
      }));
    }
    const first = attachments[0];

    const subject =
      (data.subject ?? "").trim() ||
      body.split("\n")[0]?.slice(0, 80) ||
      first?.name ||
      "گزارش";
    const kind = data.kind ?? "general";
    const priority = data.priority ?? "normal";
    const groupId = nid();
    const now = new Date().toISOString();
    const ids: string[] = [];

    for (const to of recipients) {
      const id = nid();
      ids.push(id);
      await sql`
        insert into app_work_reports (
          id, from_username, to_username, board_id, board_title, card_id, card_title,
          body, file_id, filename, parent_id, created_at, read_at,
          subject, kind, priority, status, group_id, attachments
        ) values (
          ${id}, ${from}, ${to},
          ${data.boardId ?? null}, ${data.boardTitle ?? null},
          ${data.cardId ?? null}, ${data.cardTitle ?? null},
          ${body},
          ${first?.fileId ?? null}, ${first?.name.slice(0, 200) ?? null},
          ${data.parentId ?? null}, ${now}, null,
          ${subject}, ${kind}, ${priority}, 'sent', ${groupId}, ${JSON.stringify(attachments)}::jsonb
        )
      `;
      await notify(
        to,
        `${data.parentId ? "ارجاع گزارش" : "گزارش جدید"} از ${fromName}${priority === "urgent" ? " (فوری)" : ""}`,
        subject,
      );
    }

    const names = found.map((f) => f.display_name || f.username).join("، ");
    if (data.cardId) {
      await pushCardActivity(
        data.cardId,
        fromName,
        `گزارش «${subject}» ارسال شد به ${names}${data.parentId ? " (ارجاع)" : ""}`,
      );
    }
    await safeAudit({
      actor: from,
      actorName: fromName,
      category: "report",
      action: data.parentId ? "report.forward" : "report.send",
      summary: `گزارش «${subject}» برای ${names} ارسال شد`,
      boardId: data.boardId ?? null,
      boardTitle: data.boardTitle ?? null,
      cardId: data.cardId ?? null,
      cardTitle: data.cardTitle ?? null,
      details: {
        ids,
        kind,
        priority,
        recipients,
        attachments: attachments.length,
      },
    });
    return { ok: true as const, id: ids[0]!, ids };
  });

/* ───────── lists ───────── */

const listSchema = z.object({
  archived: z.boolean().optional(),
  username: z.string().optional(), // legacy field — ignored, the session decides
});

export const listInboxReports = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(parse(listSchema))
  .handler(async ({ data, context }): Promise<WorkReport[]> => {
    const u = context.user.username;
    const sql = await getSql();
    const rows = await sql.query<Row>(
      `select r.*, ${COUNT_SQL} from app_work_reports r
       where r.to_username = $1 and r.archived_by_to = $2
       order by r.created_at desc limit 300`,
      [u, Boolean(data.archived)],
    );
    return rows.map((r) => mapRow(r, u));
  });

export const listSentReports = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(parse(listSchema))
  .handler(async ({ data, context }): Promise<WorkReport[]> => {
    const u = context.user.username;
    const sql = await getSql();
    const rows = await sql.query<Row>(
      `select r.*, ${COUNT_SQL} from app_work_reports r
       where r.from_username = $1 and r.archived_by_from = $2
       order by r.created_at desc limit 300`,
      [u, Boolean(data.archived)],
    );
    return rows.map((r) => mapRow(r, u));
  });

/* ───────── one report with its thread ───────── */

export type ReportDetail = {
  report: WorkReport;
  comments: ReportComment[];
  /** the sender sees how every recipient of the same send is doing */
  siblings: {
    id: string;
    username: string;
    status: ReportStatus;
    readAt: string | null;
  }[];
};

async function loadComments(reportId: string): Promise<ReportComment[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    report_id: string;
    author: string;
    body: string;
    kind: string;
    created_at: string;
  }>`select id, report_id, author, body, kind, created_at from app_work_report_comments where report_id = ${reportId} order by created_at asc, id asc limit 500`;
  return rows.map((c) => ({
    id: c.id,
    reportId: c.report_id,
    author: c.author,
    body: c.body,
    kind: c.kind === "status" ? "status" : "comment",
    createdAt: c.created_at,
  }));
}

export const getWorkReport = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        id: z.string().min(1).max(100),
        username: z.string().optional(),
      }),
    ),
  )
  .handler(async ({ data, context }): Promise<ReportDetail | null> => {
    const sql = await getSql();
    const u = context.user.username;
    const rows = await sql.query<Row>(
      `select r.*, ${COUNT_SQL} from app_work_reports r where r.id = $1`,
      [data.id],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.to_username !== u && r.from_username !== u) return null;

    // the recipient opening it = "seen"
    if (r.to_username === u && !r.read_at) {
      const now = new Date().toISOString();
      const nextStatus = (r.status ?? "sent") === "sent" ? "seen" : r.status;
      await sql`update app_work_reports set read_at = ${now}, status = ${nextStatus} where id = ${data.id}`;
      r.read_at = now;
      r.status = nextStatus;
      await safeAudit({
        actor: u,
        actorName: context.user.displayName,
        category: "report",
        action: "report.read",
        summary: `گزارش «${r.subject || "بدون موضوع"}» از ${r.from_username} خوانده شد`,
        boardId: r.board_id,
        boardTitle: r.board_title,
        cardId: r.card_id,
        cardTitle: r.card_title,
        details: { id: r.id },
      });
    }

    let siblings: ReportDetail["siblings"] = [];
    if (r.from_username === u && r.group_id) {
      const sib = await sql<{
        id: string;
        to_username: string;
        status: string | null;
        read_at: string | null;
      }>`
        select id, to_username, status, read_at from app_work_reports where group_id = ${r.group_id} order by to_username
      `;
      siblings = sib.map((s) => ({
        id: s.id,
        username: s.to_username,
        status: pick(REPORT_STATUSES, s.status, "sent"),
        readAt: s.read_at,
      }));
    }
    return {
      report: mapRow(r, u),
      comments: await loadComments(r.id),
      siblings,
    };
  });

/* ───────── review status ───────── */

export const setReportStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware, workspaceWriteLock])
  .validator(
    parse(
      z.object({
        id: z.string().min(1).max(100),
        status: z.enum(REVIEW_STATUSES),
        note: z.string().trim().max(2000).optional(),
      }),
    ),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const u = context.user.username;
      const name = context.user.displayName;
      const sql = await getSql();
      const rows =
        await sql<Row>`select * from app_work_reports where id = ${data.id}`;
      const r = rows[0];
      if (!r || r.to_username !== u)
        return {
          ok: false,
          error: "فقط گیرندهٔ گزارش می‌تواند وضعیت را تغییر دهد.",
        };
      const note = (data.note ?? "").trim();
      if (
        (data.status === "rejected" || data.status === "needs_revision") &&
        !note
      ) {
        return { ok: false, error: "برای این وضعیت یک توضیح بنویسید." };
      }
      const now = new Date().toISOString();
      await sql`
      update app_work_reports
      set status = ${data.status}, status_note = ${note}, reviewed_at = ${now}, reviewed_by = ${u},
          read_at = coalesce(read_at, ${now})
      where id = ${data.id}
    `;
      await sql`
      insert into app_work_report_comments (id, report_id, author, body, kind, created_at)
      values (${nid()}, ${data.id}, ${u}, ${`${REPORT_STATUS_LABEL[data.status]}${note ? `: ${note}` : ""}`}, 'status', ${now})
    `;
      const subject = r.subject || "گزارش";
      await notify(
        r.from_username,
        `${REPORT_STATUS_LABEL[data.status]}: ${subject}`,
        note || `توسط ${name}`,
      );
      if (r.card_id) {
        await pushCardActivity(
          r.card_id,
          name,
          `گزارش «${subject}» — ${REPORT_STATUS_LABEL[data.status]}`,
        );
      }
      await safeAudit({
        actor: u,
        actorName: name,
        category: "report",
        action: "report.status",
        summary: `گزارش «${subject}» از ${r.from_username}: ${REPORT_STATUS_LABEL[data.status]}${note ? ` — ${note.slice(0, 120)}` : ""}`,
        boardId: r.board_id,
        boardTitle: r.board_title,
        cardId: r.card_id,
        cardTitle: r.card_title,
        details: { id: r.id, status: data.status },
      });
      return { ok: true as const };
    },
  );

/* ───────── comments ───────── */

export const addReportComment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        id: z.string().min(1).max(100),
        body: z.string().trim().min(1).max(5000),
      }),
    ),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const u = context.user.username;
      const sql = await getSql();
      const rows =
        await sql<Row>`select * from app_work_reports where id = ${data.id}`;
      const r = rows[0];
      if (!r || (r.to_username !== u && r.from_username !== u))
        return { ok: false, error: "گزارش پیدا نشد." };
      await sql`
      insert into app_work_report_comments (id, report_id, author, body, kind, created_at)
      values (${nid()}, ${data.id}, ${u}, ${data.body}, 'comment', ${new Date().toISOString()})
    `;
      const other = r.to_username === u ? r.from_username : r.to_username;
      await notify(
        other,
        `پیام جدید دربارهٔ «${r.subject || "گزارش"}»`,
        `${context.user.displayName}: ${data.body}`,
      );
      await safeAudit({
        actor: u,
        actorName: context.user.displayName,
        category: "report",
        action: "report.comment",
        summary: `یادداشت روی گزارش «${r.subject || "بدون موضوع"}»: ${data.body.slice(0, 120)}`,
        boardId: r.board_id,
        boardTitle: r.board_title,
        cardId: r.card_id,
        cardTitle: r.card_title,
        details: { id: r.id },
      });
      return { ok: true as const };
    },
  );

/* ───────── archive (each side keeps its own) ───────── */

export const archiveReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(z.object({ id: z.string().min(1).max(100), archived: z.boolean() })),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const u = context.user.username;
    const sql = await getSql();
    const rows =
      await sql<Row>`select * from app_work_reports where id = ${data.id}`;
    const r = rows[0];
    if (!r || (r.to_username !== u && r.from_username !== u))
      return { ok: false };
    if (r.to_username === u) {
      await sql`update app_work_reports set archived_by_to = ${data.archived} where id = ${data.id}`;
    } else {
      await sql`update app_work_reports set archived_by_from = ${data.archived} where id = ${data.id}`;
    }
    await safeAudit({
      actor: u,
      actorName: context.user.displayName,
      category: "report",
      action: data.archived ? "report.archive" : "report.unarchive",
      summary: `گزارش «${r.subject || "بدون موضوع"}» ${data.archived ? "بایگانی" : "از بایگانی خارج"} شد`,
      cardId: r.card_id,
      cardTitle: r.card_title,
      details: { id: r.id },
    });
    return { ok: true };
  });

/* ───────── badges ───────── */

export const unreadWorkReportCount = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ username: z.string().optional() })))
  .handler(async ({ context }): Promise<number> => {
    const u = context.user.username;
    const sql = await getSql();
    const rows = await sql<{ n: number }>`
      select count(*)::int as n from app_work_reports
      where to_username = ${u} and read_at is null and archived_by_to = false
    `;
    return rows[0]?.n ?? 0;
  });
