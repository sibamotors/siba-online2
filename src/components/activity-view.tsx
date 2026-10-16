import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download, History, Search, Tag, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AUDIT_CATEGORY_LABEL,
  PUBLIC_AUDIT_CATEGORIES,
  auditStats,
  listAuditLog,
  type AuditCategory,
  type AuditEntry,
  type AuditFilter,
} from "@/lib/audit";
import { dayLabelFa, formatDateTimeFa, formatTimeFa, localDayIso } from "@/lib/jalali";
import { useLocalSession } from "@/lib/local-session";
import { downloadText, cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { UserAvatar, useDirectory } from "./user-avatar";

const CATEGORY_STYLE: Record<AuditCategory, string> = {
  card: "bg-sky-500/15 text-sky-500",
  list: "bg-violet-500/15 text-violet-500",
  board: "bg-indigo-500/15 text-indigo-500",
  people: "bg-teal-500/15 text-teal-500",
  label: "bg-amber-500/15 text-amber-500",
  account: "bg-fuchsia-500/15 text-fuchsia-500",
  report: "bg-emerald-500/15 text-emerald-500",
  security: "bg-rose-500/15 text-rose-500",
  system: "bg-zinc-500/20 text-muted",
};

const RANGES = [
  { id: "today", label: "امروز", days: 0 },
  { id: "7", label: "۷ روز", days: 7 },
  { id: "30", label: "۳۰ روز", days: 30 },
  { id: "all", label: "همه", days: -1 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

function rangeFrom(id: RangeId): string | undefined {
  const r = RANGES.find((x) => x.id === id);
  if (!r || r.days < 0) return undefined;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - r.days);
  return d.toISOString();
}

function Spinner() {
  return <span className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />;
}

function csvCell(v: string | null | undefined): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Props = { initialCardId?: string; initialBoardId?: string };

export function ActivityView({ initialCardId, initialBoardId }: Props) {
  const { isAdmin } = useLocalSession();
  const dirQ = useDirectory();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>("");
  const [actor, setActor] = useState<string>("");
  const [range, setRange] = useState<RangeId>("7");
  const [cardId, setCardId] = useState<string | undefined>(initialCardId);
  const [boardId, setBoardId] = useState<string | undefined>(initialBoardId);
  const [exporting, setExporting] = useState(false);

  const filter = useMemo<AuditFilter>(
    () => ({
      q: q.trim() || undefined,
      category: category || undefined,
      actor: actor || undefined,
      cardId,
      boardId,
      // a pinned card shows its whole life, whatever the date chips say
      from: cardId ? undefined : rangeFrom(range),
    }),
    [q, category, actor, range, cardId, boardId],
  );

  const logQ = useInfiniteQuery({
    queryKey: ["audit", filter],
    initialPageParam: undefined as { before: string; beforeId: string } | undefined,
    queryFn: ({ pageParam }) =>
      listAuditLog({ data: { ...filter, before: pageParam?.before, beforeId: pageParam?.beforeId, limit: 100 } }),
    getNextPageParam: (last) => {
      if (!last.hasMore) return undefined;
      const tail = last.entries[last.entries.length - 1];
      return tail ? { before: tail.createdAt, beforeId: tail.id } : undefined;
    },
    refetchInterval: 15_000,
  });
  const statsQ = useQuery({
    queryKey: ["audit-stats"],
    queryFn: () => auditStats({ data: { days: 14 } }),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  const entries = useMemo(() => (logQ.data?.pages ?? []).flatMap((p) => p.entries), [logQ.data]);
  const groups = useMemo(() => {
    const out: { day: string; label: string; items: AuditEntry[] }[] = [];
    for (const e of entries) {
      const day = localDayIso(e.createdAt) ?? "";
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, label: dayLabelFa(e.createdAt), items: [e] });
    }
    return out;
  }, [entries]);

  const categories = (isAdmin ? Object.keys(AUDIT_CATEGORY_LABEL) : PUBLIC_AUDIT_CATEGORIES) as AuditCategory[];
  const pinnedTitle = cardId ? (entries.find((e) => e.cardId === cardId)?.cardTitle ?? "کارت") : null;

  async function exportCsv() {
    setExporting(true);
    try {
      const rows: AuditEntry[] = [];
      let cursor: { before: string; beforeId: string } | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await listAuditLog({
          data: { ...filter, before: cursor?.before, beforeId: cursor?.beforeId, limit: 500 },
        });
        rows.push(...page.entries);
        const tail = page.entries[page.entries.length - 1];
        if (!page.hasMore || !tail) break;
        cursor = { before: tail.createdAt, beforeId: tail.id };
      }
      const head = ["زمان", "کاربر", "نام", "دسته", "رویداد", "تخته", "کارت", "شرح", ...(isAdmin ? ["IP"] : [])];
      const lines = [head.join(",")];
      for (const r of rows) {
        lines.push(
          [
            formatDateTimeFa(r.createdAt),
            r.actor,
            r.actorName,
            AUDIT_CATEGORY_LABEL[r.category] ?? r.category,
            r.action,
            r.boardTitle,
            r.cardTitle,
            r.summary,
            ...(isAdmin ? [r.ip] : []),
          ]
            .map(csvCell)
            .join(","),
        );
      }
      // BOM so Excel opens Persian text correctly
      downloadText(`sibamotor-log-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${lines.join("\r\n")}`, "text/csv;charset=utf-8");
      toast.success(`${rows.length.toLocaleString("fa-IR")} رویداد خروجی گرفته شد`);
    } catch {
      toast.error("خروجی گرفتن ناموفق بود.");
    } finally {
      setExporting(false);
    }
  }

  const hasFilters = Boolean(q || category || actor || cardId || boardId || range !== "7");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <History className="size-5 text-accent" />
            لاگ فعالیت‌ها
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            {isAdmin
              ? "هر تغییری در کارت‌ها، تخته‌ها، حساب‌ها، گزارش‌ها و ورود به سیستم اینجا ثبت می‌شود."
              : "تغییراتی که روی کارت‌ها و تخته‌ها انجام شده است."}
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={exporting || entries.length === 0} onClick={() => void exportCsv()}>
          {exporting ? <Spinner /> : <Download />}
          خروجی اکسل (CSV)
        </Button>
      </div>

      {isAdmin && statsQ.data && statsQ.data.total > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border k-glass p-4">
            <p className="text-[12px] text-muted">رویدادهای {statsQ.data.days.toLocaleString("fa-IR")} روز اخیر</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{statsQ.data.total.toLocaleString("fa-IR")}</p>
            <div className="mt-3 flex h-10 items-end gap-0.5" aria-hidden>
              {(() => {
                const max = Math.max(1, ...statsQ.data.byDay.map((d) => d.n));
                return statsQ.data.byDay.map((d) => (
                  <span
                    key={d.day}
                    title={`${d.day}: ${d.n}`}
                    className="flex-1 rounded-sm bg-accent/70"
                    style={{ height: `${Math.max(8, (d.n / max) * 100)}%` }}
                  />
                ));
              })()}
            </div>
          </div>
          <div className="rounded-2xl border border-border k-glass p-4">
            <p className="text-[12px] text-muted">بر اساس دسته</p>
            <ul className="mt-2 space-y-1">
              {statsQ.data.byCategory.slice(0, 5).map((c) => (
                <li key={c.category} className="flex items-center justify-between text-[12px]">
                  <span className={cn("rounded-full px-2 py-0.5", CATEGORY_STYLE[c.category as AuditCategory] ?? "")}>
                    {AUDIT_CATEGORY_LABEL[c.category as AuditCategory] ?? c.category}
                  </span>
                  <span className="tabular-nums text-muted">{c.n.toLocaleString("fa-IR")}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-border k-glass p-4">
            <p className="text-[12px] text-muted">فعال‌ترین کاربران</p>
            <ul className="mt-2 space-y-1.5">
              {statsQ.data.byActor.slice(0, 5).map((a) => (
                <li key={a.actor} className="flex items-center gap-2 text-[12px]">
                  <UserAvatar username={a.actor} name={a.actorName} size="xs" />
                  <span className="min-w-0 flex-1 truncate">{a.actorName}</span>
                  <span className="tabular-nums text-muted">{a.n.toLocaleString("fa-IR")}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 min-w-[12rem] flex-1 items-center gap-2 rounded-full border border-border bg-surface-2 px-3 sm:max-w-sm">
          <Search className="size-4 shrink-0 text-subtle" />
          <input
            className="w-full bg-transparent text-[13px] outline-none"
            placeholder="جستجو در شرح، کارت، تخته یا کاربر…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          className="h-9 rounded-full border border-border bg-surface-2 px-3 text-[12px]"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          aria-label="فیلتر کاربر"
        >
          <option value="">همهٔ کاربران</option>
          {(dirQ.data ?? []).map((u) => (
            <option key={u.username} value={u.username}>
              {u.displayName}
            </option>
          ))}
        </select>
        {!cardId && (
          <div className="flex gap-1 rounded-full bg-surface-2 p-1">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRange(r.id)}
                className={cn(
                  "rounded-full px-3 py-1 text-[12px] font-medium",
                  range === r.id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
        {hasFilters && (
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-[12px] text-muted hover:text-fg"
            onClick={() => {
              setQ("");
              setCategory("");
              setActor("");
              setRange("7");
              setCardId(undefined);
              setBoardId(undefined);
            }}
          >
            <X className="size-3.5" />
            پاک کردن فیلترها
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Tag className="size-3.5 text-subtle" />
        <button
          type="button"
          onClick={() => setCategory("")}
          className={cn(
            "rounded-full border px-3 py-1 text-[12px]",
            !category ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:text-fg",
          )}
        >
          همه
        </button>
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(category === c ? "" : c)}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px]",
              category === c ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:text-fg",
            )}
          >
            {AUDIT_CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      {(cardId || boardId) && (
        <div className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate">
            {cardId ? `تاریخچهٔ کامل کارت «${pinnedTitle}»` : "فقط رویدادهای یک تخته"}
          </span>
          <button
            type="button"
            className="shrink-0 text-muted hover:text-fg"
            aria-label="برداشتن فیلتر"
            onClick={() => {
              setCardId(undefined);
              setBoardId(undefined);
            }}
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="rounded-2xl border border-border k-glass">
        {logQ.isLoading ? (
          <div className="space-y-2 p-4" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-2" />
            ))}
          </div>
        ) : logQ.isError ? (
          <p className="px-4 py-10 text-center text-sm text-danger">دریافت لاگ ناموفق بود. دوباره تلاش کنید.</p>
        ) : entries.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted">رویدادی با این فیلتر پیدا نشد.</p>
        ) : (
          <div>
            {groups.map((g) => (
              <section key={g.day}>
                <h2 className="sticky top-14 z-10 border-b border-border bg-[var(--k-surface)] px-4 py-1.5 text-[12px] font-semibold text-muted">
                  {g.label}
                  <span className="ms-2 font-normal text-subtle">({g.items.length.toLocaleString("fa-IR")})</span>
                </h2>
                <ul>
                  {g.items.map((e) => (
                    <li key={e.id} className="flex items-start gap-3 border-b border-border/60 px-4 py-2.5 last:border-0">
                      <UserAvatar username={e.actor} name={e.actorName} size="sm" className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] leading-6">
                          <span className="font-semibold">{e.actorName}</span> <span>{e.summary}</span>
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-subtle">
                          <span className={cn("rounded-full px-2 py-0.5", CATEGORY_STYLE[e.category] ?? "")}>
                            {AUDIT_CATEGORY_LABEL[e.category] ?? e.category}
                          </span>
                          {e.boardTitle && e.boardId && (
                            <a href={`/b/${e.boardId}`} className="max-w-[12rem] truncate hover:text-fg hover:underline">
                              {e.boardTitle}
                            </a>
                          )}
                          {e.cardTitle && e.cardId && (
                            <button
                              type="button"
                              className="max-w-[14rem] truncate hover:text-fg hover:underline"
                              title="فقط تاریخچهٔ این کارت"
                              onClick={() => setCardId(e.cardId ?? undefined)}
                            >
                              ◂ {e.cardTitle}
                            </button>
                          )}
                          {isAdmin && e.ip && (
                            <span dir="ltr" className="tabular-nums">
                              {e.ip}
                            </span>
                          )}
                        </div>
                      </div>
                      <time className="shrink-0 pt-1 text-[11px] tabular-nums text-subtle" dateTime={e.createdAt}>
                        {formatTimeFa(e.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {logQ.hasNextPage && (
              <div className="p-3 text-center">
                <Button variant="secondary" size="sm" disabled={logQ.isFetchingNextPage} onClick={() => void logQ.fetchNextPage()}>
                  {logQ.isFetchingNextPage ? <Spinner /> : null}
                  نمایش رویدادهای قدیمی‌تر
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
