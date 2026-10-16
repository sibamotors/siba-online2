import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Zap } from "lucide-react";
import { toast } from "sonner";
import { STORY_POINTS, getScrum, setCardScrum } from "@/lib/scrum";
import { cn } from "@/lib/utils";

/** Scrum info of ONE card, read from the same cached query the scrum page uses (one request per board, not per card). */
export function useScrumCard(boardId: string, cardId: string) {
  return useQuery({
    queryKey: ["scrum", boardId],
    queryFn: () => getScrum({ data: { boardId } }),
    staleTime: 20_000,
    select: (d) => {
      const c = d.cards.find((x) => x.cardId === cardId);
      const sprint = c?.sprintId
        ? d.sprints.find((s) => s.id === c.sprintId)
        : undefined;
      return {
        points: c?.points ?? null,
        sprint,
        sprints: d.sprints,
        canManage: d.canManage,
      };
    },
  });
}

/** Small "⚡ 5" chip for the card tile (renders nothing when the card has no estimate). */
export function ScrumChip({
  boardId,
  cardId,
}: {
  boardId: string;
  cardId: string;
}) {
  const q = useScrumCard(boardId, cardId);
  const s = q.data;
  if (!s || (s.points === null && !s.sprint)) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        s.sprint?.status === "active"
          ? "bg-accent-soft text-fg"
          : "bg-surface-2 text-muted",
      )}
      title={s.sprint ? `اسپرینت: ${s.sprint.name}` : "امتیاز اسکرام"}
    >
      <Zap className="size-3" />
      {s.points !== null ? s.points.toLocaleString("fa-IR") : "؟"}
    </span>
  );
}

/** Estimate + sprint picker shown inside the card dialog. */
export function ScrumCardPanel({
  boardId,
  cardId,
}: {
  boardId: string;
  cardId: string;
}) {
  const qc = useQueryClient();
  const q = useScrumCard(boardId, cardId);
  const mut = useMutation({
    mutationFn: (v: { points?: number | null; sprintId?: string | null }) =>
      setCardScrum({ data: { boardId, cardId, ...v } }),
    onSuccess: (r) => {
      if (!r.ok) toast.error(r.error);
      void qc.invalidateQueries({ queryKey: ["scrum", boardId] });
      void qc.invalidateQueries({ queryKey: ["board", boardId] });
    },
    onError: () => toast.error("ذخیره نشد."),
  });
  const s = q.data;
  if (!s) return null;
  const open = s.sprints.filter((x) => x.status !== "completed");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="امتیاز (Story Point)"
        className="h-9 w-24 rounded-md border border-border bg-surface px-2 text-[13px]"
        value={s.points ?? ""}
        onChange={(e) =>
          mut.mutate({
            points: e.target.value === "" ? null : Number(e.target.value),
          })
        }
      >
        <option value="">بدون امتیاز</option>
        {STORY_POINTS.map((p) => (
          <option key={p} value={p}>
            {p.toLocaleString("fa-IR")}
          </option>
        ))}
      </select>
      <select
        aria-label="اسپرینت"
        disabled={!s.canManage}
        className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-[13px] disabled:opacity-60"
        value={s.sprint?.id ?? ""}
        onChange={(e) => mut.mutate({ sprintId: e.target.value || null })}
        title={s.canManage ? undefined : "فقط ادمین، اسکرام مستر یا مالک محصول"}
      >
        <option value="">بک‌لاگ (بدون اسپرینت)</option>
        {s.sprint && s.sprint.status === "completed" && (
          <option value={s.sprint.id}>{s.sprint.name} (بسته‌شده)</option>
        )}
        {open.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
            {x.status === "active" ? " · فعال" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Slim strip above the kanban board while a sprint is running: goal, days left, progress, link to the scrum page. */
export function SprintBanner({ boardId }: { boardId: string }) {
  const q = useQuery({
    queryKey: ["scrum", boardId],
    queryFn: () => getScrum({ data: { boardId } }),
    staleTime: 20_000,
    select: (d) => {
      const sprint = d.sprints.find((s) => s.status === "active");
      if (!sprint) return null;
      const done = new Set(d.doneCardIds);
      const inSprint = d.cards.filter((c) => c.sprintId === sprint.id);
      const total = inSprint.reduce((n, c) => n + (c.points ?? 0), 0);
      const finished = inSprint
        .filter((c) => done.has(c.cardId))
        .reduce((n, c) => n + (c.points ?? 0), 0);
      return { sprint, total, finished, count: inSprint.length };
    },
  });
  const s = q.data;
  if (!s) return null;
  const left = s.sprint.endDate
    ? Math.floor(
        (Date.parse(`${s.sprint.endDate}T00:00:00Z`) -
          Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) /
          86_400_000,
      )
    : null;
  const pct = s.total ? Math.round((s.finished / s.total) * 100) : 0;
  return (
    <Link
      to="/b/$boardId/scrum"
      params={{ boardId }}
      className="mx-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-accent-soft px-3 py-2 text-[12px] hover:border-accent"
    >
      <span className="inline-flex items-center gap-1 font-semibold">
        <Zap className="size-3.5" />
        {s.sprint.name}
      </span>
      {s.sprint.goal && (
        <span className="min-w-0 max-w-[40ch] truncate text-muted">
          🎯 {s.sprint.goal}
        </span>
      )}
      <span className="ms-auto flex items-center gap-2 text-muted">
        {left !== null && (
          <span
            className={cn(
              left < 0 && "text-danger",
              left >= 0 && left <= 2 && "text-warning",
            )}
          >
            {left < 0
              ? `${(-left).toLocaleString("fa-IR")} روز دیرکرد`
              : left === 0
                ? "آخرین روز"
                : `${left.toLocaleString("fa-IR")} روز مانده`}
          </span>
        )}
        <span className="tabular-nums">
          {s.finished.toLocaleString("fa-IR")}/{s.total.toLocaleString("fa-IR")}{" "}
          امتیاز
        </span>
        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>
    </Link>
  );
}
