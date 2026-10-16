import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Paperclip, Search, Send, X } from "lucide-react";
import { toast } from "sonner";
import { listLocalUsers } from "@/lib/local-users";
import { listBoards, getBoard } from "@/lib/local-db";
import {
  REPORT_KINDS,
  REPORT_KIND_LABEL,
  REPORT_PRIORITIES,
  REPORT_PRIORITY_LABEL,
  sendWorkReport,
  type ReportAttachment,
  type ReportKind,
  type ReportPriority,
} from "@/lib/work-reports";
import { uploadAppFile } from "@/lib/files";
import { readFileAsBase64 } from "@/lib/chat-file";
import { useLocalSession } from "@/lib/local-session";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { UserAvatar } from "./user-avatar";

/** Same limits as the server (src/lib/work-reports.ts, src/lib/files.ts). */
const MAX_BODY = 20_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 6;
const ALLOWED_EXT = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "csv",
  "txt",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "zip",
];

const TEMPLATES: Record<ReportKind, string> = {
  general: "",
  daily:
    "انجام‌شده:\n- \n\nدر حال انجام:\n- \n\nموانع و مشکلات:\n- \n\nبرنامه فردا:\n- ",
  weekly:
    "دستاوردهای این هفته:\n- \n\nکارهای نیمه‌تمام:\n- \n\nریسک‌ها و موانع:\n- \n\nنیاز به تصمیم یا کمک شما:\n- \n\nبرنامه هفته آینده:\n- ",
  issue:
    "شرح مشکل:\n\nزمان وقوع:\n\nاثر بر کار:\n\nاقدام انجام‌شده:\n\nکمک موردنیاز:\n",
  request: "موضوع درخواست:\n\nتوضیح:\n\nمهلت موردنیاز:\n",
  completion: "کار تحویل‌شده:\n\nنتیجه / خروجی:\n\nنکات مهم برای بررسی:\n",
};

const PRIORITY_STYLE: Record<ReportPriority, string> = {
  low: "border-border text-muted",
  normal: "border-border text-fg",
  high: "border-warning text-warning",
  urgent: "border-danger text-danger",
};

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Forwarding an existing report: prefilled text, pick new recipients. */
  forwardFrom?: {
    parentId: string;
    subject?: string;
    body: string;
    boardId?: string | null;
    boardTitle?: string | null;
    cardId?: string | null;
    cardTitle?: string | null;
  };
  /** Replying to a report: recipient is fixed to the sender, same board/card. */
  replyTo?: {
    parentId: string;
    subject?: string;
    toUsername: string;
    boardId?: string | null;
    boardTitle?: string | null;
    cardId?: string | null;
    cardTitle?: string | null;
  };
};

type Draft = {
  to: string[];
  boardId: string;
  cardId: string;
  subject: string;
  kind: ReportKind;
  priority: ReportPriority;
  body: string;
};

function readDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    return {
      to: Array.isArray(d.to)
        ? d.to.filter((x): x is string => typeof x === "string")
        : [],
      boardId: typeof d.boardId === "string" ? d.boardId : "",
      cardId: typeof d.cardId === "string" ? d.cardId : "",
      subject: typeof d.subject === "string" ? d.subject : "",
      kind: (REPORT_KINDS as readonly string[]).includes(d.kind ?? "")
        ? (d.kind as ReportKind)
        : "general",
      priority: (REPORT_PRIORITIES as readonly string[]).includes(
        d.priority ?? "",
      )
        ? (d.priority as ReportPriority)
        : "normal",
      body: typeof d.body === "string" ? d.body : "",
    };
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileProblem(f: File): string | null {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXT.includes(ext))
    return "فرمت فایل مجاز نیست (ورد، اکسل، پاورپوینت، PDF، تصویر، متن یا zip).";
  if (f.size > MAX_FILE_BYTES)
    return `حجم «${f.name}» (${formatBytes(f.size)}) بیشتر از ۵ مگابایت است.`;
  if (f.size === 0) return `«${f.name}» خالی است.`;
  return null;
}

