import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Check,
  Download,
  FileText,
  Forward,
  Paperclip,
  Plus,
  Reply,
  Search,
  Send,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useLocalSession } from "@/lib/local-session";
import { listLocalUsers } from "@/lib/local-users";
import {
  REPORT_KIND_LABEL,
  REPORT_PRIORITIES,
  REPORT_PRIORITY_LABEL,
  REPORT_STATUSES,
  REPORT_STATUS_LABEL,
  addReportComment,
  archiveReport,
  getWorkReport,
  listInboxReports,
  listSentReports,
  setReportStatus,
  type ReportPriority,
  type ReportStatus,
  type WorkReport,
} from "@/lib/work-reports";
import { downloadAppFile } from "@/lib/download-file";
import { formatFileSize } from "@/lib/chat-file";
import { formatDateTimeFa, formatRelativeFa } from "@/lib/jalali";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { SendReportDialog } from "./send-report-dialog";
import { UserAvatar } from "./user-avatar";
import { cn } from "@/lib/utils";

type Tab = "inbox" | "sent";

const STATUS_STYLE: Record<ReportStatus, string> = {
  sent: "bg-surface-2 text-muted",
  seen: "bg-accent-soft text-fg",
  in_review: "bg-warning/20 text-warning",
  approved: "bg-success/15 text-success",
  needs_revision: "bg-warning/25 text-warning",
  rejected: "bg-danger/15 text-danger",
};

const PRIORITY_DOT: Record<ReportPriority, string> = {
  low: "bg-subtle/50",
  normal: "bg-transparent",
  high: "bg-warning",
  urgent: "bg-danger",
};

function StatusBadge({ status }: { status: ReportStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
        STATUS_STYLE[status],
      )}
    >
      {REPORT_STATUS_LABEL[status]}
    </span>
  );
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

