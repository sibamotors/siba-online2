import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Board } from "@/lib/types";
import {
  dayLabelFa,
  isoToJalaaliStr,
  isoToday,
  localDayIso,
} from "@/lib/jalali";
import {
  SCRUM_ROLES,
  SCRUM_ROLE_LABEL,
  STORY_POINTS,
  addScrumNote,
  completeSprint,
  createSprint,
  deleteScrumNote,
  deleteSprint,
  getScrum,
  parseStandup,
  saveStandup,
  setCardScrum,
  setScrumRole,
  startSprint,
  toggleScrumNote,
  type NoteKind,
  type ScrumData,
  type Sprint,
} from "@/lib/scrum";
import { useLocalSession } from "@/lib/local-session";
import { cn } from "@/lib/utils";
import { JalaliPicker } from "./jalali-picker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { UserAvatar, useDirectory } from "./user-avatar";

type Tab = "sprint" | "backlog" | "retro" | "velocity";
type Row = {
  id: string;
  title: string;
  listTitle: string;
  listIndex: number;
  done: boolean;
  priority: string;
};

const DAY = 86_400_000;
const dayNum = (iso: string) =>
  Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fa = (n: number) => n.toLocaleString("fa-IR");

function DateField({
  value,
  onChange,
  placeholder,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="h-10 min-w-32 rounded-lg border border-border bg-surface px-3 text-start text-sm"
        >
          {value ? (
            isoToJalaaliStr(value)
          ) : (
            <span className="text-subtle">{placeholder}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <JalaliPicker value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

/** Remaining story points per day against the ideal line. */
function Burndown({ sprint, data }: { sprint: Sprint; data: ScrumData }) {
  const snaps = data.snapshots.filter((s) => s.sprintId === sprint.id);
  if (!sprint.startDate || !sprint.endDate || snaps.length === 0) {
    return (
      <p className="py-6 text-center text-[12px] text-muted">
        نمودار برن‌داون بعد از ثبت اولین داده نمایش داده می‌شود.
      </p>
    );
  }
  const d0 = dayNum(sprint.startDate);
  const span = Math.max(1, dayNum(sprint.endDate) - d0);
  const total = Math.max(
    sprint.committedPoints,
    ...snaps.map((s) => s.total),
    1,
  );
  const W = 560;
  const H = 190;
  const P = { l: 34, r: 10, t: 10, b: 24 };
  const x = (d: number) =>
    P.l + (Math.min(Math.max(d, 0), span) / span) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - v / total) * (H - P.t - P.b);
  const actual = snaps
    .map((s) => `${x(dayNum(s.day) - d0)},${y(s.remaining)}`)
    .join(" ");
  const todayX = x(dayNum(isoToday()) - d0);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      dir="ltr"
      role="img"
      aria-label="نمودار برن‌داون"
    >
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={P.l}
            x2={W - P.r}
            y1={y(total * f)}
            y2={y(total * f)}
            stroke="currentColor"
            strokeOpacity="0.12"
          />
          <text
            x={P.l - 6}
            y={y(total * f) + 3}
            textAnchor="end"
            fontSize="10"
            fill="currentColor"
            opacity="0.6"
          >
            {Math.round(total * f)}
          </text>
        </g>
      ))}
      <line
        x1={x(0)}
        y1={y(total)}
        x2={x(span)}
        y2={y(0)}
        stroke="currentColor"
        strokeOpacity="0.4"
        strokeDasharray="4 4"
      />
      <line
        x1={todayX}
        x2={todayX}
        y1={P.t}
        y2={H - P.b}
        stroke="currentColor"
        strokeOpacity="0.2"
      />
      <polyline
        points={actual}
        fill="none"
        stroke="var(--k-accent)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {snaps.map((s) => (
        <circle
          key={s.day}
          cx={x(dayNum(s.day) - d0)}
          cy={y(s.remaining)}
          r="3"
          fill="var(--k-accent)"
        />
      ))}
      <text x={P.l} y={H - 6} fontSize="10" fill="currentColor" opacity="0.6">
        {isoToJalaaliStr(sprint.startDate)}
      </text>
      <text
        x={W - P.r}
        y={H - 6}
        textAnchor="end"
        fontSize="10"
        fill="currentColor"
        opacity="0.6"
      >
        {isoToJalaaliStr(sprint.endDate)}
      </text>
    </svg>
  );
}

