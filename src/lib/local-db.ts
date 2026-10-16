// Shared workspace data layer.
//
// This used to read/write the browser's localStorage, so every user had a
// private, never-synced copy of the boards/tasks/people. Every export below
// now runs on the SERVER (via TanStack Start's `createServerFn`) against the
// `workspace_state` table in Postgres (see migrations/0002_workspace.sql), so
// every user — any device, any browser — sees the exact same data.
//
// The exported function names, input shapes (`{ data: {...} }`) and return
// types are unchanged from before on purpose, so every component that already
// calls these (board-context.tsx, workspace-layout.tsx, routes/*, ...) keeps
// working without modification.
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "./db";
import type { LocalUser } from "./session-types";
import {
  adminMiddleware,
  authMiddleware,
  requireBoardAction,
  workspaceWriteLock,
} from "./session-middleware";
import { addDaysIso, isoToday } from "./jalali";
import type { Board, BoardSummary, Card, ChecklistItem, Label, List, Person, Priority } from "./types";
import { mid, nid } from "./utils";
import { z } from "zod";
import { describeCardChanges } from "./activity-diff";
import type { AuditInput } from "./server/audit.server";
import { checked } from "./validate";

/* ───────── input limits (runtime validation; the TypeScript types stay the same) ───────── */
const sId = z.string().min(1).max(100);
const sTitle = z.string().max(300);
const sIds = z.array(z.string().max(100)).max(500);
const S = {
  idOnly: z.looseObject({ id: sId }),
  boardIdOnly: z.looseObject({ boardId: sId }),
  createBoard: z.looseObject({ title: z.string().max(200), description: z.string().max(5000).optional() }),
  renameBoard: z.looseObject({ boardId: sId, title: z.string().max(200) }),
  createList: z.looseObject({ boardId: sId, title: sTitle, position: z.number() }),
  renameList: z.looseObject({ id: sId, title: sTitle }),
  moveList: z.looseObject({ id: sId, position: z.number() }),
  card: z.looseObject({
    title: sTitle.optional(),
    notes: z.string().max(20_000).optional(),
    priority: z.string().max(20).optional(),
    dueDate: z.string().max(40).nullable().optional(),
    startDate: z.string().max(40).nullable().optional(),
    coverColor: z.string().max(40).nullable().optional(),
    followerId: z.string().max(100).nullable().optional(),
    position: z.number().optional(),
    progress: z.number().optional(),
    memberIds: sIds.optional(),
    labelIds: sIds.optional(),
    dependsOnIds: sIds.optional(),
    checklists: z.array(z.unknown()).max(100).optional(),
  }),
  moveCard: z.looseObject({ id: sId, listId: sId, position: z.number() }),
  moveCardToBoard: z.looseObject({ cardId: sId, targetBoardId: sId, targetListId: sId }),
  comment: z.looseObject({ cardId: sId, body: z.string().max(5000), author: z.string().max(200).optional() }),
  checklist: z.looseObject({
    cardId: sId,
    id: sId.optional(),
    title: sTitle,
    items: z.array(z.unknown()).max(500),
    position: z.number().optional(),
  }),
  checklistItemAdd: z.looseObject({ checklistId: sId, title: sTitle }),
  checklistItemRef: z.looseObject({ checklistId: sId, itemId: sId }),
  archived: z.looseObject({ cardId: sId, archived: z.boolean(), by: z.string().max(200).optional() }),
  person: z.looseObject({
    id: sId.optional(),
    code: z.string().max(40),
    firstName: z.string().max(100),
    lastName: z.string().max(100),
    role: z.string().max(100),
    username: z.string().max(64).optional(),
  }),
  label: z.looseObject({ boardId: sId, name: z.string().max(100), color: z.string().max(40) }),
};


const WORKSPACE_ID = "main";

