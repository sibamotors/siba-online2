import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getBoard } from "@/lib/local-db";
import { requestOpenCard } from "@/lib/open-card";
import type { BoardSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { UserAvatar, useDirectory } from "./user-avatar";

type Item = {
  key: string;
  group: "صفحه" | "تخته" | "کارت" | "همکار";
  label: string;
  hint?: string;
  username?: string;
  run: () => void;
};

/** Ctrl+K (or ⌘K) — jump to any page, board, card or colleague. */
export function CommandPalette({
  boards,
  boardId,
}: {
  boards: BoardSummary[];
  boardId?: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const dirQ = useDirectory();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  const boardQs = useQueries({
    queries: boards.map((b) => ({
      queryKey: ["board", b.id, "palette"],
      queryFn: () => getBoard({ data: { boardId: b.id } }),
      enabled: open,
      staleTime: 30_000,
    })),
  });

  const items = useMemo<Item[]>(() => {
    const go = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const bid = boardId ?? boards[0]?.id;
    const out: Item[] = [];
    const pages: [string, () => void][] = [
      ["پیام‌ها", () => void navigate({ to: "/messages" })],
      ["گزارش‌ها", () => void navigate({ to: "/reports-inbox" })],
      ["کارهای من", () => void navigate({ to: "/my" })],
      ["لاگ فعالیت‌ها", () => void navigate({ to: "/activity" })],
      ["افراد", () => void navigate({ to: "/people" })],
    ];
    if (bid) {
      pages.unshift(
        [
          "اسکرام: اسپرینت و بک‌لاگ",
          () => void navigate({ to: "/b/$boardId/scrum", params: { boardId: bid } }),
        ],
        [
          "نمای تقویم",
          () =>
            void navigate({
              to: "/b/$boardId/calendar",
              params: { boardId: bid },
            }),
        ],
        [
          "گانت چارت",
          () =>
            void navigate({
              to: "/b/$boardId/gantt",
              params: { boardId: bid },
            }),
        ],
        [
          "داشبورد گزارش",
          () =>
            void navigate({
              to: "/b/$boardId/report",
              params: { boardId: bid },
            }),
        ],
      );
    }
    for (const [label, fn] of pages)
      out.push({ key: `p:${label}`, group: "صفحه", label, run: go(fn) });
    for (const b of boards) {
      out.push({
        key: `b:${b.id}`,
        group: "تخته",
        label: b.title,
        hint: `${b.cardCount.toLocaleString("fa-IR")} کارت`,
        run: go(
          () => void navigate({ to: "/b/$boardId", params: { boardId: b.id } }),
        ),
      });
    }
    for (const bq of boardQs) {
      const board = bq.data;
      if (!board) continue;
      for (const l of board.lists) {
        for (const c of l.cards) {
          if (c.archived) continue;
          out.push({
            key: `c:${c.id}`,
            group: "کارت",
            label: c.title,
            hint: `${board.title} · ${l.title}`,
            run: go(() => {
              void navigate({
                to: "/b/$boardId",
                params: { boardId: board.id },
              });
              requestOpenCard(c.id);
            }),
          });
        }
      }
    }
    for (const u of dirQ.data ?? []) {
      out.push({
        key: `u:${u.username}`,
        group: "همکار",
        label: u.displayName,
        hint: u.role,
        username: u.username,
        run: go(
          () => void navigate({ to: "/messages", search: { to: u.username } }),
        ),
      });
    }
    return out;
  }, [boards, boardId, boardQs, dirQ.data, navigate]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? items.filter((i) =>
          `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(s),
        )
      : items;
    return list.slice(0, 40);
  }, [items, q]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[18%] max-w-xl translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">جستجوی سریع</DialogTitle>
        <DialogDescription className="sr-only">
          جستجو در صفحه‌ها، تخته‌ها، کارت‌ها و همکاران
        </DialogDescription>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-subtle" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                shown[idx]?.run();
              }
            }}
            placeholder="کارت، تخته، همکار یا صفحه را جستجو کنید…"
            className="h-12 w-full bg-transparent text-sm outline-none"
          />
          <kbd
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-subtle"
            dir="ltr"
          >
            Esc
          </kbd>
        </div>
        <ul
          ref={listRef}
          className="k-scroll max-h-[50vh] overflow-y-auto py-1"
        >
          {shown.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-muted">
              نتیجه‌ای پیدا نشد.
            </li>
          )}
          {shown.map((it, i) => (
            <li key={it.key} data-idx={i}>
              {(i === 0 || shown[i - 1]!.group !== it.group) && (
                <p className="px-4 pb-0.5 pt-2 text-[11px] font-medium text-subtle">
                  {it.group}
                </p>
              )}
              <button
                type="button"
                onMouseMove={() => setIdx(i)}
                onClick={it.run}
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-2 text-start text-[13px]",
                  i === idx && "bg-accent-soft",
                )}
              >
                {it.username && (
                  <UserAvatar
                    username={it.username}
                    name={it.label}
                    size="xs"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && (
                  <span className="shrink-0 truncate text-[11px] text-muted">
                    {it.hint}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