export function ScrumView({
  board,
  onOpenCard,
}: {
  board: Board;
  onOpenCard?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const { user } = useLocalSession();
  const me = user?.username ?? "";
  const dirQ = useDirectory();
  const [tab, setTab] = useState<Tab>("sprint");
  const [retroSprint, setRetroSprint] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    goal: "",
    start: null as string | null,
    end: null as string | null,
  });
  const [sf, setSf] = useState<{
    yesterday: string;
    today: string;
    blockers: string;
  } | null>(null);
  const [noteText, setNoteText] = useState<Record<string, string>>({});

  const scrumQ = useQuery({
    queryKey: ["scrum", board.id],
    queryFn: () => getScrum({ data: { boardId: board.id } }),
    refetchInterval: 15000,
  });
  const data = scrumQ.data;
  const nameOf = (u: string) =>
    dirQ.data?.find((x) => x.username === u)?.displayName || u;

  const rows = useMemo<Row[]>(
    () =>
      board.lists.flatMap((l, i) =>
        l.cards
          .filter((c) => !c.archived)
          .map((c) => ({
            id: c.id,
            title: c.title,
            listTitle: l.title,
            listIndex: i,
            done: i === board.lists.length - 1,
            priority: c.priority,
          })),
      ),
    [board],
  );
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const info = useMemo(
    () => new Map((data?.cards ?? []).map((c) => [c.cardId, c])),
    [data],
  );
  const pointsOf = (id: string) => info.get(id)?.points ?? 0;

  const active = data?.sprints.find((s) => s.status === "active") ?? null;
  const planned = (data?.sprints ?? []).filter((s) => s.status === "planned");
  const completed = (data?.sprints ?? []).filter(
    (s) => s.status === "completed",
  );
  const cardsOf = (sprintId: string) =>
    rows.filter((r) => info.get(r.id)?.sprintId === sprintId);
  const backlog = rows.filter((r) => !r.done && !info.get(r.id)?.sprintId);
  const backlogPoints = backlog.reduce((n, r) => n + pointsOf(r.id), 0);
  const unestimated = backlog.filter((r) => !pointsOf(r.id)).length;

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["scrum", board.id] });
    void qc.invalidateQueries({ queryKey: ["activity"] });
  }
  type Res = { ok: boolean; error?: string };
  const handle = (ok: string) => (res: Res) => {
    if (!res.ok) {
      toast.error(res.error ?? "انجام نشد.");
      return;
    }
    if (ok) toast.success(ok);
    refresh();
  };
  const onError = () => toast.error("ارتباط با سرور برقرار نشد.");

  const createMut = useMutation({
    mutationFn: () =>
      createSprint({
        data: {
          boardId: board.id,
          name: form.name,
          goal: form.goal,
          startDate: form.start,
          endDate: form.end,
        },
      }),
    onSuccess: (r) => {
      if (r.ok) setForm({ name: "", goal: "", start: null, end: null });
      handle("اسپرینت ساخته شد")(r);
    },
    onError,
  });
  const startMut = useMutation({
    mutationFn: (id: string) => startSprint({ data: { id } }),
    onSuccess: handle("اسپرینت شروع شد"),
    onError,
  });
  const completeMut = useMutation({
    mutationFn: (id: string) => completeSprint({ data: { id } }),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(
          `اسپرینت بسته شد · ${fa(r.completedPoints)} امتیاز انجام شد${r.movedBack ? ` · ${fa(r.movedBack)} کارت به بک‌لاگ برگشت` : ""}`,
        );
        refresh();
      } else toast.error(r.error);
    },
    onError,
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteSprint({ data: { id } }),
    onSuccess: handle("حذف شد"),
    onError,
  });
  const cardMut = useMutation({
    mutationFn: (v: {
      cardId: string;
      points?: number | null;
      sprintId?: string | null;
    }) => setCardScrum({ data: { boardId: board.id, ...v } }),
    onSuccess: handle(""),
    onError,
  });
  const roleMut = useMutation({
    mutationFn: (v: {
      username: string;
      role: (typeof SCRUM_ROLES)[number];
      on: boolean;
    }) => setScrumRole({ data: { boardId: board.id, ...v } }),
    onSuccess: handle(""),
    onError,
  });
  const noteMut = useMutation({
    mutationFn: (v: {
      kind: NoteKind;
      sprintId: string | null;
      body: string;
    }) => addScrumNote({ data: { boardId: board.id, ...v } }),
    onSuccess: handle(""),
    onError,
  });
  const standupMut = useMutation({
    mutationFn: (v: {
      sprintId: string;
      yesterday: string;
      today: string;
      blockers: string;
    }) =>
      saveStandup({
        data: {
          boardId: board.id,
          day: localDayIso(new Date()) ?? isoToday(),
          ...v,
        },
      }),
    onSuccess: (r) => {
      if (r.ok) setSf(null);
      handle("استندآپ امروز ثبت شد")(r);
    },
    onError,
  });
  const toggleMut = useMutation({
    mutationFn: (id: string) => toggleScrumNote({ data: { id } }),
    onSuccess: () => refresh(),
    onError,
  });
  const delNoteMut = useMutation({
    mutationFn: (id: string) => deleteScrumNote({ data: { id } }),
    onSuccess: () => refresh(),
    onError,
  });

  if (!data)
    return (
      <div className="p-6 text-sm text-muted">
        {scrumQ.isError ? "بارگذاری اسکرام ناموفق بود." : "در حال بارگذاری…"}
      </div>
    );
  const canManage = data.canManage;

  const addNote = (key: string, kind: NoteKind, sprintId: string | null) => {
    const body = (noteText[key] ?? "").trim();
    if (!body) return;
    noteMut.mutate({ kind, sprintId, body });
    setNoteText((t) => ({ ...t, [key]: "" }));
  };

  function noteBox({
    kind,
    sprintId,
    title,
    empty,
    tone,
  }: {
    kind: NoteKind;
    sprintId: string | null;
    title: string;
    empty: string;
    tone?: string;
  }) {
    const key = `${kind}:${sprintId ?? ""}`;
    const list = data!.notes.filter(
      (n) => n.kind === kind && (n.sprintId ?? null) === sprintId,
    );
    const toggleable = kind === "impediment" || kind === "retro_action";
    return (
      <div key={key} className="rounded-xl border border-border k-glass p-3">
        <h3 className={cn("text-[13px] font-semibold", tone)}>{title}</h3>
        <ul className="mt-2 space-y-1">
          {list.length === 0 && (
            <li className="text-[12px] text-subtle">{empty}</li>
          )}
          {list.map((n) => (
            <li
              key={n.id}
              className="flex items-start gap-2 rounded-lg bg-surface-2 px-2 py-1.5 text-[12px]"
            >
              {toggleable && (
                <button
                  type="button"
                  aria-label="تغییر وضعیت"
                  onClick={() => toggleMut.mutate(n.id)}
                  className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded border",
                    n.resolved
                      ? "border-accent bg-accent text-accent-fg"
                      : "border-border-strong",
                  )}
                >
                  {n.resolved && <Check className="size-3" />}
                </button>
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 whitespace-pre-wrap",
                  n.resolved && "text-subtle line-through",
                )}
              >
                {n.body}
                <span className="ms-1.5 text-[10px] text-subtle">
                  · {nameOf(n.author)}
                </span>
              </span>
              {(n.author === me || canManage) && (
                <button
                  type="button"
                  aria-label="حذف"
                  className="text-subtle hover:text-danger"
                  onClick={() => delNoteMut.mutate(n.id)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {(kind !== "dod" || canManage) && (
          <div className="mt-2 flex gap-1.5">
            <Input
              className="h-9"
              value={noteText[key] ?? ""}
              onChange={(e) =>
                setNoteText((t) => ({ ...t, [key]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing)
                  addNote(key, kind, sprintId);
              }}
              placeholder="افزودن…"
            />
            <Button
              size="icon"
              variant="secondary"
              aria-label="افزودن"
              onClick={() => addNote(key, kind, sprintId)}
            >
              <Plus />
            </Button>
          </div>
        )}
      </div>
    );
  }

  function pointsSelect(id: string) {
    const v = info.get(id)?.points ?? null;
    return (
      <select
        key={`pts-${id}`}
        className="h-8 w-16 shrink-0 rounded-md border border-border bg-surface px-1 text-center text-[12px] disabled:opacity-50"
        value={v ?? ""}
        aria-label="امتیاز"
        onChange={(e) =>
          cardMut.mutate({
            cardId: id,
            points: e.target.value === "" ? null : Number(e.target.value),
          })
        }
      >
        <option value="">؟</option>
        {STORY_POINTS.map((p) => (
          <option key={p} value={p}>
            {fa(p)}
          </option>
        ))}
      </select>
    );
  }

  function cardLine(r: Row, children?: ReactNode) {
    return (
      <li
        key={r.id}
        className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5"
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            r.priority === "high"
              ? "bg-danger"
              : r.priority === "med"
                ? "bg-warning"
                : "bg-subtle/50",
          )}
          aria-hidden
        />
        <button
          type="button"
          onClick={() => onOpenCard?.(r.id)}
          className="min-w-0 flex-1 truncate text-start text-[13px] hover:underline"
        >
          {r.title}
        </button>
        <span className="hidden shrink-0 text-[11px] text-muted sm:inline">
          {r.listTitle}
        </span>
        {children}
      </li>
    );
  }

  /* ───── tabs ───── */

  const daysLeft = active?.endDate
    ? dayNum(active.endDate) - dayNum(isoToday())
    : null;
  const activeCards = active ? cardsOf(active.id) : [];
  const activeTotal = activeCards.reduce((n, r) => n + pointsOf(r.id), 0);
  const activeDone = activeCards
    .filter((r) => r.done)
    .reduce((n, r) => n + pointsOf(r.id), 0);
  const pct = activeTotal ? Math.round((activeDone / activeTotal) * 100) : 0;

  const todayKey = localDayIso(new Date()) ?? isoToday();
  const standups = active
    ? data.notes
        .filter((n) => n.kind === "standup" && n.sprintId === active.id)
        .map((n) => ({ author: n.author, e: parseStandup(n.body) }))
        .filter(
          (x): x is { author: string; e: NonNullable<typeof x.e> } =>
            x.e !== null,
        )
    : [];
  const myToday = standups.find(
    (x) => x.author === me && x.e.day === todayKey,
  )?.e;
  const form0 = sf ?? {
    yesterday: myToday?.yesterday ?? "",
    today: myToday?.today ?? "",
    blockers: myToday?.blockers ?? "",
  };
  const standupDays = [...new Set(standups.map((x) => x.e.day))]
    .sort()
    .reverse();

  // is the team on track? (actual remaining vs. the ideal straight line)
  let health: { label: string; tone: string } | null = null;
  if (active?.startDate && active.endDate && activeTotal > 0) {
    const span = Math.max(1, dayNum(active.endDate) - dayNum(active.startDate));
    const elapsed = Math.min(
      Math.max(dayNum(isoToday()) - dayNum(active.startDate), 0),
      span,
    );
    const ideal = activeTotal * (1 - elapsed / span);
    const remaining = activeTotal - activeDone;
    health =
      remaining === 0
        ? {
            label: "همهٔ کارها تمام شده 🎉",
            tone: "bg-success/15 text-success",
          }
        : remaining > ideal + Math.max(1, activeTotal * 0.1)
          ? { label: "عقب‌تر از برنامه", tone: "bg-danger/15 text-danger" }
          : { label: "طبق برنامه", tone: "bg-success/15 text-success" };
  }

  const standupPanel = active ? (
    <div className="rounded-2xl border border-border k-glass p-4">
      <h3 className="text-sm font-semibold">☀️ استندآپ روزانه</h3>
      <p className="mt-0.5 text-[12px] text-muted">
        هر روز کوتاه بنویسید: دیروز چه کردید، امروز چه می‌کنید و چه چیزی جلوی
        شما را گرفته. اگر مانعی بنویسید خودکار به فهرست موانع هم اضافه می‌شود.
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {(
          [
            ["yesterday", "دیروز چه کردم؟"],
            ["today", "امروز چه می‌کنم؟"],
            ["blockers", "چه چیزی مانع من است؟"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="block text-[12px] text-muted">
            {label}
            <Textarea
              rows={3}
              className="mt-1 resize-none text-[13px]"
              value={form0[k]}
              onChange={(e) => setSf({ ...form0, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          disabled={
            standupMut.isPending ||
            (!form0.yesterday.trim() &&
              !form0.today.trim() &&
              !form0.blockers.trim())
          }
          onClick={() => standupMut.mutate({ sprintId: active.id, ...form0 })}
        >
          {myToday ? "ویرایش استندآپ امروز" : "ثبت استندآپ امروز"}
        </Button>
        {myToday && (
          <span className="text-[11px] text-success">امروز ثبت کرده‌اید ✓</span>
        )}
      </div>
      {standupDays.length > 0 && (
        <div className="mt-4 space-y-3 border-t border-border pt-3">
          {standupDays.slice(0, 4).map((d, i) => (
            <div key={d}>
              <p className="mb-1 text-[11px] font-medium text-muted">
                {d === todayKey ? "امروز" : dayLabelFa(d)} ·{" "}
                {standups
                  .filter((x) => x.e.day === d)
                  .length.toLocaleString("fa-IR")}{" "}
                نفر
              </p>
              <ul className={cn("space-y-1.5", i > 0 && "opacity-90")}>
                {standups
                  .filter((x) => x.e.day === d)
                  .map((x) => (
                    <li
                      key={x.author}
                      className="flex gap-2 rounded-lg bg-surface-2 px-2.5 py-2 text-[12px]"
                    >
                      <UserAvatar
                        username={x.author}
                        name={nameOf(x.author)}
                        size="xs"
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="font-medium">{nameOf(x.author)}</p>
                        {x.e.yesterday && (
                          <p>
                            <span className="text-subtle">دیروز: </span>
                            {x.e.yesterday}
                          </p>
                        )}
                        {x.e.today && (
                          <p>
                            <span className="text-subtle">امروز: </span>
                            {x.e.today}
                          </p>
                        )}
                        {x.e.blockers && (
                          <p className="text-warning">
                            <span>مانع: </span>
                            {x.e.blockers}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  ) : null;

  const statTile = (label: string, value: string, tone?: string) => (
    <div
      key={label}
      className="rounded-xl border border-border k-glass px-3 py-2.5"
    >
      <p className="text-[11px] text-muted">{label}</p>
      <p className={cn("mt-0.5 text-xl font-semibold tabular-nums", tone)}>
        {value}
      </p>
    </div>
  );

  const sprintTab = (
    <div className="space-y-4">
      {active ? (
        <>
          <div className="rounded-2xl border border-border k-glass p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] text-muted">اسپرینت فعال</p>
                <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                  {active.name}
                  {health && (
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                        health.tone,
                      )}
                    >
                      {health.label}
                    </span>
                  )}
                </h2>
                {active.goal && (
                  <p className="mt-1 text-[13px] text-muted">
                    🎯 {active.goal}
                  </p>
                )}
                <p className="mt-1 text-[12px] text-subtle">
                  {active.startDate && isoToJalaaliStr(active.startDate)} تا{" "}
                  {active.endDate && isoToJalaaliStr(active.endDate)}
                  {daysLeft !== null && (
                    <span
                      className={cn(
                        "ms-2 font-medium",
                        daysLeft < 0
                          ? "text-danger"
                          : daysLeft <= 2
                            ? "text-warning"
                            : "text-fg",
                      )}
                    >
                      {daysLeft < 0
                        ? `${fa(-daysLeft)} روز دیرکرد`
                        : daysLeft === 0
                          ? "آخرین روز"
                          : `${fa(daysLeft)} روز مانده`}
                    </span>
                  )}
                </p>
              </div>
              {canManage && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={completeMut.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "اسپرینت بسته شود؟ کارت‌های ناتمام به بک‌لاگ برمی‌گردند.",
                      )
                    )
                      completeMut.mutate(active.id);
                  }}
                >
                  <Check className="size-4" />
                  بستن اسپرینت
                </Button>
              )}
            </div>
            <div className="mt-3">
              <div className="flex items-center justify-between text-[12px] text-muted">
                <span>
                  {fa(activeDone)} از {fa(activeTotal)} امتیاز انجام شد
                </span>
                <span className="tabular-nums">{fa(pct)}٪</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {activeCards.some((r) => !pointsOf(r.id)) && (
                <p className="mt-1.5 text-[11px] text-warning">
                  بعضی کارت‌های اسپرینت امتیاز ندارند؛ در بک‌لاگ تخمین بزنید.
                </p>
              )}
            </div>
            <div className="mt-3 text-fg">
              <p className="mb-1 text-[12px] font-medium text-muted">
                نمودار برن‌داون (خط چین = روند ایده‌آل)
              </p>
              <Burndown sprint={active} data={data} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {statTile("کل امتیاز اسپرینت", fa(activeTotal))}
            {statTile("انجام‌شده", fa(activeDone), "text-success")}
            {statTile(
              "باقی‌مانده",
              fa(activeTotal - activeDone),
              activeTotal - activeDone > 0 ? "text-warning" : "text-success",
            )}
            {statTile(
              "افزوده‌شده بعد از شروع",
              fa(Math.max(0, activeTotal - active.committedPoints)),
              activeTotal > active.committedPoints ? "text-danger" : undefined,
            )}
          </div>
          {standupPanel}

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {board.lists.map((l, i) => {
              const items = activeCards.filter((r) => r.listIndex === i);
              return (
                <div
                  key={l.id}
                  className="rounded-xl border border-border k-glass p-3"
                >
                  <h3 className="flex items-center justify-between text-[13px] font-semibold">
                    <span className="truncate">{l.title}</span>
                    <span className="text-[11px] font-normal text-muted">
                      {fa(items.length)} کارت ·{" "}
                      {fa(items.reduce((n, r) => n + pointsOf(r.id), 0))} امتیاز
                    </span>
                  </h3>
                  <ul className="mt-2 space-y-1.5">
                    {items.length === 0 && (
                      <li className="text-[12px] text-subtle">—</li>
                    )}
                    {items.map((r) =>
                      cardLine(
                        r,
                        <>
                          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] tabular-nums">
                            {pointsOf(r.id) ? fa(pointsOf(r.id)) : "؟"}
                          </span>
                        </>,
                      ),
                    )}
                  </ul>
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {noteBox({
              kind: "impediment",
              sprintId: active.id,
              title: "🚧 موانع (Impediments)",
              empty:
                "مانعی ثبت نشده. هر چیزی که جلوی تیم را گرفته اینجا بنویسید.",
              tone: "text-warning",
            })}
            {noteBox({
              kind: "dod",
              sprintId: null,
              title: "✅ تعریف «انجام‌شده» (Definition of Done)",
              empty: "هنوز معیاری تعریف نشده.",
            })}
          </div>
        </>
      ) : (
        <div className="rounded-2xl border border-border k-glass px-4 py-8 text-center">
          <h2 className="text-base font-semibold">اسپرینت فعالی وجود ندارد</h2>
          <p className="mt-1 text-[13px] text-muted">
            یک اسپرینت بسازید، کارت‌ها را از بک‌لاگ به آن اضافه کنید و شروعش
            کنید.
          </p>
        </div>
      )}

      {/* planned sprints */}
      {planned.map((s) => {
        const items = cardsOf(s.id);
        const pts = items.reduce((n, r) => n + pointsOf(r.id), 0);
        return (
          <div
            key={s.id}
            className="rounded-xl border border-border k-glass p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">
                  {s.name}{" "}
                  <span className="text-[11px] font-normal text-muted">
                    (برنامه‌ریزی‌شده)
                  </span>
                </h3>
                <p className="text-[12px] text-muted">
                  {fa(items.length)} کارت · {fa(pts)} امتیاز
                  {s.endDate
                    ? ` · پایان ${isoToJalaaliStr(s.endDate)}`
                    : " · تاریخ پایان مشخص نیست"}
                </p>
                {s.goal && (
                  <p className="text-[12px] text-muted">🎯 {s.goal}</p>
                )}
              </div>
              {canManage && (
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    disabled={Boolean(active) || startMut.isPending}
                    onClick={() => startMut.mutate(s.id)}
                    title={active ? "اول اسپرینت فعال را ببندید" : undefined}
                  >
                    شروع اسپرینت
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="حذف اسپرینت"
                    onClick={() =>
                      window.confirm("این اسپرینت حذف شود؟") &&
                      deleteMut.mutate(s.id)
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </div>
            <ul className="mt-2 space-y-1.5">
              {items.map((r) =>
                cardLine(
                  r,
                  <>
                    {pointsSelect(r.id)}
                    {canManage && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="برگرداندن به بک‌لاگ"
                        onClick={() =>
                          cardMut.mutate({ cardId: r.id, sprintId: null })
                        }
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                  </>,
                ),
              )}
            </ul>
          </div>
        );
      })}

      {canManage ? (
        <div className="rounded-xl border border-border k-glass p-3">
          <h3 className="text-sm font-semibold">اسپرینت جدید</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="نام اسپرینت، مثلاً اسپرینت ۱۲"
            />
            <Input
              value={form.goal}
              onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))}
              placeholder="هدف اسپرینت (Sprint Goal)"
            />
            <div className="flex flex-wrap items-center gap-2">
              <DateField
                value={form.start}
                onChange={(v) => setForm((f) => ({ ...f, start: v }))}
                placeholder="تاریخ شروع"
              />
              <DateField
                value={form.end}
                onChange={(v) => setForm((f) => ({ ...f, end: v }))}
                placeholder="تاریخ پایان"
              />
            </div>
            <div>
              <Button
                disabled={!form.name.trim() || createMut.isPending}
                onClick={() => createMut.mutate()}
              >
                <Plus className="size-4" />
                ساخت اسپرینت
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-subtle">
          ساخت و شروع اسپرینت فقط برای ادمین، اسکرام مستر و مالک محصول فعال است.
        </p>
      )}

      {/* roles */}
      <div className="rounded-xl border border-border k-glass p-3">
        <h3 className="text-sm font-semibold">نقش‌های اسکرام این تخته</h3>
        <p className="mt-0.5 text-[12px] text-muted">
          اسکرام مستر روند را روان نگه می‌دارد و موانع را برطرف می‌کند؛ مالک
          محصول اولویت بک‌لاگ را تعیین می‌کند. هر دو می‌توانند اسپرینت بسازند و
          شروع/ببندند.
        </p>
        <ul className="mt-2 space-y-1.5">
          {(dirQ.data ?? []).map((u) => {
            const mine = data.roles
              .filter((r) => r.username === u.username)
              .map((r) => r.role);
            return (
              <li
                key={u.username}
                className="flex flex-wrap items-center gap-2 text-[13px]"
              >
                <UserAvatar
                  username={u.username}
                  name={u.displayName}
                  size="xs"
                />
                <span className="min-w-0 flex-1 truncate">{u.displayName}</span>
                {SCRUM_ROLES.map((role) => {
                  const on = mine.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      disabled={!data.canAssignRoles || roleMut.isPending}
                      onClick={() =>
                        roleMut.mutate({ username: u.username, role, on: !on })
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[11px] disabled:cursor-default",
                        on
                          ? "border-accent bg-accent-soft font-medium"
                          : "border-border text-muted enabled:hover:border-accent",
                        !on && !data.canAssignRoles && "hidden",
                      )}
                    >
                      {SCRUM_ROLE_LABEL[role]}
                    </button>
                  );
                })}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );

  const backlogTab = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        <span>{fa(backlog.length)} کار در بک‌لاگ</span>
        <span>{fa(backlogPoints)} امتیاز</span>
        {unestimated > 0 && (
          <span className="text-warning">{fa(unestimated)} کار بدون تخمین</span>
        )}
      </div>
      {backlog.length === 0 ? (
        <p className="rounded-xl border border-border k-glass px-4 py-10 text-center text-sm text-muted">
          بک‌لاگ خالی است.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {backlog.map((r) =>
            cardLine(
              r,
              <>
                {pointsSelect(r.id)}
                {canManage && (
                  <select
                    className="h-8 w-32 shrink-0 rounded-md border border-border bg-surface px-1 text-[12px]"
                    value=""
                    aria-label="افزودن به اسپرینت"
                    onChange={(e) =>
                      e.target.value &&
                      cardMut.mutate({ cardId: r.id, sprintId: e.target.value })
                    }
                  >
                    <option value="">به اسپرینت…</option>
                    {[...(active ? [active] : []), ...planned].map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </>,
            ),
          )}
        </ul>
      )}
      <p className="text-[11px] text-subtle">
        تخمین با اعداد فیبوناچی (۱، ۲، ۳، ۵، ۸، ۱۳، ۲۱) انجام می‌شود؛ عدد
        بزرگ‌تر یعنی کار بزرگ‌تر یا نامطمئن‌تر. کارهای خیلی بزرگ را به کارت‌های
        کوچک‌تر بشکنید.
      </p>
    </div>
  );

  const retroTarget =
    retroSprint ?? completed[completed.length - 1]?.id ?? active?.id ?? null;
  const retroTab = (
    <div className="space-y-3">
      {[...completed, ...(active ? [active] : [])].length === 0 ? (
        <p className="rounded-xl border border-border k-glass px-4 py-10 text-center text-sm text-muted">
          بعد از شروع اولین اسپرینت، ریتروسپکتیو اینجا قابل ثبت است.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted">اسپرینت:</span>
            {[...completed, ...(active ? [active] : [])].map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setRetroSprint(s.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[12px]",
                  retroTarget === s.id
                    ? "border-accent bg-accent-soft font-medium"
                    : "border-border text-muted",
                )}
              >
                {s.name}
              </button>
            ))}
          </div>
          {retroTarget && (
            <div className="grid gap-3 md:grid-cols-3">
              {noteBox({
                kind: "retro_good",
                sprintId: retroTarget,
                title: "👍 چه چیزی خوب بود؟",
                empty: "هنوز چیزی ثبت نشده.",
                tone: "text-success",
              })}
              {noteBox({
                kind: "retro_improve",
                sprintId: retroTarget,
                title: "🔧 چه چیزی باید بهتر شود؟",
                empty: "هنوز چیزی ثبت نشده.",
                tone: "text-warning",
              })}
              {noteBox({
                kind: "retro_action",
                sprintId: retroTarget,
                title: "🎯 اقدام‌های بعدی",
                empty: "برای هر مورد بهبود یک اقدام مشخص بنویسید.",
              })}
            </div>
          )}
        </>
      )}
    </div>
  );

  const avg = completed.length
    ? completed.reduce((n, s) => n + s.completedPoints, 0) / completed.length
    : 0;
  const maxBar = Math.max(
    1,
    ...completed.map((s) => Math.max(s.completedPoints, s.committedPoints)),
  );
  const velocityTab = (
    <div className="space-y-3">
      {completed.length === 0 ? (
        <p className="rounded-xl border border-border k-glass px-4 py-10 text-center text-sm text-muted">
          بعد از بستن اولین اسپرینت، سرعت تیم (Velocity) اینجا نمایش داده
          می‌شود.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-border k-glass px-3 py-2.5">
              <p className="text-[11px] text-muted">میانگین سرعت</p>
              <p className="text-xl font-semibold tabular-nums">
                {fa(Math.round(avg * 10) / 10)}
              </p>
            </div>
            <div className="rounded-xl border border-border k-glass px-3 py-2.5">
              <p className="text-[11px] text-muted">امتیاز بک‌لاگ</p>
              <p className="text-xl font-semibold tabular-nums">
                {fa(backlogPoints)}
              </p>
            </div>
            <div className="rounded-xl border border-border k-glass px-3 py-2.5">
              <p className="text-[11px] text-muted">
                پیش‌بینی اسپرینت‌های باقی‌مانده
              </p>
              <p className="text-xl font-semibold tabular-nums">
                {avg > 0 ? fa(Math.ceil(backlogPoints / avg)) : "—"}
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-border k-glass p-4">
            <div className="flex h-44 items-end gap-3" dir="ltr">
              {completed.map((s) => (
                <div
                  key={s.id}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1"
                >
                  <div className="flex h-36 w-full items-end justify-center gap-1">
                    <div
                      className="w-1/3 rounded-t bg-surface-2"
                      style={{
                        height: `${(s.committedPoints / maxBar) * 100}%`,
                      }}
                      title={`تعهد: ${s.committedPoints}`}
                    />
                    <div
                      className="w-1/3 rounded-t bg-accent"
                      style={{
                        height: `${(s.completedPoints / maxBar) * 100}%`,
                      }}
                      title={`انجام: ${s.completedPoints}`}
                    />
                  </div>
                  <span
                    className="max-w-full truncate text-[11px] text-muted"
                    dir="rtl"
                  >
                    {s.name}
                  </span>
                  <span className="text-[11px] tabular-nums">
                    {s.completedPoints}/{s.committedPoints}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-subtle">
              خاکستری = امتیازی که تیم متعهد شد، رنگی = امتیازی که واقعاً تمام
              شد.
            </p>
          </div>
        </>
      )}
    </div>
  );

  const TABS: [Tab, string][] = [
    ["sprint", "اسپرینت"],
    ["backlog", `بک‌لاگ (${fa(backlog.length)})`],
    ["retro", "ریتروسپکتیو"],
    ["velocity", "سرعت تیم"],
  ];

  return (
    <div className="k-scroll mx-auto flex w-full max-w-6xl flex-col gap-4 overflow-y-auto px-4 py-5 pb-24">
      <div>
        <h1 className="text-xl font-semibold">اسکرام · {board.title}</h1>
        <p className="mt-1 text-[13px] text-muted">
          اسپرینت، بک‌لاگ، تخمین، برن‌داون، موانع، ریتروسپکتیو و سرعت تیم
        </p>
      </div>
      <div className="flex gap-1 self-start overflow-x-auto rounded-full bg-surface-2 p-1">
        {TABS.map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "shrink-0 rounded-full px-4 py-1.5 text-[12px] font-medium",
              tab === t
                ? "bg-accent text-accent-fg"
                : "text-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "sprint" && sprintTab}
      {tab === "backlog" && backlogTab}
      {tab === "retro" && retroTab}
      {tab === "velocity" && velocityTab}
    </div>
  );
}
