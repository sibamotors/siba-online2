import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { Board, Card } from "@/lib/types";
import {
  JMONTHS,
  asIsoDate,
  daysInJalaaliMonth,
  isOverdue,
  jalaaliToIso,
  todayJalaali,
  weekdayOfJalaali,
} from "@/lib/jalali";
import { getScrum } from "@/lib/scrum";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

const WEEKDAYS = [
  "شنبه",
  "یکشنبه",
  "دوشنبه",
  "سه‌شنبه",
  "چهارشنبه",
  "پنجشنبه",
  "جمعه",
];
const PRIORITY_BAR: Record<Card["priority"], string> = {
  high: "border-danger",
  med: "border-warning",
  low: "border-border-strong",
};

type Cell = { day: number; iso: string } | null;

export function CalendarView({
  board,
  onOpenCard,
}: {
  board: Board;
  onOpenCard?: (id: string) => void;
}) {
  const [ty, tm, td] = todayJalaali();
  const [ym, setYm] = useState<[number, number]>([ty, tm]);
  const [jy, jm] = ym;
  const doneId = board.lists[board.lists.length - 1]?.id;
  const scrumQ = useQuery({
    queryKey: ["scrum", board.id],
    queryFn: () => getScrum({ data: { boardId: board.id } }),
    staleTime: 20_000,
  });
  // sprint start / end days get a small marker in the grid
  const sprintMarks = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const sp of scrumQ.data?.sprints ?? []) {
      if (sp.status === "completed" && !sp.endDate) continue;
      if (sp.startDate)
        m.set(sp.startDate, [
          ...(m.get(sp.startDate) ?? []),
          `شروع ${sp.name}`,
        ]);
      if (sp.endDate)
        m.set(sp.endDate, [...(m.get(sp.endDate) ?? []), `پایان ${sp.name}`]);
    }
    return m;
  }, [scrumQ.data]);

  const byDay = useMemo(() => {
    const map = new Map<string, (Card & { done: boolean })[]>();
    for (const l of board.lists) {
      for (const c of l.cards) {
        if (c.archived) continue;
        const day = asIsoDate(c.dueDate);
        if (!day) continue;
        const list = map.get(day) ?? [];
        list.push({ ...c, done: l.id === doneId });
        map.set(day, list);
      }
    }
    return map;
  }, [board, doneId]);

  const undated = useMemo(
    () =>
      board.lists
        .flatMap((l) => l.cards)
        .filter((c) => !c.archived && !asIsoDate(c.dueDate)).length,
    [board],
  );

  const cells = useMemo<Cell[]>(() => {
    const lead = weekdayOfJalaali(jy, jm, 1); // 0 = Saturday
    const count = daysInJalaaliMonth(jy, jm);
    const out: Cell[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= count; d++)
      out.push({ day: d, iso: jalaaliToIso(jy, jm, d) });
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [jy, jm]);

  const monthTotal = cells.reduce(
    (n, c) => n + (c ? (byDay.get(c.iso)?.length ?? 0) : 0),
    0,
  );

  function shift(delta: number) {
    setYm(([y, m]) => {
      let nm = m + delta;
      let ny = y;
      while (nm > 12) {
        nm -= 12;
        ny += 1;
      }
      while (nm < 1) {
        nm += 12;
        ny -= 1;
      }
      return [ny, nm];
    });
  }

  const todayIso = jalaaliToIso(ty, tm, td);

  return (
    <div className="k-scroll mx-auto flex w-full max-w-6xl flex-col gap-3 overflow-y-auto px-4 py-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            تقویم
            <select
              aria-label="ماه"
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm"
              value={jm}
              onChange={(e) => setYm([jy, Number(e.target.value)])}
            >
              {JMONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
            <select
              aria-label="سال"
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm tabular-nums"
              value={jy}
              onChange={(e) => setYm([Number(e.target.value), jm])}
            >
              {Array.from(
                new Set([
                  ...Array.from({ length: 16 }, (_, i) => ty - 5 + i),
                  jy,
                ]),
              )
                .sort((a, b) => a - b)
                .map((y) => (
                  <option key={y} value={y}>
                    {y.toLocaleString("fa-IR", { useGrouping: false })}
                  </option>
                ))}
            </select>
          </h1>
          <p className="text-[12px] text-muted">
            {monthTotal.toLocaleString("fa-IR")} کار با مهلت در این ماه
            {undated > 0
              ? ` · ${undated.toLocaleString("fa-IR")} کار بدون مهلت`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="ماه قبل"
            onClick={() => shift(-1)}
          >
            <ChevronRight />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setYm([ty, tm])}>
            امروز
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="ماه بعد"
            onClick={() => shift(1)}
          >
            <ChevronLeft />
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid grid-cols-7 gap-px rounded-t-xl bg-border">
            {WEEKDAYS.map((w, i) => (
              <div
                key={w}
                className={cn(
                  "bg-surface-2 px-2 py-1.5 text-center text-[11px] font-medium",
                  i === 6 ? "text-danger" : "text-muted",
                )}
              >
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px rounded-b-xl bg-border">
            {cells.map((c, i) => {
              if (!c)
                return <div key={i} className="min-h-24 bg-surface-2/50" />;
              const items = byDay.get(c.iso) ?? [];
              const isToday = c.iso === todayIso;
              return (
                <div
                  key={i}
                  className={cn(
                    "min-h-24 bg-surface p-1",
                    isToday && "bg-accent-soft",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "grid size-6 place-items-center rounded-full text-[11px] tabular-nums",
                        isToday
                          ? "bg-accent text-accent-fg font-semibold"
                          : i % 7 === 6
                            ? "text-danger"
                            : "text-muted",
                      )}
                    >
                      {c.day.toLocaleString("fa-IR")}
                    </span>
                    {items.length > 3 && (
                      <span className="text-[10px] text-subtle">
                        +{(items.length - 3).toLocaleString("fa-IR")}
                      </span>
                    )}
                  </div>
                  {(sprintMarks.get(c.iso) ?? []).map((t) => (
                    <p
                      key={t}
                      className="truncate rounded-sm bg-accent/15 px-1 text-[10px] text-fg"
                      title={t}
                    >
                      ⚡ {t}
                    </p>
                  ))}
                  <ul className="mt-0.5 space-y-0.5">
                    {items.slice(0, 3).map((card) => (
                      <li key={card.id}>
                        <button
                          type="button"
                          onClick={() => onOpenCard?.(card.id)}
                          title={card.title}
                          className={cn(
                            "block w-full truncate rounded-sm border-s-2 bg-surface-2 px-1.5 py-0.5 text-start text-[11px] hover:bg-accent-soft",
                            PRIORITY_BAR[card.priority],
                            card.done && "text-subtle line-through",
                            !card.done &&
                              isOverdue(card.dueDate, false) &&
                              "text-danger",
                          )}
                        >
                          {card.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