export function SendReportDialog({
  open,
  onOpenChange,
  forwardFrom,
  replyTo,
}: Props) {
  const { user } = useLocalSession();
  const qc = useQueryClient();
  const usersQ = useQuery({
    queryKey: ["local-users"],
    queryFn: () => listLocalUsers(),
    enabled: open,
  });
  const boardsQ = useQuery({
    queryKey: ["boards"],
    queryFn: () => listBoards(),
    enabled: open,
  });

  const [to, setTo] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [boardId, setBoardId] = useState("");
  const [cardId, setCardId] = useState("");
  const [subject, setSubject] = useState("");
  const [kind, setKind] = useState<ReportKind>("general");
  const [priority, setPriority] = useState<ReportPriority>("normal");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const draftKey = user ? `sibamotor-report-draft:${user.username}` : null;
  const isPlainNew = !forwardFrom && !replyTo;

  // (Re)initialise every time the dialog opens — or when it is opened for a different report.
  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setFileError(null);
    setQuery("");
    if (forwardFrom) {
      setTo([]);
      setBoardId(forwardFrom.boardId ?? "");
      setCardId(forwardFrom.cardId ?? "");
      setSubject(forwardFrom.subject ? `ارجاع: ${forwardFrom.subject}` : "");
      setKind("general");
      setPriority("normal");
      setBody(forwardFrom.body ?? "");
    } else if (replyTo) {
      setTo([replyTo.toUsername]);
      setBoardId(replyTo.boardId ?? "");
      setCardId(replyTo.cardId ?? "");
      setSubject(replyTo.subject ? `پاسخ: ${replyTo.subject}` : "");
      setKind("general");
      setPriority("normal");
      setBody("");
    } else {
      const d = draftKey ? readDraft(draftKey) : null;
      setTo(d?.to ?? []);
      setBoardId(d?.boardId ?? "");
      setCardId(d?.cardId ?? "");
      setSubject(d?.subject ?? "");
      setKind(d?.kind ?? "general");
      setPriority(d?.priority ?? "normal");
      setBody(d?.body ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, forwardFrom?.parentId, replyTo?.parentId, draftKey]);

  // Auto-save a draft of a NEW report in this browser, so a closed tab never loses the text.
  useEffect(() => {
    if (!open || !isPlainNew || !draftKey) return;
    try {
      if (!body && !subject && to.length === 0 && !boardId)
        localStorage.removeItem(draftKey);
      else
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            to,
            boardId,
            cardId,
            subject,
            kind,
            priority,
            body,
          } satisfies Draft),
        );
    } catch {
      /* storage unavailable — ignore */
    }
  }, [
    open,
    isPlainNew,
    draftKey,
    to,
    boardId,
    cardId,
    subject,
    kind,
    priority,
    body,
  ]);

  const boardQ = useQuery({
    queryKey: ["board", boardId, "report-send"],
    queryFn: () => getBoard({ data: { boardId } }),
    enabled: Boolean(boardId) && open,
  });

  const cards = useMemo(
    () =>
      boardQ.data?.lists.flatMap((l) =>
        l.cards
          .filter((c) => !c.archived)
          .map((c) => ({ id: c.id, title: c.title })),
      ) ?? [],
    [boardQ.data],
  );

  const candidates = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.username !== user?.username),
    [usersQ.data, user?.username],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q),
    );
  }, [candidates, query]);
  const nameOf = (username: string) =>
    candidates.find((u) => u.username === username)?.displayName || username;

  const toggle = (username: string) =>
    setTo((prev) =>
      prev.includes(username)
        ? prev.filter((x) => x !== username)
        : [...prev, username],
    );

  function addFiles(list: FileList | File[] | null | undefined) {
    if (!list) return;
    const incoming = Array.from(list);
    const next = [...files];
    let problem: string | null = null;
    for (const f of incoming) {
      const p = fileProblem(f);
      if (p) {
        problem = p;
        continue;
      }
      if (next.length >= MAX_FILES) {
        problem = `حداکثر ${MAX_FILES.toLocaleString("fa-IR")} فایل می‌توان پیوست کرد.`;
        break;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size))
        next.push(f);
    }
    setFiles(next);
    setFileError(problem);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }

  function pickKind(k: ReportKind) {
    setKind(k);
    // an empty report gets the matching skeleton; typed text is never overwritten
    if (!body.trim() && TEMPLATES[k]) setBody(TEMPLATES[k]);
  }

  const blockReason =
    to.length === 0
      ? "حداقل یک گیرنده انتخاب کنید."
      : !body.trim() && files.length === 0
        ? "متن گزارش یا یک فایل لازم است."
        : body.length > MAX_BODY
          ? "متن گزارش بیش از حد مجاز است."
          : null;

  const mut = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("وارد نشده‌اید");
      const attachments: ReportAttachment[] = [];
      for (const file of files) {
        const payload = await readFileAsBase64(file);
        const up = await uploadAppFile({
          data: {
            filename: file.name,
            mime: file.type || "application/octet-stream",
            sizeBytes: file.size,
            dataBase64: payload.data,
          },
        });
        if (!up.ok) throw new Error(up.error);
        attachments.push({
          fileId: up.id,
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
        });
      }
      const boardTitle =
        boardsQ.data?.find((b) => b.id === boardId)?.title ??
        forwardFrom?.boardTitle ??
        replyTo?.boardTitle ??
        undefined;
      const cardTitle =
        cards.find((c) => c.id === cardId)?.title ??
        forwardFrom?.cardTitle ??
        replyTo?.cardTitle ??
        undefined;
      const parentId = forwardFrom?.parentId ?? replyTo?.parentId;
      // ONE call: the server writes a report per recipient and ties them together
      await sendWorkReport({
        data: {
          toUsernames: to,
          subject: subject.trim() || undefined,
          kind,
          priority,
          boardId: boardId || undefined,
          boardTitle,
          cardId: cardId || undefined,
          cardTitle,
          body: body.trim(),
          attachments,
          parentId,
        },
      });
      return to.length;
    },
    onSuccess: async (count) => {
      toast.success(
        count > 1 ? `گزارش برای ${count} نفر ارسال شد` : "گزارش ارسال شد",
      );
      if (draftKey) {
        try {
          localStorage.removeItem(draftKey);
        } catch {
          /* ignore */
        }
      }
      await qc.invalidateQueries({ queryKey: ["work-reports"] });
      await qc.invalidateQueries({ queryKey: ["notif"] });
      await qc.invalidateQueries({ queryKey: ["board"] });
      setBody("");
      setSubject("");
      setFiles([]);
      setTo([]);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message || "خطا در ارسال"),
  });

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (
      e.key === "Enter" &&
      (e.ctrlKey || e.metaKey) &&
      !blockReason &&
      !mut.isPending
    ) {
      e.preventDefault();
      mut.mutate();
    }
  }

  const title = forwardFrom
    ? "ارجاع گزارش"
    : replyTo
      ? "پاسخ به گزارش"
      : "گزارش جدید";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92vh] max-w-xl overflow-y-auto"
        onKeyDown={onKeyDown}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          گیرنده‌ها را انتخاب کنید، موضوع و نوع گزارش را مشخص کنید و در صورت
          نیاز فایل پیوست کنید.
        </DialogDescription>

        <div className="mt-3 space-y-4">
          {/* Recipients */}
          <div>
            <div className="flex items-center justify-between">
              <Label>گیرندگان</Label>
              <span className="text-[11px] text-muted">
                {to.length
                  ? `${to.length.toLocaleString("fa-IR")} نفر انتخاب شده`
                  : "هنوز انتخاب نشده"}
              </span>
            </div>
            {to.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {to.map((u) => (
                  <span
                    key={u}
                    className="inline-flex items-center gap-1.5 rounded-full border border-accent bg-accent-soft py-0.5 ps-1 pe-1 text-[12px]"
                  >
                    <UserAvatar username={u} name={nameOf(u)} size="xs" />
                    {nameOf(u)}
                    {!replyTo && (
                      <button
                        type="button"
                        aria-label={`حذف ${nameOf(u)}`}
                        className="grid size-5 place-items-center rounded-full hover:bg-surface-2"
                        onClick={() => toggle(u)}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {!replyTo && (
              <div className="mt-2 rounded-lg border border-border bg-surface">
                <div className="flex items-center gap-2 border-b border-border px-2.5">
                  <Search className="size-4 text-subtle" />
                  <input
                    className="h-9 w-full bg-transparent text-sm outline-none"
                    placeholder="جستجوی همکار…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {candidates.length > 1 && (
                    <button
                      type="button"
                      className="shrink-0 text-[11px] text-accent hover:underline"
                      onClick={() =>
                        setTo(
                          to.length === candidates.length
                            ? []
                            : candidates.map((u) => u.username),
                        )
                      }
                    >
                      {to.length === candidates.length ? "هیچ‌کدام" : "همه"}
                    </button>
                  )}
                </div>
                <ul className="k-scroll max-h-40 overflow-y-auto py-1">
                  {usersQ.isLoading && (
                    <li className="px-3 py-2 text-[12px] text-muted">
                      در حال بارگذاری…
                    </li>
                  )}
                  {!usersQ.isLoading && shown.length === 0 && (
                    <li className="px-3 py-2 text-[12px] text-muted">
                      کاربری پیدا نشد.
                    </li>
                  )}
                  {shown.map((u) => {
                    const on = to.includes(u.username);
                    return (
                      <li key={u.username}>
                        <button
                          type="button"
                          onClick={() => toggle(u.username)}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-1.5 text-start text-[13px] hover:bg-accent-soft",
                            on && "bg-accent-soft",
                          )}
                        >
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded border text-[10px]",
                              on
                                ? "border-accent bg-accent text-accent-fg"
                                : "border-border-strong",
                            )}
                          >
                            {on ? "✓" : ""}
                          </span>
                          <UserAvatar
                            username={u.username}
                            name={u.displayName}
                            size="xs"
                            presence
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {u.displayName}
                          </span>
                          <span className="text-[11px] text-subtle">
                            {u.role}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* Subject */}
          <div>
            <Label>موضوع</Label>
            <input
              className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
              value={subject}
              maxLength={160}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="مثلاً: گزارش پیشرفت پروژه، هفته سوم"
            />
          </div>

          {/* Kind + priority */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>نوع گزارش</Label>
              <div className="mt-1 flex flex-wrap gap-1">
                {REPORT_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => pickKind(k)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11px]",
                      kind === k
                        ? "border-accent bg-accent-soft font-medium text-fg"
                        : "border-border bg-surface-2 text-muted hover:border-accent",
                    )}
                  >
                    {REPORT_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label>اولویت</Label>
              <div className="mt-1 flex flex-wrap gap-1">
                {REPORT_PRIORITIES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11px]",
                      priority === p
                        ? cn("bg-accent-soft font-medium", PRIORITY_STYLE[p])
                        : "border-border bg-surface-2 text-muted",
                    )}
                  >
                    {REPORT_PRIORITY_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Related board / card */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>تخته مرتبط (اختیاری)</Label>
              <select
                className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-2 text-sm"
                value={boardId}
                onChange={(e) => {
                  setBoardId(e.target.value);
                  setCardId("");
                }}
              >
                <option value="">—</option>
                {(boardsQ.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>کارت مرتبط (اختیاری)</Label>
              <select
                className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-2 text-sm disabled:opacity-50"
                value={cardId}
                disabled={!boardId}
                onChange={(e) => setCardId(e.target.value)}
              >
                <option value="">
                  {boardId ? "—" : "ابتدا تخته را انتخاب کنید"}
                </option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Body */}
          <div>
            <Label>متن گزارش</Label>
            <Textarea
              className="mt-1"
              rows={9}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="شرح گزارش… (با انتخاب «نوع گزارش» یک قالب آماده درج می‌شود)"
            />
            <p
              className={cn(
                "mt-1 text-end text-[11px] tabular-nums",
                body.length > MAX_BODY
                  ? "text-danger"
                  : body.length > MAX_BODY * 0.85
                    ? "text-warning"
                    : "text-subtle",
              )}
            >
              {body.length.toLocaleString("fa-IR")} /{" "}
              {MAX_BODY.toLocaleString("fa-IR")}
            </p>
          </div>

          {/* Attachments */}
          <div>
            <Label>
              پیوست (اختیاری، تا {MAX_FILES.toLocaleString("fa-IR")} فایل، هر
              کدام حداکثر ۵ مگابایت)
            </Label>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                "mt-1 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-[13px] transition",
                dragging
                  ? "border-accent bg-accent-soft"
                  : "border-border-strong hover:border-accent",
              )}
            >
              <Paperclip className="size-4 shrink-0 text-muted" />
              <span className="text-muted">
                فایل‌ها را اینجا بکشید یا برای انتخاب کلیک کنید
              </span>
              <input
                type="file"
                multiple
                className="sr-only"
                accept={ALLOWED_EXT.map((x) => `.${x}`).join(",")}
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}-${f.size}`}
                    className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px]"
                  >
                    <Paperclip className="size-3.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="shrink-0 text-muted">
                      {formatBytes(f.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={`حذف ${f.name}`}
                      className="grid size-5 place-items-center rounded-full hover:bg-surface"
                      onClick={() =>
                        setFiles((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {fileError && (
              <p className="mt-1 text-[12px] text-danger">{fileError}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Button
              className="w-full"
              disabled={mut.isPending || Boolean(blockReason)}
              onClick={() => mut.mutate()}
            >
              <Send className="size-4" />
              {mut.isPending
                ? "در حال ارسال…"
                : forwardFrom
                  ? "ارجاع"
                  : replyTo
                    ? "ارسال پاسخ"
                    : to.length > 1
                      ? `ارسال برای ${to.length.toLocaleString("fa-IR")} نفر`
                      : "ارسال گزارش"}
            </Button>
            <p className="text-center text-[11px] text-subtle">
              {blockReason ?? "میان‌بر: Ctrl + Enter برای ارسال"}
              {isPlainNew && !blockReason
                ? " · پیش‌نویس به‌صورت خودکار ذخیره می‌شود"
                : ""}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
