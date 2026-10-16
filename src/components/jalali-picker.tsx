import { useEffect, useMemo, useState } from "react";
import {
  daysInJalaaliMonth,
  isoToJalaali,
  jalaaliToIso,
  JMONTHS,
  todayJalaali,
  weekdayOfJalaali,
  WEEKDAY_NAMES,
} from "@/lib/jalali";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

type Props = {
  value: string | null;
  onChange: (iso: string | null) => void;
  allowClear?: boolean;
};

export function JalaliPicker({ value, onChange, allowClear = true }: Props) {
  const selected = isoToJalaali(value);
  const [todayY, todayM, todayD] = todayJalaali();
  const [viewY, setViewY] = useState(selected?.[0] ?? todayY);
  const [viewM, setViewM] = useState(selected?.[1] ?? todayM);

  useEffect(() => {
    if (selected) {
      setViewY(selected[0]);
      setViewM(selected[1]);
    }
  }, [value]);

  const cells = useMemo(() => {
    const firstWeekday = weekdayOfJalaali(viewY, viewM, 1);
    const dim = daysInJalaaliMonth(viewY, viewM);
    const out: { day: number | null; iso: string | null }[] = [];
    for (let i = 0; i < firstWeekday; i++) out.push({ day: null, iso: null });
    for (let d = 1; d <= dim; d++) {
      out.push({ day: d, iso: jalaaliToIso(viewY, viewM, d) });
    }
    return out;
  }, [viewY, viewM]);

  function shiftMonth(delta: number) {
    let m = viewM + delta;
    let y = viewY;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    if (m > 12) {
      m = 1;
      y += 1;
    }
    setViewY(y);
    setViewM(m);
  }

  return (
    <div className="w-[280px] rounded-xl border border-border k-elevated p-3">
      <div className="mb-2 flex items-center justify-between">
        <Button variant="ghost" size="icon-sm" onClick={() => shiftMonth(1)} aria-label="ماه بعد">
          ‹
        </Button>
        <div className="flex items-center gap-1 text-sm font-medium">
          <select
            aria-label="ماه"
            className="h-8 rounded-md border border-transparent bg-transparent px-1 hover:border-border focus:border-accent"
            value={viewM}
            onChange={(e) => setViewM(Number(e.target.value))}
          >
            {JMONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <select
            aria-label="سال"
            className="h-8 rounded-md border border-transparent bg-transparent px-1 tabular-nums hover:border-border focus:border-accent"
            value={viewY}
            onChange={(e) => setViewY(Number(e.target.value))}
          >
            {Array.from({ length: 21 }, (_, i) => Math.min(todayY - 5, viewY) + i)
              .concat(viewY > todayY + 15 ? [viewY] : [])
              .filter((y, i, a) => a.indexOf(y) === i)
              .map((y) => (
                <option key={y} value={y}>
                  {y.toLocaleString("fa-IR", { useGrouping: false })}
                </option>
              ))}
          </select>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => shiftMonth(-1)} aria-label="ماه قبل">
          ›
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-subtle">
        {WEEKDAY_NAMES.map((w) => (
          <div key={w} className="py-1">
            {w.slice(0, 1)}
          </div>
        ))}
        {cells.map((c, i) => {
          const isSel = Boolean(c.iso && c.iso === value);
          const isToday = c.day === todayD && viewM === todayM && viewY === todayY;
          return (
            <button
              key={i}
              type="button"
              disabled={!c.day}
              onClick={() => c.iso && onChange(c.iso)}
              className={cn(
                "grid h-8 place-items-center rounded-sm text-[13px] tabular-nums",
                !c.day && "opacity-0",
                isSel && "bg-accent text-accent-fg",
                !isSel && c.day && "hover:bg-accent-soft",
                isToday && !isSel && "ring-1 ring-accent/50",
              )}
            >
              {c.day ?? ""}
            </button>
          );
        })}
      </div>
      {allowClear && (
        <button
          type="button"
          className="mt-2 w-full text-center text-[12px] text-muted hover:text-fg"
          onClick={() => onChange(null)}
        >
          پاک کردن تاریخ
        </button>
      )}
    </div>
  );
}