function clampProgress(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

type Workspace = {
  people: Person[];
  boards: Board[];
  archivedBoards?: Board[];
};

function isWorkspace(v: unknown): v is Workspace {
  return Boolean(v) && Array.isArray((v as Workspace).boards) && Array.isArray((v as Workspace).people);
}

function normalizeWorkspace(ws: Workspace): Workspace {
  if (!Array.isArray(ws.archivedBoards)) ws.archivedBoards = [];
  for (const b of ws.boards) {
    b.people = ws.people;
    if (!Array.isArray(b.labels)) b.labels = [];
    if (!Array.isArray(b.lists)) b.lists = [];
    for (const l of b.lists) {
      if (!Array.isArray(l.cards)) l.cards = [];
      for (const c of l.cards) {
        if (!Array.isArray(c.checklists)) c.checklists = [];
        if (!Array.isArray(c.comments)) c.comments = [];
        if (!Array.isArray(c.activities)) c.activities = [];
        if (!Array.isArray(c.dependsOnIds)) c.dependsOnIds = [];
        if (c.enteredListAt === undefined) c.enteredListAt = c.createdAt || null;
        if (!Array.isArray(c.memberIds)) c.memberIds = [];
        if (!Array.isArray(c.labelIds)) c.labelIds = [];
        for (const ch of c.checklists) {
          if (!Array.isArray(ch.items)) ch.items = [];
        }
      }
    }
  }
  return ws;
}


/** Load the single shared workspace row from Postgres, seeding it on first use. */
async function loadWorkspace(): Promise<Workspace> {
  const sql = await getSql();
  const rows = await sql<{ data: unknown }>`select data from workspace_state where id = ${WORKSPACE_ID}`;
  const raw = rows[0]?.data;
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (isWorkspace(parsed)) return normalizeWorkspace(parsed);
  const seeded = createSeedWorkspace();
  await saveWorkspace(seeded);
  return seeded;
}

async function saveWorkspace(ws: Workspace): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into workspace_state (id, data, updated_at)
    values (${WORKSPACE_ID}, ${JSON.stringify(ws)}::jsonb, now())
    on conflict (id) do update set data = excluded.data, updated_at = now()
  `;
}

function findBoard(ws: Workspace, id: string): Board | undefined {
  return ws.boards.find((b) => b.id === id);
}

function allCards(board: Board): Card[] {
  return board.lists.flatMap((l) => l.cards);
}

/** How many log lines a card keeps inside the workspace JSON (the full history is in app_audit_log). */
const MAX_CARD_ACTIVITIES = 300;

/** Finds a card anywhere in the workspace together with its list and board. */
function locateCard(ws: Workspace, cardId: string): { board: Board; list: List; card: Card } | null {
  for (const board of ws.boards) {
    for (const list of board.lists) {
      const card = list.cards.find((c) => c.id === cardId);
      if (card) return { board, list, card };
    }
  }
  return null;
}

/** Writes to the central audit log (never throws). */
type AuditEntry = Omit<AuditInput, "actor" | "actorName">;
async function logAudit(user: LocalUser, e: AuditEntry | AuditEntry[]): Promise<void> {
  const { audit } = await import("./server/audit.server");
  const list = Array.isArray(e) ? e : [e];
  await audit(list.map((x) => ({ actor: user.username, actorName: user.displayName, ...x })));
}

/** Serializes the whole workspace (boards + people) for manual backup. Runs server-side. */
export const exportWorkspaceJson = createServerFn({ method: "GET" }).middleware([adminMiddleware]).handler(async ({ context }): Promise<string> => {
  const ws = await loadWorkspace();
  await logAudit(context.user, { category: "system", action: "backup.export", summary: "از اطلاعات تخته‌ها فایل پشتیبان گرفت" });
  return JSON.stringify(ws, null, 2);
});

/** Restores a workspace previously produced by exportWorkspaceJson. Replaces the SHARED workspace for everyone. */
export const importWorkspaceJson = createServerFn({ method: "POST" }).middleware([adminMiddleware, workspaceWriteLock])
  .validator((raw: string) => raw)
  .handler(async ({ data: raw, context }): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (typeof raw !== "string" || raw.length > 20_000_000) {
      return { ok: false, error: "فایل پشتیبان خیلی بزرگ است." };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "فایل پشتیبان معتبر نیست (JSON خراب است)." };
    }
    if (!isWorkspace(parsed)) {
      return { ok: false, error: "ساختار فایل پشتیبان با این برنامه سازگار نیست." };
    }
    await saveWorkspace(parsed);
    await logAudit(context.user, {
      category: "system",
      action: "backup.import",
      summary: "اطلاعات تخته‌ها را از فایل پشتیبان بازیابی کرد (جایگزین اطلاعات فعلی)",
    });
    return { ok: true };
  });

export const listBoards = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(async (): Promise<BoardSummary[]> => {
  const ws = await loadWorkspace();
  return ws.boards.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    createdAt: b.lists[0]?.cards[0]?.createdAt ?? isoToday(),
    cardCount: allCards(b).filter((c) => !c.archived).length,
  }));
});

export const getBoard = createServerFn({ method: "GET" }).middleware([authMiddleware])
  .validator((data: { boardId: string }) => checked(S.boardIdOnly, data))
  .handler(async ({ data }): Promise<Board | null> => {
    const ws = await loadWorkspace();
    const b = findBoard(ws, data.boardId);
    if (!b) return null;
    return { ...b, people: ws.people };
  });

export const createBoard = createServerFn({ method: "POST" }).middleware([requireBoardAction("create_board"), workspaceWriteLock])
  .validator((data: { title: string; description?: string }) => checked(S.createBoard, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const board = newEmptyBoard(ws, data.title, data.description ?? "");
    ws.boards.unshift(board);
    await saveWorkspace(ws);
    await logAudit(context.user, {
      category: "board",
      action: "board.create",
      boardId: board.id,
      boardTitle: board.title,
      summary: `تخته ${"«" + board.title + "»"} را ساخت`,
    });
    return { id: board.id };
  });

export const renameBoard = createServerFn({ method: "POST" }).middleware([requireBoardAction("rename_board"), workspaceWriteLock])
  .validator((data: { boardId: string; title: string }) => checked(S.renameBoard, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const b = findBoard(ws, data.boardId);
    const oldTitle = b?.title ?? "";
    if (b) b.title = data.title;
    await saveWorkspace(ws);
    if (b && oldTitle !== data.title) {
      await logAudit(context.user, {
        category: "board",
        action: "board.rename",
        boardId: b.id,
        boardTitle: b.title,
        summary: `نام تخته را از «${oldTitle}» به «${data.title}» تغییر داد`,
      });
    }
    return { ok: true as const };
  });

export const archiveBoard = createServerFn({ method: "POST" }).middleware([requireBoardAction("archive_board"), workspaceWriteLock])
  .validator((data: { boardId: string }) => checked(S.boardIdOnly, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    if (!ws.archivedBoards) ws.archivedBoards = [];
    const idx = ws.boards.findIndex((b) => b.id === data.boardId);
    if (idx < 0) return { ok: true as const };
    const [board] = ws.boards.splice(idx, 1);
    if (board) ws.archivedBoards.unshift(board);
    await saveWorkspace(ws);
    if (board) {
      await logAudit(context.user, {
        category: "board",
        action: "board.archive",
        boardId: board.id,
        boardTitle: board.title,
        summary: `تخته «${board.title}» را بایگانی کرد`,
      });
    }
    return { ok: true as const };
  });

export const listArchivedBoards = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(async (): Promise<BoardSummary[]> => {
  const ws = await loadWorkspace();
  return (ws.archivedBoards ?? []).map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    createdAt: b.lists[0]?.cards[0]?.createdAt ?? isoToday(),
    cardCount: allCards(b).filter((c) => !c.archived).length,
  }));
});

export const restoreBoard = createServerFn({ method: "POST" }).middleware([requireBoardAction("archive_board"), workspaceWriteLock])
  .validator((data: { boardId: string }) => checked(S.boardIdOnly, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    if (!ws.archivedBoards) ws.archivedBoards = [];
    const idx = ws.archivedBoards.findIndex((b) => b.id === data.boardId);
    if (idx < 0) throw new Error("تخته بایگانی‌شده پیدا نشد");
    const [board] = ws.archivedBoards.splice(idx, 1);
    if (board) ws.boards.unshift(board);
    await saveWorkspace(ws);
    if (board) {
      await logAudit(context.user, {
        category: "board",
        action: "board.restore",
        boardId: board.id,
        boardTitle: board.title,
        summary: `تخته «${board.title}» را از بایگانی بازگرداند`,
      });
    }
    return { ok: true as const };
  });

/** Permanent delete — only from archived list. */
export const deleteBoardPermanently = createServerFn({ method: "POST" }).middleware([requireBoardAction("archive_board"), workspaceWriteLock])
  .validator((data: { boardId: string }) => checked(S.boardIdOnly, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    if (!ws.archivedBoards) ws.archivedBoards = [];
    const doomed = ws.archivedBoards.find((b) => b.id === data.boardId) ?? findBoard(ws, data.boardId);
    ws.archivedBoards = ws.archivedBoards.filter((b) => b.id !== data.boardId);
    // also allow delete from active if forced
    ws.boards = ws.boards.filter((b) => b.id !== data.boardId);
    await saveWorkspace(ws);
    await logAudit(context.user, {
      category: "board",
      action: "board.delete",
      boardId: data.boardId,
      boardTitle: doomed?.title ?? null,
      summary: `تخته «${doomed?.title ?? "؟"}» را برای همیشه حذف کرد`,
    });
    return { ok: true as const };
  });

export const createList = createServerFn({ method: "POST" }).middleware([requireBoardAction("create_list"), workspaceWriteLock])
  .validator((data: { boardId: string; title: string; position: number }) => checked(S.createList, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const b = findBoard(ws, data.boardId);
    if (!b) throw new Error("تخته پیدا نشد");
    const id = nid();
    b.lists.push({ id, boardId: b.id, title: data.title, position: data.position, cards: [] });
    b.lists.sort((a, c) => a.position - c.position);
    await saveWorkspace(ws);
    await logAudit(context.user, {
      category: "list",
      action: "list.create",
      boardId: b.id,
      boardTitle: b.title,
      summary: `ستون «${data.title}» را ساخت`,
    });
    return { id };
  });

export const renameList = createServerFn({ method: "POST" }).middleware([requireBoardAction("rename_list"), workspaceWriteLock])
  .validator((data: { id: string; title: string }) => checked(S.renameList, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    for (const b of ws.boards) {
      const l = b.lists.find((x) => x.id === data.id);
      if (l) {
        const old = l.title;
        l.title = data.title;
        await saveWorkspace(ws);
        if (old !== data.title) {
          await logAudit(context.user, {
            category: "list",
            action: "list.rename",
            boardId: b.id,
            boardTitle: b.title,
            summary: `نام ستون را از «${old}» به «${data.title}» تغییر داد`,
          });
        }
        return { ok: true as const };
      }
    }
    return { ok: true as const };
  });

export const deleteList = createServerFn({ method: "POST" }).middleware([requireBoardAction("delete_list"), workspaceWriteLock])
  .validator((data: { id: string }) => checked(S.idOnly, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const doomedAudit: AuditEntry[] = [];
    for (const b of ws.boards) {
      const l = b.lists.find((x) => x.id === data.id);
      if (l) {
        const n = l.cards.length;
        doomedAudit.push({
          category: "list",
          action: "list.delete",
          boardId: b.id,
          boardTitle: b.title,
          summary: `ستون «${l.title}» را حذف کرد${n ? ` (همراه با ${n.toLocaleString("fa-IR")} کارت)` : ""}`,
          details: { cards: l.cards.map((c) => c.title).slice(0, 100) },
        });
      }
      b.lists = b.lists.filter((x) => x.id !== data.id);
    }
    await saveWorkspace(ws);
    await logAudit(context.user, doomedAudit);
    return { ok: true as const };
  });

export const moveList = createServerFn({ method: "POST" }).middleware([requireBoardAction("move_list"), workspaceWriteLock])
  .validator((data: { id: string; position: number }) => checked(S.moveList, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    for (const b of ws.boards) {
      const l = b.lists.find((x) => x.id === data.id);
      if (l) {
        l.position = data.position;
        b.lists.sort((a, c) => a.position - c.position);
        await saveWorkspace(ws);
        await logAudit(context.user, {
          category: "list",
          action: "list.move",
          boardId: b.id,
          boardTitle: b.title,
          summary: `جای ستون «${l.title}» را عوض کرد`,
        });
        return { ok: true as const };
      }
    }
    return { ok: true as const };
  });

type CardPatch = Partial<Card> & { id?: string; boardId?: string; listId?: string; title?: string };

export const createCard = createServerFn({ method: "POST" }).middleware([requireBoardAction("create_card"), workspaceWriteLock])
  .validator((data: CardPatch & { boardId: string; listId: string; title: string }) =>
    checked(S.card.extend({ boardId: sId, listId: sId, title: sTitle }), data),
  )
  .handler(async ({ data: d, context }) => {
    const ws = await loadWorkspace();
    const b = findBoard(ws, d.boardId);
    if (!b) throw new Error("تخته پیدا نشد");
    const list = b.lists.find((l) => l.id === d.listId);
    if (!list) throw new Error("ستون پیدا نشد");
    const id = nid();
    const card: Card = {
      id,
      listId: d.listId,
      boardId: d.boardId,
      title: d.title,
      notes: d.notes ?? "",
      priority: (d.priority as Priority) ?? "med",
      dueDate: d.dueDate ?? null,
      startDate: d.startDate ?? null,
      coverColor: d.coverColor ?? null,
      position: d.position ?? mid(list.cards[list.cards.length - 1]?.position, undefined),
      archived: false,
      followerId: d.followerId ?? null,
      memberIds: d.memberIds ?? [],
      labelIds: d.labelIds ?? [],
      progress: typeof d.progress === "number" ? clampProgress(d.progress) : 0,
      createdAt: isoToday(),
      checklists: Array.isArray(d.checklists) ? d.checklists : [],
      comments: [],
      activities: [
        {
          id: nid(),
          at: new Date().toISOString(),
          by: context.user.displayName,
          text: `کارت را در ستون «${list.title}» ایجاد کرد`,
        },
      ],
      dependsOnIds: Array.isArray(d.dependsOnIds) ? d.dependsOnIds : [],
      enteredListAt: new Date().toISOString(),
    };
    list.cards.push(card);
    await saveWorkspace(ws);
    await logAudit(context.user, {
      category: "card",
      action: "card.create",
      boardId: b.id,
      boardTitle: b.title,
      cardId: id,
      cardTitle: card.title,
      summary: `کارت «${card.title}» را در ستون «${list.title}» ایجاد کرد`,
    });
    return { id };
  });

/**
 * The card editor always sends the WHOLE card, so we only look at the fields that
 * really CHANGED and require the matching permission for each of them.
 */
function assertPatchAllowed(card: Card, d: Partial<Card>, denied: Set<string>): void {
  const norm = (v: unknown) => JSON.stringify(v ?? null);
  const changed = (k: keyof Card) => d[k] !== undefined && norm(d[k]) !== norm(card[k]);
  const need = new Set<string>();
  if (changed("title") || changed("notes") || changed("coverColor") || changed("labelIds") || changed("dependsOnIds")) {
    need.add("edit_card");
  }
  if (changed("memberIds") || changed("followerId")) need.add("assign_people");
  if (changed("dueDate") || changed("startDate")) need.add("change_dates");
  if (changed("priority")) need.add("change_priority");
  if (changed("progress")) need.add("change_progress");
  if (changed("listId") || changed("position")) need.add("move_card");
  for (const action of need) if (denied.has(action)) throw new Error("ACTION_LOCKED");
}

async function applyCardPatch(d: Partial<Card> & { id: string }, user: LocalUser): Promise<{ ok: true }> {
  const { deniedActionsFor } = await import("./server/permissions.server");
  const denied = new Set(await deniedActionsFor(user));
  const ws = await loadWorkspace();
  for (const b of ws.boards) {
    for (const l of b.lists) {
      const idx = l.cards.findIndex((c) => c.id === d.id);
      if (idx < 0) continue;
      let card = l.cards[idx]!;
      assertPatchAllowed(card, d, denied);
      // Work out, BEFORE anything is changed, which fields really changed (for the card log + audit log).
      const normPatch: Partial<Card> = { ...d };
      if (d.progress != null) normPatch.progress = clampProgress(d.progress);
      const changes = describeCardChanges(card, normPatch, {
        people: ws.people,
        labels: b.labels,
        lists: b.lists,
        cardTitleOf: (cid) => locateCard(ws, cid)?.card.title,
      });
      if (d.listId && d.listId !== l.id) {
        const dest = b.lists.find((x) => x.id === d.listId);
        if (dest) {
          l.cards.splice(idx, 1);
          card = { ...card, listId: dest.id, enteredListAt: new Date().toISOString() };
          dest.cards.push(card);
        }
      }
      Object.assign(card, {
        ...(d.title != null ? { title: d.title } : {}),
        ...(d.notes != null ? { notes: d.notes } : {}),
        ...(d.priority != null ? { priority: d.priority } : {}),
        ...(d.dueDate !== undefined ? { dueDate: d.dueDate } : {}),
        ...(d.startDate !== undefined ? { startDate: d.startDate } : {}),
        ...(d.coverColor !== undefined ? { coverColor: d.coverColor } : {}),
        ...(d.followerId !== undefined ? { followerId: d.followerId } : {}),
        ...(d.memberIds ? { memberIds: d.memberIds } : {}),
        ...(d.labelIds ? { labelIds: d.labelIds } : {}),
        ...(d.dependsOnIds ? { dependsOnIds: d.dependsOnIds } : {}),
        ...(d.progress != null ? { progress: clampProgress(d.progress) } : {}),
        ...(d.position != null ? { position: d.position } : {}),
      });
      for (const ch of [...changes].reverse()) pushActivity(card, user.displayName, ch.text);
      await saveWorkspace(ws);
      await logAudit(
        user,
        changes.map((ch) => ({
          category: "card" as const,
          action: ch.action,
          boardId: b.id,
          boardTitle: b.title,
          cardId: card.id,
          cardTitle: card.title,
          summary: ch.text,
        })),
      );
      return { ok: true as const };
    }
  }
  return { ok: true as const };
}

export const updateCard = createServerFn({ method: "POST" }).middleware([authMiddleware, workspaceWriteLock])
  .validator((data: Partial<Card> & { id: string }) => checked(S.card.extend({ id: sId }), data))
  .handler(async ({ data, context }) => applyCardPatch(data, context.user));

export const moveCard = createServerFn({ method: "POST" }).middleware([authMiddleware, workspaceWriteLock])
  .validator((data: { id: string; listId: string; position: number }) => checked(S.moveCard, data))
  .handler(async ({ data, context }) => applyCardPatch(data, context.user));


export const moveCardToBoard = createServerFn({ method: "POST" }).middleware([requireBoardAction("move_card"), workspaceWriteLock])
  .validator((data: { cardId: string; targetBoardId: string; targetListId: string }) =>
    checked(S.moveCardToBoard, data),
  )
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    let card: Card | null = null;
    let sourceBoardId = "";
    for (const b of ws.boards) {
      for (const l of b.lists) {
        const idx = l.cards.findIndex((c) => c.id === data.cardId);
        if (idx < 0) continue;
        card = l.cards[idx]!;
        sourceBoardId = b.id;
        l.cards.splice(idx, 1);
        break;
      }
      if (card) break;
    }
    if (!card) throw new Error("کارت پیدا نشد");
    const destBoard = findBoard(ws, data.targetBoardId);
    if (!destBoard) throw new Error("تخته مقصد پیدا نشد");
    const destList = destBoard.lists.find((l) => l.id === data.targetListId);
    if (!destList) throw new Error("ستون مقصد پیدا نشد");
    const moved: Card = {
      ...card,
      boardId: data.targetBoardId,
      listId: data.targetListId,
      position: mid(destList.cards[destList.cards.length - 1]?.position, undefined),
      enteredListAt: new Date().toISOString(),
      activities: [
        {
          id: nid(),
          at: new Date().toISOString(),
          by: context.user.displayName,
          text:
            sourceBoardId === data.targetBoardId
              ? `کارت را به ستون «${destList.title}» منتقل کرد`
              : `کارت را از تخته «${findBoard(ws, sourceBoardId)?.title ?? "؟"}» به تخته «${destBoard.title}» (ستون «${destList.title}») منتقل کرد`,
        },
        ...(card.activities || []),
      ].slice(0, MAX_CARD_ACTIVITIES),
    };
    destList.cards.push(moved);
    await saveWorkspace(ws);
    await logAudit(context.user, {
      category: "card",
      action: "card.move",
      boardId: destBoard.id,
      boardTitle: destBoard.title,
      cardId: moved.id,
      cardTitle: moved.title,
      summary:
        sourceBoardId === data.targetBoardId
          ? `کارت «${moved.title}» را به ستون «${destList.title}» منتقل کرد`
          : `کارت «${moved.title}» را از تخته «${findBoard(ws, sourceBoardId)?.title ?? "؟"}» به تخته «${destBoard.title}» منتقل کرد`,
    });
    return { ok: true as const, id: moved.id };
  });

export const deleteCard = createServerFn({ method: "POST" }).middleware([requireBoardAction("delete_card"), workspaceWriteLock])
  .validator((data: { id: string }) => checked(S.idOnly, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const hit = locateCard(ws, data.id);
    for (const b of ws.boards) {
      for (const l of b.lists) {
        l.cards = l.cards.filter((c) => c.id !== data.id);
      }
    }
    await saveWorkspace(ws);
    if (hit) {
      await logAudit(context.user, {
        category: "card",
        action: "card.delete",
        boardId: hit.board.id,
        boardTitle: hit.board.title,
        cardId: hit.card.id,
        cardTitle: hit.card.title,
        summary: `کارت «${hit.card.title}» را حذف کرد`,
        details: {
          list: hit.list.title,
          members: hit.card.memberIds.length,
          checklists: hit.card.checklists.length,
          comments: hit.card.comments.length,
        },
      });
    }
    return { ok: true as const };
  });

export const addComment = createServerFn({ method: "POST" }).middleware([requireBoardAction("comment"), workspaceWriteLock])
  .validator((data: { cardId: string; body: string; author?: string }) => checked(S.comment, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const id = nid();
    for (const b of ws.boards) {
      for (const l of b.lists) {
        const c = l.cards.find((x) => x.id === data.cardId);
        if (c) {
          c.comments.push({
            id,
            body: String(data.body).slice(0, 5000),
            createdAt: new Date().toISOString(),
            author: context.user.displayName, // always the real logged-in user
          });
          pushActivity(c, context.user.displayName, `نظر ثبت کرد: «${String(data.body).slice(0, 80)}»`);
          await saveWorkspace(ws);
          await logAudit(context.user, {
            category: "card",
            action: "card.comment",
            boardId: b.id,
            boardTitle: b.title,
            cardId: c.id,
            cardTitle: c.title,
            summary: `روی کارت «${c.title}» نظر ثبت کرد: «${String(data.body).slice(0, 120)}»`,
          });
          const mentions = Array.from(
            new Set(
              (data.body.match(/@([a-z0-9._-]+)/gi) || []).map((m) => m.slice(1).toLowerCase()),
            ),
          );
          return { id, mentions, cardTitle: c.title, boardId: c.boardId };
        }
      }
    }
    throw new Error("کارت پیدا نشد");
  });

export const saveChecklist = createServerFn({ method: "POST" }).middleware([requireBoardAction("manage_checklists"), workspaceWriteLock])
  .validator((data: { cardId: string; id?: string; title: string; items: ChecklistItem[]; position?: number }) =>
    checked(S.checklist, data),
  )
  .handler(async ({ data: d, context }) => {
    const ws = await loadWorkspace();
    for (const b of ws.boards) {
      for (const l of b.lists) {
        const c = l.cards.find((x) => x.id === d.cardId);
        if (!c) continue;
        let text = "";
        if (d.id) {
          const ch = c.checklists.find((x) => x.id === d.id);
          if (ch) {
            const doneBefore = ch.items.filter((i) => i.done).length;
            const doneAfter = d.items.filter((i) => i.done).length;
            text =
              ch.title !== d.title
                ? `نام چک‌لیست را از «${ch.title}» به «${d.title}» تغییر داد`
                : `چک‌لیست «${ch.title}» را ویرایش کرد (${doneAfter.toLocaleString("fa-IR")} از ${d.items.length.toLocaleString("fa-IR")} انجام‌شده)`;
            if (ch.title === d.title && ch.items.length === d.items.length && doneBefore === doneAfter) text = "";
            ch.title = d.title;
            ch.items = d.items;
          }
        } else {
          text = `چک‌لیست «${d.title}» را ایجاد کرد`;
          c.checklists.push({
            id: nid(),
            title: d.title,
            items: d.items,
            position: d.position ?? (c.checklists.length + 1) * 1000,
          });
        }
        if (text) {
          pushActivity(c, context.user.displayName, text);
          await logAudit(context.user, {
            category: "card",
            action: "card.checklist",
            boardId: b.id,
            boardTitle: b.title,
            cardId: c.id,
            cardTitle: c.title,
            summary: text,
          });
        }
        await saveWorkspace(ws);
        return { id: d.id ?? c.checklists[c.checklists.length - 1]!.id };
      }
    }
    throw new Error("کارت پیدا نشد");
  });

export const deleteChecklist = createServerFn({ method: "POST" }).middleware([requireBoardAction("manage_checklists"), workspaceWriteLock])
  .validator((data: { id: string }) => checked(S.idOnly, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const hit = locateChecklist(ws, data.id);
    for (const b of ws.boards) {
      for (const l of b.lists) {
        for (const c of l.cards) {
          c.checklists = c.checklists.filter((ch) => ch.id !== data.id);
        }
      }
    }
    if (hit) {
      const text = `چک‌لیست «${hit.ch.title}» را حذف کرد`;
      pushActivity(hit.card, context.user.displayName, text);
      await saveWorkspace(ws);
      await logAudit(context.user, {
        category: "card",
        action: "card.checklist",
        boardId: hit.board.id,
        boardTitle: hit.board.title,
        cardId: hit.card.id,
        cardTitle: hit.card.title,
        summary: text,
      });
    } else {
      await saveWorkspace(ws);
    }
    return { ok: true as const };
  });

function locateChecklist(ws: Workspace, checklistId: string) {
  for (const board of ws.boards) {
    for (const l of board.lists) {
      for (const card of l.cards) {
        const ch = card.checklists.find((x) => x.id === checklistId);
        if (ch) return { board, card, ch };
      }
    }
  }
  return undefined;
}

function findChecklist(ws: Workspace, checklistId: string) {
  return locateChecklist(ws, checklistId)?.ch;
}

/** Records one checklist-item event on the card and in the audit log. */
async function logChecklistEvent(ws: Workspace, user: LocalUser, checklistId: string, text: string) {
  const hit = locateChecklist(ws, checklistId);
  if (!hit) return;
  pushActivity(hit.card, user.displayName, text);
  await saveWorkspace(ws);
  await logAudit(user, {
    category: "card",
    action: "card.checklist",
    boardId: hit.board.id,
    boardTitle: hit.board.title,
    cardId: hit.card.id,
    cardTitle: hit.card.title,
    summary: text,
  });
}

export const addChecklistItem = createServerFn({ method: "POST" }).middleware([requireBoardAction("manage_checklists"), workspaceWriteLock])
  .validator((data: { checklistId: string; title: string }) => checked(S.checklistItemAdd, data))
  .handler(async ({ data, context }) => {
    const title = data.title.trim();
    if (!title) throw new Error("عنوان آیتم خالی است");
    const ws = await loadWorkspace();
    const ch = findChecklist(ws, data.checklistId);
    if (!ch) throw new Error("چک‌لیست پیدا نشد");
    if (!Array.isArray(ch.items)) ch.items = [];
    const id = nid();
    ch.items.push({ id, title, done: false });
    await saveWorkspace(ws);
    await logChecklistEvent(ws, context.user, data.checklistId, `مورد «${title}» را به چک‌لیست «${ch.title}» افزود`);
    return { id };
  });

export const toggleChecklistItem = createServerFn({ method: "POST" }).middleware([requireBoardAction("manage_checklists"), workspaceWriteLock])
  .validator((data: { checklistId: string; itemId: string }) => checked(S.checklistItemRef, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const ch = findChecklist(ws, data.checklistId);
    if (!ch) throw new Error("چک‌لیست پیدا نشد");
    const item = ch.items.find((x) => x.id === data.itemId);
    if (!item) throw new Error("آیتم پیدا نشد");
    item.done = !item.done;
    await saveWorkspace(ws);
    await logChecklistEvent(
      ws,
      context.user,
      data.checklistId,
      item.done ? `مورد «${item.title}» را انجام‌شده علامت زد` : `علامت انجام مورد «${item.title}» را برداشت`,
    );
    return { ok: true as const, done: item.done };
  });

export const deleteChecklistItem = createServerFn({ method: "POST" }).middleware([requireBoardAction("manage_checklists"), workspaceWriteLock])
  .validator((data: { checklistId: string; itemId: string }) => checked(S.checklistItemRef, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const ch = findChecklist(ws, data.checklistId);
    if (!ch) throw new Error("چک‌لیست پیدا نشد");
    const gone = ch.items.find((x) => x.id === data.itemId);
    ch.items = ch.items.filter((x) => x.id !== data.itemId);
    await saveWorkspace(ws);
    if (gone) await logChecklistEvent(ws, context.user, data.checklistId, `مورد «${gone.title}» را از چک‌لیست «${ch.title}» حذف کرد`);
    return { ok: true as const };
  });


function pushActivity(card: Card, by: string, text: string) {
  if (!Array.isArray(card.activities)) card.activities = [];
  card.activities.unshift({ id: nid(), at: new Date().toISOString(), by: by || "سیستم", text });
  if (card.activities.length > MAX_CARD_ACTIVITIES) card.activities.length = MAX_CARD_ACTIVITIES;
}

export const duplicateCard = createServerFn({ method: "POST" }).middleware([requireBoardAction("create_card"), workspaceWriteLock])
  .validator(
    (data: {
      cardId: string;
      by?: string;
      targetBoardId?: string;
      targetListId?: string;
    }) => checked(z.looseObject({ cardId: sId }), data),
  )
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    let src: Card | null = null;
    let sourceBoard: Board | null = null;
    for (const b of ws.boards) {
      for (const l of b.lists) {
        const found = l.cards.find((c) => c.id === data.cardId);
        if (found) {
          src = found;
          sourceBoard = b;
          break;
        }
      }
      if (src) break;
    }
    if (!src || !sourceBoard) throw new Error("کارت پیدا نشد");

    let destBoard = sourceBoard;
    if (data.targetBoardId) {
      const b = findBoard(ws, data.targetBoardId);
      if (!b) throw new Error("تخته مقصد پیدا نشد");
      destBoard = b;
    }
    let destList = destBoard.lists.find((l) => l.id === (data.targetListId || src.listId));
    if (!destList) destList = destBoard.lists[0];
    if (!destList) throw new Error("ستون مقصد پیدا نشد");

    const id = nid();
    const copy: Card = {
      ...structuredClone(src),
      id,
      boardId: destBoard.id,
      listId: destList.id,
      title: src.title + " (کپی)",
      position: mid(destList.cards[destList.cards.length - 1]?.position, undefined),
      createdAt: isoToday(),
      enteredListAt: new Date().toISOString(),
      comments: [],
      dependsOnIds: [],
      activities: [
        {
          id: nid(),
          at: new Date().toISOString(),
          by: context.user.displayName,
          text: "کپی از کارت «" + src.title + "»",
        },
      ],
    };
    copy.checklists = (src.checklists || []).map((ch) => ({
      ...ch,
      id: nid(),
      items: (ch.items || []).map((it) => ({ ...it, id: nid() })),
    }));
    destList.cards.push(copy);
    pushActivity(src, context.user.displayName, `از این کارت یک کپی ساخت (در تخته «${destBoard.title}»)`);
    await saveWorkspace(ws);
    await logAudit(context.user, {
      category: "card",
      action: "card.duplicate",
      boardId: destBoard.id,
      boardTitle: destBoard.title,
      cardId: id,
      cardTitle: copy.title,
      summary: `از کارت «${src.title}» کپی ساخت`,
    });
    return { id, boardId: destBoard.id, listId: destList.id };
  });

export const setCardArchived = createServerFn({ method: "POST" }).middleware([requireBoardAction("edit_card"), workspaceWriteLock])
  .validator((data: { cardId: string; archived: boolean; by?: string }) => checked(S.archived, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    for (const b of ws.boards) {
      for (const l of b.lists) {
        const card = l.cards.find((c) => c.id === data.cardId);
        if (!card) continue;
        card.archived = data.archived;
        const text = data.archived ? "کارت را بایگانی کرد" : "کارت را از بایگانی خارج کرد";
        pushActivity(card, context.user.displayName, text);
        await saveWorkspace(ws);
        await logAudit(context.user, {
          category: "card",
          action: data.archived ? "card.archive" : "card.unarchive",
          boardId: b.id,
          boardTitle: b.title,
          cardId: card.id,
          cardTitle: card.title,
          summary: `${text} «${card.title}»`,
        });
        return { ok: true as const };
      }
    }
    throw new Error("کارت پیدا نشد");
  });

export const listPeople = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(async (): Promise<Person[]> => {
  const ws = await loadWorkspace();
  return ws.people;
});

export const upsertPerson = createServerFn({ method: "POST" }).middleware([adminMiddleware, workspaceWriteLock])
  .validator((data: { id?: string; code: string; firstName: string; lastName: string; role: string; username?: string }) =>
    checked(S.person, data),
  )
  .handler(async ({ data: d, context }) => {
    const ws = await loadWorkspace();
    const username = d.username?.trim() || undefined;
    if (d.id) {
      const p = ws.people.find((x) => x.id === d.id);
      if (p) {
        p.code = d.code;
        p.firstName = d.firstName;
        p.lastName = d.lastName;
        p.role = d.role;
        p.username = username;
      }
      await saveWorkspace(ws);
      await logAudit(context.user, {
        category: "people",
        action: "person.update",
        summary: `مشخصات «${d.firstName} ${d.lastName}» را ویرایش کرد`,
      });
      return { id: d.id };
    }
    const id = nid();
    ws.people.push({
      id,
      code: d.code,
      firstName: d.firstName,
      lastName: d.lastName,
      role: d.role,
      username,
    });
    await saveWorkspace(ws);
    await logAudit(context.user, {
      category: "people",
      action: "person.create",
      summary: `«${d.firstName} ${d.lastName}» را به فهرست افراد افزود`,
    });
    return { id };
  });

export const deletePerson = createServerFn({ method: "POST" }).middleware([adminMiddleware, workspaceWriteLock])
  .validator((data: { id: string }) => checked(S.idOnly, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const gone = ws.people.find((p) => p.id === data.id);
    ws.people = ws.people.filter((p) => p.id !== data.id);
    for (const b of ws.boards) {
      for (const l of b.lists) {
        for (const c of l.cards) {
          c.memberIds = c.memberIds.filter((id) => id !== data.id);
          if (c.followerId === data.id) c.followerId = null;
        }
      }
    }
    await saveWorkspace(ws);
    if (gone) {
      await logAudit(context.user, {
        category: "people",
        action: "person.delete",
        summary: `«${gone.firstName} ${gone.lastName}» را از فهرست افراد حذف کرد`,
      });
    }
    return { ok: true as const };
  });

export const createLabel = createServerFn({ method: "POST" }).middleware([requireBoardAction("manage_labels"), workspaceWriteLock])
  .validator((data: { boardId: string; name: string; color: string }) => checked(S.label, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const b = findBoard(ws, data.boardId);
    if (!b) throw new Error("تخته پیدا نشد");
    const id = nid();
    b.labels.push({ id, name: data.name, color: data.color });
    await saveWorkspace(ws);
    await logAudit(context.user, {
      category: "label",
      action: "label.create",
      boardId: b.id,
      boardTitle: b.title,
      summary: `برچسب «${data.name}» را ساخت`,
    });
    return { id };
  });

export const deleteLabel = createServerFn({ method: "POST" }).middleware([requireBoardAction("manage_labels"), workspaceWriteLock])
  .validator((data: { id: string }) => checked(S.idOnly, data))
  .handler(async ({ data, context }) => {
    const ws = await loadWorkspace();
    const audits: AuditEntry[] = [];
    for (const b of ws.boards) {
      const gone = b.labels.find((l) => l.id === data.id);
      if (gone) {
        audits.push({
          category: "label",
          action: "label.delete",
          boardId: b.id,
          boardTitle: b.title,
          summary: `برچسب «${gone.name}» را حذف کرد`,
        });
      }
      b.labels = b.labels.filter((l) => l.id !== data.id);
      for (const l of b.lists) {
        for (const c of l.cards) {
          c.labelIds = c.labelIds.filter((id) => id !== data.id);
        }
      }
    }
    await saveWorkspace(ws);
    await logAudit(context.user, audits);
    return { ok: true as const };
  });

function newEmptyBoard(ws: Workspace, title: string, description: string): Board {
  const boardId = nid();
  const labels: Label[] = [
    { id: nid(), name: "برنامه‌ریزی تولید", color: "#4C8DBE" },
    { id: nid(), name: "انبار / موجودی", color: "#4E9490" },
    { id: nid(), name: "تدارکات", color: "#D9724F" },
    { id: nid(), name: "گزارش / هماهنگی", color: "#C9A24B" },
  ];
  const lists: List[] = [
    { id: nid(), boardId, title: "در صف", position: 1000, cards: [] },
    { id: nid(), boardId, title: "در حال اجرا", position: 2000, cards: [] },
    { id: nid(), boardId, title: "تمام‌شده", position: 3000, cards: [] },
  ];
  return { id: boardId, title, description, lists, people: ws.people, labels };
}

/** First start with an empty database: one empty board, nobody assigned yet. */
function createSeedWorkspace(): Workspace {
  const boardId = nid();
  const board: Board = {
    id: boardId,
    title: "تخته اصلی",
    description: "",
    lists: [
      { id: nid(), boardId, title: "در صف", position: 1000, cards: [] },
      { id: nid(), boardId, title: "در حال اجرا", position: 2000, cards: [] },
      { id: nid(), boardId, title: "تمام‌شده", position: 3000, cards: [] },
    ],
    people: [],
    labels: [
      { id: nid(), name: "برنامه‌ریزی تولید", color: "#4C8DBE" },
      { id: nid(), name: "انبار / موجودی", color: "#4E9490" },
      { id: nid(), name: "تدارکات", color: "#D9724F" },
      { id: nid(), name: "گزارش / هماهنگی", color: "#C9A24B" },
    ],
  };
  return { people: [], boards: [board], archivedBoards: [] };
}
