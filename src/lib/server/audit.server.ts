import { getRequest } from "@tanstack/react-start/server";
import { getSql } from "../db";
import { nid } from "../utils";

/**
 * Central audit trail. EVERY meaningful change in the app calls `audit(...)`.
 * It never throws — a logging problem must never break the user's action.
 * MUST stay `.server.ts` and be imported dynamically from server code only.
 */
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

export type AuditInput = {
  actor: string;
  actorName?: string;
  category: AuditCategory;
  action: string;
  summary: string;
  boardId?: string | null;
  boardTitle?: string | null;
  cardId?: string | null;
  cardTitle?: string | null;
  details?: unknown;
};

function requestIp(): string | null {
  try {
    const req = getRequest();
    const realIp = req?.headers.get("x-real-ip")?.trim();
    if (realIp && realIp.length <= 64 && !/[\r\n,]/.test(realIp)) return realIp;
    const hops = (req?.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const rightMost = hops.at(-1);
    return rightMost && rightMost.length <= 64 ? rightMost : null;
  } catch {
    return null;
  }
}

export async function audit(input: AuditInput | AuditInput[]): Promise<void> {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) return;
  try {
    const sql = await getSql();
    const ip = requestIp();
    for (const e of list) {
      await sql`
        insert into app_audit_log (
          id, actor, actor_name, category, action, board_id, board_title, card_id, card_title, summary, details, ip
        ) values (
          ${nid()}, ${e.actor.slice(0, 64)}, ${(e.actorName ?? "").slice(0, 120)}, ${e.category}, ${e.action.slice(0, 60)},
          ${e.boardId ?? null}, ${e.boardTitle?.slice(0, 200) ?? null}, ${e.cardId ?? null}, ${e.cardTitle?.slice(0, 200) ?? null},
          ${e.summary.slice(0, 600)}, ${e.details === undefined ? null : JSON.stringify(e.details)}::jsonb, ${ip}
        )
      `;
    }
    // housekeeping: keep one year
    await sql`delete from app_audit_log where created_at < now() - interval '400 days'`;
  } catch (err) {
    console.error("[audit] failed:", err instanceof Error ? err.message : err);
  }
}
