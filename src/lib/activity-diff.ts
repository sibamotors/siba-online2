// Turns "old card" + "patch from the editor" into readable Persian log lines.
// Pure functions (no database, no React) so they can be unit-tested and used on the server.
import { PRIORITY_LABEL } from "./constants";
import { isoToJalaaliStr } from "./jalali";
import type { Card, Label, List, Person, Priority } from "./types";

export type CardChange = {
  /** Machine key, e.g. "card.title" — used for filtering in the log page. */
  action: string;
  /** Human sentence, without the actor's name. */
  text: string;
};

export type DiffCtx = {
  people: Person[];
  labels: Label[];
  lists: List[];
  /** Optional: resolve another card's title (for dependency changes). */
  cardTitleOf?: (id: string) => string | undefined;
};

const norm = (v: unknown) => JSON.stringify(v ?? null);
const quote = (s: string) => `«${s}»`;
const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fa = (n: number) => n.toLocaleString("fa-IR");

function personName(ctx: DiffCtx, id: string): string {
  const p = ctx.people.find((x) => x.id === id);
  return p ? `${p.firstName} ${p.lastName}`.trim() || p.code : "فرد حذف‌شده";
}

function diffIds(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((x) => !b.has(x)), removed: before.filter((x) => !a.has(x)) };
}

function dateText(v: string | null | undefined): string {
  return v ? isoToJalaaliStr(v) : "—";
}

/** Everything that really changed between `card` and `patch` (fields missing from the patch are ignored). */
export function describeCardChanges(card: Card, patch: Partial<Card>, ctx: DiffCtx): CardChange[] {
  const out: CardChange[] = [];
  const changed = <K extends keyof Card>(k: K) => patch[k] !== undefined && norm(patch[k]) !== norm(card[k]);

  if (changed("title") && typeof patch.title === "string") {
    out.push({
      action: "card.title",
      text: `عنوان را از ${quote(short(card.title))} به ${quote(short(patch.title))} تغییر داد`,
    });
  }
  if (changed("notes")) {
    const before = (card.notes ?? "").trim();
    const after = String(patch.notes ?? "").trim();
    out.push({
      action: "card.notes",
      text: !before ? "توضیحات کارت را نوشت" : !after ? "توضیحات کارت را پاک کرد" : "توضیحات کارت را ویرایش کرد",
    });
  }
  if (changed("priority")) {
    const from = PRIORITY_LABEL[card.priority as Priority] ?? String(card.priority);
    const to = PRIORITY_LABEL[patch.priority as Priority] ?? String(patch.priority);
    out.push({ action: "card.priority", text: `اولویت را از ${from} به ${to} تغییر داد` });
  }
  if (changed("startDate")) {
    out.push({
      action: "card.dates",
      text: patch.startDate
        ? `تاریخ شروع را ${card.startDate ? `از ${dateText(card.startDate)} ` : ""}به ${dateText(patch.startDate)} تغییر داد`
        : "تاریخ شروع را حذف کرد",
    });
  }
  if (changed("dueDate")) {
    out.push({
      action: "card.dates",
      text: patch.dueDate
        ? `مهلت انجام را ${card.dueDate ? `از ${dateText(card.dueDate)} ` : ""}به ${dateText(patch.dueDate)} تغییر داد`
        : "مهلت انجام را حذف کرد",
    });
  }
  if (changed("progress")) {
    out.push({
      action: "card.progress",
      text: `پیشرفت را از ${fa(card.progress ?? 0)}٪ به ${fa(Number(patch.progress ?? 0))}٪ رساند`,
    });
  }
  if (changed("memberIds") && Array.isArray(patch.memberIds)) {
    const { added, removed } = diffIds(card.memberIds ?? [], patch.memberIds);
    if (added.length) {
      out.push({ action: "card.members", text: `${added.map((id) => personName(ctx, id)).join("، ")} را به کارت اضافه کرد` });
    }
    if (removed.length) {
      out.push({ action: "card.members", text: `${removed.map((id) => personName(ctx, id)).join("، ")} را از کارت حذف کرد` });
    }
  }
  if (changed("followerId")) {
    out.push({
      action: "card.follower",
      text: patch.followerId
        ? `پیگیرکننده را ${card.followerId ? `از ${personName(ctx, card.followerId)} ` : ""}به ${personName(ctx, patch.followerId)} تغییر داد`
        : "پیگیرکننده را برداشت",
    });
  }
  if (changed("labelIds") && Array.isArray(patch.labelIds)) {
    const nameOf = (id: string) => ctx.labels.find((l) => l.id === id)?.name ?? "برچسب حذف‌شده";
    const { added, removed } = diffIds(card.labelIds ?? [], patch.labelIds);
    if (added.length) out.push({ action: "card.labels", text: `برچسب ${added.map((i) => quote(nameOf(i))).join("، ")} را افزود` });
    if (removed.length) out.push({ action: "card.labels", text: `برچسب ${removed.map((i) => quote(nameOf(i))).join("، ")} را برداشت` });
  }
  if (changed("coverColor")) {
    out.push({ action: "card.cover", text: patch.coverColor ? "رنگ کاور کارت را تغییر داد" : "رنگ کاور کارت را برداشت" });
  }
  if (changed("dependsOnIds") && Array.isArray(patch.dependsOnIds)) {
    const nameOf = (id: string) => ctx.cardTitleOf?.(id) ?? "کارت دیگر";
    const { added, removed } = diffIds(card.dependsOnIds ?? [], patch.dependsOnIds);
    if (added.length) out.push({ action: "card.deps", text: `وابستگی به ${added.map((i) => quote(short(nameOf(i), 40))).join("، ")} را افزود` });
    if (removed.length) out.push({ action: "card.deps", text: `وابستگی به ${removed.map((i) => quote(short(nameOf(i), 40))).join("، ")} را برداشت` });
  }
  if (patch.listId && patch.listId !== card.listId) {
    const nameOf = (id: string) => ctx.lists.find((l) => l.id === id)?.title ?? "ستون";
    out.push({
      action: "card.move",
      text: `کارت را از ستون ${quote(nameOf(card.listId))} به ستون ${quote(nameOf(patch.listId))} منتقل کرد`,
    });
  }
  return out;
}