export function ReportsInboxView() {
  const { user } = useLocalSession();
  const qc = useQueryClient();
  const me = user?.username ?? "";
  const [tab, setTab] = useState<Tab>("inbox");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<ReportPriority | "all">(
    "all",
  );
  const [sendOpen, setSendOpen] = useState(false);
  const [forward, setForward] = useState<WorkReport | null>(null);
  const [reply, setReply] = useState<WorkReport | null>(null);
  const [comment, setComment] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [pendingStatus, setPendingStatus] = useState<ReportStatus | null>(null);

  const usersQ = useQuery({
    queryKey: ["local-users"],
    queryFn: () => listLocalUsers(),
    enabled: Boolean(me),
  });
  const inboxQ = useQuery({
    queryKey: ["work-reports", "inbox", me, archived],
    queryFn: () => listInboxReports({ data: { archived } }),
    enabled: Boolean(me),
    refetchInterval: 20000,
  });
  const sentQ = useQuery({
    queryKey: ["work-reports", "sent", me, archived],
    queryFn: () => listSentReports({ data: { archived } }),
    enabled: Boolean(me),
    refetchInterval: 20000,
  });
  const detailQ = useQuery({
    queryKey: ["work-reports", "one", selected],
    queryFn: () => getWorkReport({ data: { id: selected! } }),
    enabled: Boolean(selected && me),
    refetchInterval: 15000,
  });

  const nameOf = (username: string) =>
    usersQ.data?.find((u) => u.username === username)?.displayName || username;
  const unreadCount = !archived
    ? (inboxQ.data ?? []).filter((r) => !r.readAt).length
    : 0;

  const activeQ = tab === "inbox" ? inboxQ : sentQ;
  const all = activeQ.data ?? [];

  const stats = useMemo(() => {
    const inbox = inboxQ.data ?? [];
    const sent = sentQ.data ?? [];
    return {
      unread: archived ? 0 : inbox.filter((r) => !r.readAt).length,
      toReview: archived
        ? 0
        : inbox.filter(
            (r) =>
              r.status === "sent" ||
              r.status === "seen" ||
              r.status === "in_review",
          ).length,
      needsFix: archived
        ? 0
        : sent.filter((r) => r.status === "needs_revision").length,
      approved: archived
        ? 0
        : sent.filter((r) => r.status === "approved").length,
    };
  }, [inboxQ.data, sentQ.data, archived]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (tab === "inbox" && onlyUnread && r.readAt) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (priorityFilter !== "all" && r.priority !== priorityFilter)
        return false;
      if (!q) return true;
      const other = tab === "inbox" ? r.fromUsername : r.toUsername;
      const hay = [
        nameOf(other),
        other,
        r.subject,
        r.body,
        r.boardTitle,
        r.cardTitle,
        r.filename,
        REPORT_KIND_LABEL[r.kind],
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, tab, onlyUnread, statusFilter, priorityFilter, search, usersQ.data]);

  const detail = detailQ.data?.report ?? null;
  const comments = detailQ.data?.comments ?? [];
  const siblings = detailQ.data?.siblings ?? [];
  const iAmRecipient = detail?.toUsername === me;

  // Opening a report marks it as read on the server — refresh the lists and badges once.
  useEffect(() => {
    if (!detail?.id) return;
    void qc.invalidateQueries({ queryKey: ["work-reports", "inbox"] });
    void qc.invalidateQueries({ queryKey: ["notif"] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id]);

  useEffect(() => {
    setComment("");
    setReviewNote("");
    setPendingStatus(null);
  }, [selected]);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["work-reports"] });
    void qc.invalidateQueries({ queryKey: ["notif"] });
    void qc.invalidateQueries({ queryKey: ["board"] });
  }

  const statusMut = useMutation({
    mutationFn: (vars: { id: string; status: ReportStatus; note: string }) =>
      setReportStatus({
        data: {
          id: vars.id,
          status: vars.status as
            | "in_review"
            | "approved"
            | "needs_revision"
            | "rejected",
          note: vars.note,
        },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("وضعیت گزارش ثبت شد");
      setPendingStatus(null);
      setReviewNote("");
      refresh();
    },
    onError: () => toast.error("ثبت وضعیت ناموفق بود."),
  });

  const commentMut = useMutation({
    mutationFn: (vars: { id: string; body: string }) =>
      addReportComment({ data: vars }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setComment("");
      refresh();
    },
    onError: () => toast.error("ارسال یادداشت ناموفق بود."),
  });

  const archiveMut = useMutation({
    mutationFn: (vars: { id: string; archived: boolean }) =>
      archiveReport({ data: vars }),
    onSuccess: (res, vars) => {
      if (!res.ok) return;
      toast.success(vars.archived ? "به بایگانی رفت" : "از بایگانی خارج شد");
      setSelected(null);
      refresh();
    },
  });

  async function download(fileId: string, name: string) {
    const err = await downloadAppFile(fileId, name);
    if (err) toast.error(err);
  }

  function openNew() {
    setForward(null);
    setReply(null);
    setSendOpen(true);
  }

  function exportCsv() {
    const head = [
      "موضوع",
      tab === "inbox" ? "فرستنده" : "گیرنده",
      "نوع",
      "اولویت",
      "وضعیت",
      "تخته",
      "کارت",
      "تاریخ",
      "متن",
    ];
    const rows = list.map((r) =>
      [
        r.subject,
        nameOf(tab === "inbox" ? r.fromUsername : r.toUsername),
        REPORT_KIND_LABEL[r.kind],
        REPORT_PRIORITY_LABEL[r.priority],
        REPORT_STATUS_LABEL[r.status],
        r.boardTitle ?? "",
        r.cardTitle ?? "",
        formatDateTimeFa(r.createdAt),
        r.body,
      ]
        .map((c) => csvCell(String(c)))
        .join(","),
    );
    const blob = new Blob(
      ["﻿" + [head.map(csvCell).join(","), ...rows].join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reports-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function printReport() {
    if (!detail) return;
    const w = window.open(
      "",
      "_blank",
      "noopener,noreferrer,width=800,height=900",
    );
    if (!w) {
      toast.error("پنجرهٔ چاپ باز نشد؛ اجازهٔ پاپ‌آپ را بدهید.");
      return;
    }
    const meta = [
      ["فرستنده", nameOf(detail.fromUsername)],
      ["گیرنده", nameOf(detail.toUsername)],
      ["تاریخ", formatDateTimeFa(detail.createdAt)],
      ["نوع", REPORT_KIND_LABEL[detail.kind]],
      ["اولویت", REPORT_PRIORITY_LABEL[detail.priority]],
      ["وضعیت", REPORT_STATUS_LABEL[detail.status]],
      ...(detail.boardTitle ? [["تخته", detail.boardTitle]] : []),
      ...(detail.cardTitle ? [["کارت", detail.cardTitle]] : []),
    ];
    const thread = comments
      .map(
        (c) =>
          `<li><b>${esc(nameOf(c.author))}</b> <small>${esc(formatDateTimeFa(c.createdAt))}</small><div>${esc(c.body)}</div></li>`,
      )
      .join("");
    w.document
      .write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>${esc(detail.subject || "گزارش")}</title>
<style>body{font-family:Tahoma,Vazirmatn,sans-serif;margin:32px;color:#111;line-height:1.9}h1{font-size:20px;margin:0 0 12px}
table{border-collapse:collapse;margin-bottom:16px}td{padding:2px 12px 2px 0;font-size:13px}td:first-child{color:#666}
.body{white-space:pre-wrap;border:1px solid #ccc;border-radius:8px;padding:12px;font-size:14px}
ul{padding:0;list-style:none}li{border-top:1px solid #ddd;padding:6px 0;font-size:13px}small{color:#777}h2{font-size:15px;margin-top:20px}</style></head><body>
<h1>${esc(detail.subject || "گزارش")}</h1>
<table>${meta.map(([k, v]) => `<tr><td>${esc(k!)}</td><td>${esc(v!)}</td></tr>`).join("")}</table>
<div class="body">${esc(detail.body)}</div>
${detail.attachments.length ? `<h2>پیوست‌ها</h2><ul>${detail.attachments.map((a) => `<li>${esc(a.name)}</li>`).join("")}</ul>` : ""}
${thread ? `<h2>گفتگو و وضعیت‌ها</h2><ul>${thread}</ul>` : ""}
<script>window.onload=function(){window.print()}</script></body></html>`);
    w.document.close();
  }

  const otherOf = (r: WorkReport) =>
    tab === "inbox" ? r.fromUsername : r.toUsername;

  return (
    <div className="k-scroll mx-auto flex w-full max-w-6xl flex-col gap-4 overflow-y-auto px-4 py-5 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">گزارش‌ها</h1>
          <p className="mt-1 text-[13px] text-muted">
            ارسال، بررسی و تأیید گزارش‌ها، با گفتگو، پیوست و سابقهٔ کامل
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={exportCsv}
            disabled={list.length === 0}
          >
            <Download className="size-4" />
            خروجی CSV
          </Button>
          <Button size="sm" onClick={openNew}>
            <Plus className="size-4" />
            گزارش جدید
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "خوانده‌نشده", value: stats.unread, tone: "text-fg" },
          {
            label: "در انتظار بررسی من",
            value: stats.toReview,
            tone: "text-warning",
          },
          {
            label: "نیاز به اصلاح (ارسالی‌ها)",
            value: stats.needsFix,
            tone: "text-warning",
          },
          {
            label: "تأیید شده (ارسالی‌ها)",
            value: stats.approved,
            tone: "text-success",
          },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-border k-glass px-3 py-2.5"
          >
            <p className="text-[11px] text-muted">{s.label}</p>
            <p
              className={cn(
                "mt-0.5 text-xl font-semibold tabular-nums",
                s.tone,
              )}
            >
              {s.value.toLocaleString("fa-IR")}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 self-start rounded-full bg-surface-2 p-1">
          {(["inbox", "sent"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t);
                setSelected(null);
                setOnlyUnread(false);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-medium",
                tab === t
                  ? "bg-accent text-accent-fg"
                  : "text-muted hover:text-fg",
              )}
            >
              {t === "inbox" ? "دریافتی" : "ارسالی"}
              {t === "inbox" && unreadCount > 0 && (
                <span
                  className={cn(
                    "grid min-w-5 place-items-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
                    tab === t ? "bg-accent-fg/20" : "bg-accent text-accent-fg",
                  )}
                >
                  {unreadCount.toLocaleString("fa-IR")}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex h-9 min-w-[12rem] flex-1 items-center gap-2 rounded-full border border-border bg-surface-2 px-3 sm:max-w-xs">
          <Search className="size-4 shrink-0 text-subtle" />
          <input
            className="w-full bg-transparent text-[13px] outline-none"
            placeholder="جستجو در موضوع، متن، فرد…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select
          className="h-9 rounded-full border border-border bg-surface-2 px-3 text-[12px]"
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as ReportStatus | "all")
          }
          aria-label="فیلتر وضعیت"
        >
          <option value="all">همهٔ وضعیت‌ها</option>
          {REPORT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {REPORT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-full border border-border bg-surface-2 px-3 text-[12px]"
          value={priorityFilter}
          onChange={(e) =>
            setPriorityFilter(e.target.value as ReportPriority | "all")
          }
          aria-label="فیلتر اولویت"
        >
          <option value="all">همهٔ اولویت‌ها</option>
          {REPORT_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {REPORT_PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>

        {tab === "inbox" && (
          <button
            type="button"
            onClick={() => setOnlyUnread((v) => !v)}
            className={cn(
              "inline-flex h-9 items-center rounded-full border px-3 text-[12px]",
              onlyUnread
                ? "border-accent bg-accent-soft text-fg"
                : "border-border bg-surface-2 text-muted",
            )}
          >
            فقط خوانده‌نشده
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setArchived((v) => !v);
            setSelected(null);
          }}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12px]",
            archived
              ? "border-accent bg-accent-soft text-fg"
              : "border-border bg-surface-2 text-muted",
          )}
        >
          <Archive className="size-3.5" />
          بایگانی
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <ul
          className="space-y-2"
          aria-label={
            tab === "inbox" ? "گزارش‌های دریافتی" : "گزارش‌های ارسالی"
          }
        >
          {activeQ.isLoading &&
            [0, 1, 2].map((i) => (
              <li
                key={i}
                className="h-[5rem] animate-pulse rounded-xl border border-border bg-surface-2"
              />
            ))}
          {!activeQ.isLoading && list.length === 0 && (
            <li className="rounded-xl border border-border k-glass px-4 py-10 text-center">
              <FileText className="mx-auto mb-2 size-6 text-subtle" />
              <p className="text-sm text-muted">
                {search ||
                onlyUnread ||
                statusFilter !== "all" ||
                priorityFilter !== "all"
                  ? "گزارشی با این فیلتر پیدا نشد."
                  : archived
                    ? "بایگانی خالی است."
                    : tab === "inbox"
                      ? "هنوز گزارشی دریافت نکرده‌اید."
                      : "هنوز گزارشی ارسال نکرده‌اید."}
              </p>
              {!search && !archived && tab === "sent" && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  onClick={openNew}
                >
                  اولین گزارش را بنویسید
                </Button>
              )}
            </li>
          )}
          {list.map((r) => {
            const other = otherOf(r);
            const unread = tab === "inbox" && !r.readAt;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelected(r.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-start transition",
                    selected === r.id
                      ? "border-accent bg-accent-soft"
                      : "border-border k-glass hover:border-border-strong",
                    unread && selected !== r.id && "border-accent/40",
                  )}
                >
                  <UserAvatar username={other} name={nameOf(other)} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "truncate text-[13px]",
                          unread ? "font-semibold" : "font-medium",
                        )}
                      >
                        {r.subject || "بدون موضوع"}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-subtle">
                        {r.attachments.length > 0 && (
                          <Paperclip
                            className="size-3"
                            aria-label="دارای پیوست"
                          />
                        )}
                        {formatRelativeFa(r.createdAt)}
                        {unread && (
                          <span
                            className="size-2 rounded-full bg-accent"
                            aria-label="خوانده‌نشده"
                          />
                        )}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                      <span className="truncate">
                        {tab === "inbox" ? "از " : "به "}
                        {nameOf(other)}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">
                        {REPORT_KIND_LABEL[r.kind]}
                      </span>
                      {r.priority !== "normal" && (
                        <span className="inline-flex shrink-0 items-center gap-1">
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              PRIORITY_DOT[r.priority],
                            )}
                          />
                          {REPORT_PRIORITY_LABEL[r.priority]}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 line-clamp-1 block text-[12px] text-muted">
                      {r.body || r.filename || "—"}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={r.status} />
                      {r.commentCount > 0 && (
                        <span className="text-[10px] text-subtle">
                          {r.commentCount.toLocaleString("fa-IR")} یادداشت
                        </span>
                      )}
                      {(r.cardTitle || r.boardTitle) && (
                        <span className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-subtle">
                          {r.boardTitle}
                          {r.cardTitle ? ` · ${r.cardTitle}` : ""}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="min-h-[220px] rounded-2xl border border-border k-glass p-4 lg:sticky lg:top-2 lg:self-start">
          {!selected ? (
            <p className="py-12 text-center text-sm text-muted">
              یک گزارش را از فهرست انتخاب کنید.
            </p>
          ) : detailQ.isLoading || !detail ? (
            <div className="space-y-3" aria-busy="true">
              <div className="h-5 w-1/2 animate-pulse rounded bg-surface-2" />
              <div className="h-24 animate-pulse rounded bg-surface-2" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold">
                    {detail.subject || "بدون موضوع"}
                  </h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    <UserAvatar
                      username={detail.fromUsername}
                      name={nameOf(detail.fromUsername)}
                      size="xs"
                    />
                    <span>{nameOf(detail.fromUsername)}</span>
                    <span aria-hidden>←</span>
                    <UserAvatar
                      username={detail.toUsername}
                      name={nameOf(detail.toUsername)}
                      size="xs"
                    />
                    <span>{nameOf(detail.toUsername)}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-subtle">
                    {formatDateTimeFa(detail.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="چاپ یا PDF"
                    title="چاپ / ذخیره PDF"
                    onClick={printReport}
                  >
                    <FileText className="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={detail.archived ? "خروج از بایگانی" : "بایگانی"}
                    title={detail.archived ? "خروج از بایگانی" : "بایگانی"}
                    onClick={() =>
                      archiveMut.mutate({
                        id: detail.id,
                        archived: !detail.archived,
                      })
                    }
                  >
                    <Archive className="size-4" />
                  </Button>
                  {iAmRecipient && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => {
                          setForward(null);
                          setReply(detail);
                          setSendOpen(true);
                        }}
                      >
                        <Reply className="size-3.5" />
                        پاسخ
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setReply(null);
                          setForward(detail);
                          setSendOpen(true);
                        }}
                      >
                        <Forward className="size-3.5" />
                        ارجاع
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <StatusBadge status={detail.status} />
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">
                  {REPORT_KIND_LABEL[detail.kind]}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-muted",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      PRIORITY_DOT[detail.priority] === "bg-transparent"
                        ? "bg-subtle/40"
                        : PRIORITY_DOT[detail.priority],
                    )}
                  />
                  اولویت {REPORT_PRIORITY_LABEL[detail.priority]}
                </span>
                {detail.readAt && (
                  <span className="text-subtle">
                    خوانده شد {formatRelativeFa(detail.readAt)}
                  </span>
                )}
              </div>

              {(detail.boardTitle || detail.cardTitle) && (
                <p className="text-[12px] text-muted">
                  مرتبط با: {detail.boardTitle}
                  {detail.cardTitle ? ` / ${detail.cardTitle}` : ""}
                </p>
              )}
              {detail.body && (
                <div className="whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-3 text-[13px] leading-7">
                  {detail.body}
                </div>
              )}
              {detail.attachments.length > 0 && (
                <ul className="space-y-1">
                  {detail.attachments.map((a) => (
                    <li key={a.fileId}>
                      <button
                        type="button"
                        onClick={() => void download(a.fileId, a.name)}
                        className="flex w-full items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-start text-[12px] hover:bg-accent-soft"
                      >
                        <Paperclip className="size-3.5 shrink-0 text-muted" />
                        <span className="min-w-0 flex-1 truncate">
                          {a.name}
                        </span>
                        {a.size > 0 && (
                          <span className="shrink-0 text-muted">
                            {formatFileSize(a.size)}
                          </span>
                        )}
                        <Download className="size-3.5 shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {detail.parentId && (
                <p className="text-[11px] text-subtle">
                  این گزارش پاسخ یا ارجاعی به یک گزارش قبلی است.
                </p>
              )}

              {/* sender: how everyone who got the same report is doing */}
              {siblings.length > 1 && (
                <div className="rounded-lg border border-border p-2.5">
                  <p className="mb-1.5 text-[11px] font-medium text-muted">
                    وضعیت گیرندگان
                  </p>
                  <ul className="space-y-1">
                    {siblings.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-center gap-2 text-[12px]"
                      >
                        <UserAvatar
                          username={s.username}
                          name={nameOf(s.username)}
                          size="xs"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {nameOf(s.username)}
                        </span>
                        <StatusBadge status={s.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* recipient: review decision */}
              {iAmRecipient && (
                <div className="rounded-lg border border-border p-2.5">
                  <p className="mb-1.5 text-[11px] font-medium text-muted">
                    تصمیم شما دربارهٔ این گزارش
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        "in_review",
                        "approved",
                        "needs_revision",
                        "rejected",
                      ] as const
                    ).map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={statusMut.isPending}
                        onClick={() => {
                          if (s === "needs_revision" || s === "rejected") {
                            setPendingStatus(s);
                          } else {
                            statusMut.mutate({
                              id: detail.id,
                              status: s,
                              note: "",
                            });
                          }
                        }}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[12px]",
                          detail.status === s
                            ? "border-accent bg-accent-soft font-medium"
                            : "border-border hover:border-accent",
                        )}
                      >
                        {detail.status === s && <Check className="size-3" />}
                        {REPORT_STATUS_LABEL[s]}
                      </button>
                    ))}
                  </div>
                  {pendingStatus && (
                    <div className="mt-2 space-y-1.5">
                      <Textarea
                        rows={2}
                        autoFocus
                        value={reviewNote}
                        onChange={(e) => setReviewNote(e.target.value)}
                        placeholder={
                          pendingStatus === "rejected"
                            ? "دلیل رد را بنویسید…"
                            : "چه چیزی باید اصلاح شود؟"
                        }
                      />
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          disabled={!reviewNote.trim() || statusMut.isPending}
                          onClick={() =>
                            statusMut.mutate({
                              id: detail.id,
                              status: pendingStatus,
                              note: reviewNote,
                            })
                          }
                        >
                          ثبت «{REPORT_STATUS_LABEL[pendingStatus]}»
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPendingStatus(null)}
                        >
                          <X className="size-3.5" />
                          انصراف
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* thread: status changes + notes */}
              <div>
                <p className="mb-1.5 text-[11px] font-medium text-muted">
                  گفتگو و سابقه
                </p>
                {comments.length === 0 ? (
                  <p className="text-[12px] text-subtle">
                    هنوز یادداشتی ثبت نشده است.
                  </p>
                ) : (
                  <ul className="k-scroll max-h-64 space-y-2 overflow-y-auto pe-1">
                    {comments.map((c) => (
                      <li key={c.id} className="flex gap-2">
                        <UserAvatar
                          username={c.author}
                          name={nameOf(c.author)}
                          size="xs"
                        />
                        <div
                          className={cn(
                            "min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-[12px]",
                            c.kind === "status"
                              ? "border border-dashed border-border bg-transparent text-muted"
                              : "bg-surface-2",
                          )}
                        >
                          <p className="text-[11px] text-subtle">
                            <span className="font-medium text-fg">
                              {nameOf(c.author)}
                            </span>{" "}
                            · {formatDateTimeFa(c.createdAt)}
                          </p>
                          <p className="mt-0.5 whitespace-pre-wrap">
                            {c.kind === "status" ? `وضعیت: ${c.body}` : c.body}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex items-end gap-2">
                  <Textarea
                    rows={1}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="یادداشت یا پرسش…"
                    className="min-h-10 resize-none"
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        if (comment.trim())
                          commentMut.mutate({ id: detail.id, body: comment });
                      }
                    }}
                  />
                  <Button
                    size="icon"
                    aria-label="ارسال یادداشت"
                    disabled={!comment.trim() || commentMut.isPending}
                    onClick={() =>
                      commentMut.mutate({ id: detail.id, body: comment })
                    }
                  >
                    <Send />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <SendReportDialog
        open={sendOpen}
        onOpenChange={(v) => {
          setSendOpen(v);
          if (!v) {
            setForward(null);
            setReply(null);
          }
        }}
        forwardFrom={
          forward
            ? {
                parentId: forward.id,
                subject: forward.subject,
                body: forward.body,
                boardId: forward.boardId,
                boardTitle: forward.boardTitle,
                cardId: forward.cardId,
                cardTitle: forward.cardTitle,
              }
            : undefined
        }
        replyTo={
          reply
            ? {
                parentId: reply.id,
                subject: reply.subject,
                toUsername: reply.fromUsername,
                boardId: reply.boardId,
                boardTitle: reply.boardTitle,
                cardId: reply.cardId,
                cardTitle: reply.cardTitle,
              }
            : undefined
        }
      />
    </div>
  );
}
