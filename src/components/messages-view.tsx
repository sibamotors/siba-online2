import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Copy,
  MessageSquare,
  MoreVertical,
  Pencil,
  File as FileIcon,
  Paperclip,
  Plus,
  Reply,
  Search,
  Send,
  Settings2,
  Smile,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EmojiPicker } from "@/components/emoji-picker";
import {
  addGroupMember,
  clearGroupMessages,
  createGroup,
  deleteGroupMessage,
  editGroupMessage,
  groupUnreadCounts,
  listGroupMessages,
  listGroupReads,
  listMyGroups,
  markGroupRead,
  removeGroupMember,
  renameGroup,
  sendGroupMessage,
} from "@/lib/groups";
import {
  dayLabelFa,
  formatRelativeFa,
  formatTimeFa,
  localDayIso,
} from "@/lib/jalali";
import { useLocalSession } from "@/lib/local-session";
import { listLocalUsers, type LocalUser } from "@/lib/local-users";
import {
  isSoundEnabled,
  playReceiveSound,
  playSendSound,
  setSoundEnabled,
} from "@/lib/message-sounds";
import {
  REACTION_EMOJIS,
  clearConversation,
  deleteMessage,
  editMessage,
  listMyMessages,
  listMyReactions,
  markConversationRead,
  sendMessage,
  toggleReaction,
  type ChatMessage,
  type MessageReaction,
} from "@/lib/messages";
import {
  decodeFileBody,
  decodeFileRef,
  encodeFileRef,
  formatFileSize,
  isFileBody,
  readFileAsBase64,
} from "@/lib/chat-file";
import { downloadAppFile } from "@/lib/download-file";
import { getAppFile, uploadAppFile } from "@/lib/files";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { UserAvatar, isOnline } from "./user-avatar";

type Props = { initialTo?: string };

type Active = { kind: "dm"; id: string } | { kind: "group"; id: string } | null;

type Conversation = {
  other: LocalUser;
  last?: ChatMessage;
  unread: number;
  messages: ChatMessage[];
};

/** One message in the open conversation, same shape for direct chats and groups. */
type ThreadItem = {
  id: string;
  mine: boolean;
  fromUsername: string;
  fromName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  replyToId: string | null;
  replyFromName: string | null;
  replyBody: string | null;
  tick: "sent" | "read" | null;
  /** group chat: print the sender's name above the first bubble of a run */
  showSender: boolean;
  /** group chat: print the sender's picture next to the last bubble of a run */
  showAvatar: boolean;
  isGroup: boolean;
  /** a "today / yesterday / date" separator goes above this message */
  dayLabel: string | null;
};

/** What the conversation list shows as the last message. */
function previewText(body: string, deleted: boolean): string {
  if (deleted) return "این پیام حذف شد";
  if (isFileBody(body)) {
    const ref = decodeFileRef(body);
    const legacy = decodeFileBody(body);
    return `📎 ${ref?.name ?? legacy?.name ?? "فایل"}`;
  }
  return body.replace(/\s+/g, " ");
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Plain text → React nodes: links become clickable, the search word is highlighted. */
function renderText(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  const mark = (s: string, keyBase: string): ReactNode => {
    if (!q) return s;
    const out: ReactNode[] = [];
    const lower = s.toLowerCase();
    let i = 0;
    let n = 0;
    while (i < s.length) {
      const at = lower.indexOf(q, i);
      if (at < 0) {
        out.push(s.slice(i));
        break;
      }
      if (at > i) out.push(s.slice(i, at));
      out.push(
        <mark
          key={`${keyBase}-${n++}`}
          className="rounded-sm bg-warning/40 px-0.5 text-inherit"
        >
          {s.slice(at, at + q.length)}
        </mark>,
      );
      i = at + q.length;
    }
    return out;
  };
  const parts = text.split(URL_RE);
  return parts.map((part, idx) => {
    if (idx % 2 === 1) {
      return (
        <a
          key={idx}
          href={part}
          target="_blank"
          rel="noopener noreferrer nofollow"
          dir="ltr"
          className="break-all underline underline-offset-2"
        >
          {part}
        </a>
      );
    }
    return <Fragment key={idx}>{mark(part, String(idx))}</Fragment>;
  });
}

export function MessagesView({ initialTo }: Props) {
  const { user } = useLocalSession();
  const qc = useQueryClient();
  const me = user?.username ?? "";
  const [active, setActive] = useState<Active>(
    initialTo ? { kind: "dm", id: initialTo } : null,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fileSending, setFileSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [replyTo, setReplyTo] = useState<{
    id: string;
    fromDisplayName: string;
    body: string;
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [manageGroupOpen, setManageGroupOpen] = useState(false);
  const [addMemberUser, setAddMemberUser] = useState("");
  const [groupRenameName, setGroupRenameName] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const seenMsgIds = useRef<Set<string> | null>(null);
  const seenGroupMsgIds = useRef<Set<string> | null>(null);

  // The conversation's own scroll box. Scrolling it NEVER moves the people list or the page.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const lastCountRef = useRef(0);

  const activeKey = active ? `${active.kind}:${active.id}` : "";
  const draft = drafts[activeKey] ?? "";
  const setDraft = useCallback(
    (v: string | ((prev: string) => string)) =>
      setDrafts((d) => {
        const prev = d[activeKey] ?? "";
        return { ...d, [activeKey]: typeof v === "function" ? v(prev) : v };
      }),
    [activeKey],
  );

  useEffect(() => {
    setSoundOn(isSoundEnabled());
  }, []);

  const usersQ = useQuery({
    queryKey: ["local-users"],
    queryFn: () => listLocalUsers(),
  });
  const msgQ = useQuery({
    queryKey: ["messages", me],
    queryFn: () => listMyMessages({ data: { username: me } }),
    enabled: Boolean(me),
    refetchInterval: 5000,
  });
  const groupsQ = useQuery({
    queryKey: ["groups", me],
    queryFn: () => listMyGroups({ data: { username: me } }),
    enabled: Boolean(me),
    refetchInterval: 20000,
  });
  const groupUnreadQ = useQuery({
    queryKey: ["groups-unread", me],
    queryFn: () => groupUnreadCounts({ data: { username: me } }),
    enabled: Boolean(me),
    refetchInterval: 10000,
  });
  const reactionsQ = useQuery({
    queryKey: ["reactions", me],
    queryFn: () => listMyReactions(),
    enabled: Boolean(me),
    refetchInterval: 8000,
  });

  const activeGroupId = active?.kind === "group" ? active.id : null;
  const groupMsgQ = useQuery({
    queryKey: ["group-messages", activeGroupId, me],
    queryFn: () =>
      listGroupMessages({ data: { groupId: activeGroupId!, username: me } }),
    enabled: Boolean(activeGroupId && me),
    refetchInterval: 5000,
  });
  const groupReadsQ = useQuery({
    queryKey: ["group-reads", activeGroupId],
    queryFn: () => listGroupReads({ data: { groupId: activeGroupId! } }),
    enabled: Boolean(activeGroupId),
    refetchInterval: 8000,
  });

  useEffect(() => {
    if (initialTo) setActive({ kind: "dm", id: initialTo });
  }, [initialTo]);

  // Play a chirp whenever a message addressed to me shows up for the first time.
  useEffect(() => {
    const msgs = msgQ.data ?? [];
    if (seenMsgIds.current === null) {
      seenMsgIds.current = new Set(msgs.map((m) => m.id));
      return;
    }
    const fresh = msgs.filter(
      (m) => m.toUsername === me && !seenMsgIds.current!.has(m.id),
    );
    if (fresh.length > 0) playReceiveSound();
    seenMsgIds.current = new Set(msgs.map((m) => m.id));
  }, [msgQ.data, me]);

  useEffect(() => {
    const msgs = groupMsgQ.data ?? [];
    if (seenGroupMsgIds.current === null) {
      seenGroupMsgIds.current = new Set(msgs.map((m) => m.id));
      return;
    }
    const fresh = msgs.filter(
      (m) => m.fromUsername !== me && !seenGroupMsgIds.current!.has(m.id),
    );
    if (fresh.length > 0) playReceiveSound();
    seenGroupMsgIds.current = new Set(msgs.map((m) => m.id));
  }, [groupMsgQ.data, me]);

  const others = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.username !== me),
    [usersQ.data, me],
  );

  const conversations = useMemo<Conversation[]>(() => {
    const msgs = msgQ.data ?? [];
    return others
      .map((other) => {
        const thread = msgs.filter(
          (m) =>
            (m.fromUsername === other.username && m.toUsername === me) ||
            (m.fromUsername === me && m.toUsername === other.username),
        );
        const last = thread[thread.length - 1];
        const unread = thread.filter(
          (m) => m.toUsername === me && !m.readAt && !m.deletedAt,
        ).length;
        return { other, last, unread, messages: thread };
      })
      .sort((a, b) =>
        (b.last?.createdAt ?? "").localeCompare(a.last?.createdAt ?? ""),
      );
  }, [others, msgQ.data, me]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.other.displayName.toLowerCase().includes(q) ||
        c.other.username.includes(q) ||
        c.other.role.toLowerCase().includes(q),
    );
  }, [conversations, filter]);

  const groups = groupsQ.data ?? [];
  const visibleGroups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, filter]);

  const currentDm =
    active?.kind === "dm"
      ? (conversations.find((c) => c.other.username === active.id) ?? null)
      : null;
  const currentGroup =
    active?.kind === "group"
      ? (groups.find((g) => g.id === active.id) ?? null)
      : null;

  /** The open conversation as one flat list (direct and group look the same to the thread). */
  const items = useMemo<ThreadItem[]>(() => {
    const out: ThreadItem[] = [];
    const base: Omit<
      ThreadItem,
      "showSender" | "showAvatar" | "isGroup" | "dayLabel"
    >[] = [];
    if (currentDm) {
      for (const m of currentDm.messages) {
        const mine = m.fromUsername === me;
        base.push({
          id: m.id,
          mine,
          fromUsername: m.fromUsername,
          fromName: m.fromDisplayName,
          body: m.body,
          createdAt: m.createdAt,
          editedAt: m.editedAt,
          deleted: Boolean(m.deletedAt),
          replyToId: m.replyToId,
          replyFromName: m.replyFromName,
          replyBody: m.replyBody,
          tick: mine ? (m.readAt ? "read" : "sent") : null,
        });
      }
    } else if (currentGroup) {
      const reads = groupReadsQ.data ?? [];
      const otherMembers = currentGroup.members.filter((u) => u !== me);
      const readByAll = (createdAt: string) =>
        otherMembers.length > 0 &&
        otherMembers.every((u) => {
          const r = reads.find((x) => x.username === u);
          return r && r.lastReadAt >= createdAt;
        });
      for (const m of groupMsgQ.data ?? []) {
        const mine = m.fromUsername === me;
        base.push({
          id: m.id,
          mine,
          fromUsername: m.fromUsername,
          fromName: m.fromDisplayName,
          body: m.body,
          createdAt: m.createdAt,
          editedAt: m.editedAt,
          deleted: Boolean(m.deletedAt),
          replyToId: m.replyToId,
          replyFromName: m.replyFromName,
          replyBody: m.replyBody,
          tick: mine ? (readByAll(m.createdAt) ? "read" : "sent") : null,
        });
      }
    }
    const isGroup = Boolean(currentGroup);
    for (let i = 0; i < base.length; i++) {
      const m = base[i]!;
      const prev = base[i - 1];
      const next = base[i + 1];
      const day = localDayIso(m.createdAt);
      const newDay = !prev || localDayIso(prev.createdAt) !== day;
      const nextNewDay = !next || localDayIso(next.createdAt) !== day;
      const firstOfRun =
        newDay || !prev || prev.fromUsername !== m.fromUsername;
      const lastOfRun =
        nextNewDay || !next || next.fromUsername !== m.fromUsername;
      out.push({
        ...m,
        showSender: isGroup && !m.mine && firstOfRun,
        showAvatar: isGroup && !m.mine && lastOfRun,
        isGroup,
        dayLabel: newDay ? dayLabelFa(m.createdAt) : null,
      });
    }
    return out;
  }, [currentDm, currentGroup, groupMsgQ.data, groupReadsQ.data, me]);

  const reactionsByMsg = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactionsQ.data ?? []) {
      const list = map.get(r.messageId) ?? [];
      list.push(r);
      map.set(r.messageId, list);
    }
    return map;
  }, [reactionsQ.data]);

  /* ───── scrolling: only the conversation's own box moves ───── */

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  function onThreadScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    stickRef.current = near;
    setShowJump(!near);
    if (near) setNewBelow(0);
  }

  // switching conversation → jump to the newest message (no animation)
  useLayoutEffect(() => {
    stickRef.current = true;
    lastCountRef.current = 0;
    setShowJump(false);
    setNewBelow(0);
    setFindOpen(false);
    setFindQ("");
    setReplyTo(null);
    setEditingId(null);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeKey]);

  // new messages: follow them if I was at the bottom (or I wrote them), otherwise show a "N new" button
  useEffect(() => {
    const count = items.length;
    const prevCount = lastCountRef.current;
    lastCountRef.current = count;
    if (count === 0 || count === prevCount) return;
    const lastItem = items[count - 1]!;
    if (prevCount === 0 || stickRef.current || lastItem.mine) {
      scrollToBottom(prevCount !== 0);
    } else {
      setNewBelow((n) => n + (count - prevCount));
      setShowJump(true);
    }
  }, [items, scrollToBottom]);

  /* ───── find inside the conversation ───── */

  const matches = useMemo(() => {
    const q = findQ.trim().toLowerCase();
    if (!findOpen || !q) return [] as string[];
    return items
      .filter(
        (m) =>
          !m.deleted && !isFileBody(m.body) && m.body.toLowerCase().includes(q),
      )
      .map((m) => m.id);
  }, [items, findQ, findOpen]);

  function jumpTo(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashId(id);
    window.setTimeout(
      () => setFlashId((cur) => (cur === id ? null : cur)),
      1600,
    );
  }

  useEffect(() => {
    if (matches.length === 0) return;
    const idx = matches.length - 1;
    setFindIdx(idx);
    jumpTo(matches[idx]!);
    // jump to the newest match whenever the word changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQ]);

  function stepFind(dir: 1 | -1) {
    if (matches.length === 0) return;
    const next = (findIdx + dir + matches.length) % matches.length;
    setFindIdx(next);
    jumpTo(matches[next]!);
  }

  /* ───── reading state ───── */

  useEffect(() => {
    if (!me || active?.kind !== "dm") return;
    const conv = conversations.find((c) => c.other.username === active.id);
    if (!conv || conv.unread === 0) return;
    void markConversationRead({
      data: { username: me, other: active.id },
    }).then(() => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["messages-unread"] });
      void qc.invalidateQueries({ queryKey: ["messages-unread-list"] });
    });
  }, [me, active, conversations, qc]);

  useEffect(() => {
    if (!me || active?.kind !== "group") return;
    void markGroupRead({ data: { username: me, groupId: active.id } }).then(
      () => {
        void qc.invalidateQueries({ queryKey: ["groups-unread"] });
        void qc.invalidateQueries({ queryKey: ["group-reads"] });
      },
    );
  }, [me, active, groupMsgQ.data, qc]);

  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    setSoundEnabled(next);
  }

  /* ───── the composer grows with the text (1 → 6 lines) ───── */
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
  }, [draft, activeKey]);

  const sendMut = useMutation({
    mutationFn: (vars: { body: string; to: string }) =>
      sendMessage({
        data: {
          from: me,
          to: vars.to,
          body: vars.body,
          replyToId: replyTo?.id ?? null,
        },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      playSendSound();
      setReplyTo(null);
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["messages-unread"] });
    },
    onError: () => toast.error("ارسال پیام ناموفق بود. اتصال را بررسی کنید."),
  });

  const sendGroupMut = useMutation({
    mutationFn: (vars: { body: string; groupId: string }) =>
      sendGroupMessage({
        data: {
          from: me,
          groupId: vars.groupId,
          body: vars.body,
          replyToId: replyTo?.id ?? null,
        },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      playSendSound();
      setReplyTo(null);
      void qc.invalidateQueries({ queryKey: ["group-messages"] });
      void qc.invalidateQueries({ queryKey: ["groups-unread"] });
    },
    onError: () => toast.error("ارسال پیام ناموفق بود. اتصال را بررسی کنید."),
  });

  const reactMut = useMutation({
    mutationFn: (vars: { messageId: string; emoji: string }) =>
      toggleReaction({ data: vars }),
    onSuccess: (res) => {
      if (!res.ok) toast.error(res.error);
      void qc.invalidateQueries({ queryKey: ["reactions"] });
    },
  });

  const editDmMut = useMutation({
    mutationFn: (vars: { id: string; body: string }) =>
      editMessage({ data: { username: me, id: vars.id, body: vars.body } }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setEditingId(null);
      void qc.invalidateQueries({ queryKey: ["messages"] });
    },
  });

  const deleteDmMut = useMutation({
    mutationFn: (id: string) => deleteMessage({ data: { username: me, id } }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      void qc.invalidateQueries({ queryKey: ["messages"] });
    },
  });

  const editGroupMut = useMutation({
    mutationFn: (vars: { id: string; body: string }) =>
      editGroupMessage({
        data: { username: me, id: vars.id, body: vars.body },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setEditingId(null);
      void qc.invalidateQueries({ queryKey: ["group-messages"] });
    },
  });

  const deleteGroupMut = useMutation({
    mutationFn: (id: string) =>
      deleteGroupMessage({ data: { username: me, id } }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      void qc.invalidateQueries({ queryKey: ["group-messages"] });
    },
  });

  const createGroupMut = useMutation({
    mutationFn: () =>
      createGroup({ data: { by: me, name: groupName, members: groupMembers } }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setGroupDialogOpen(false);
      setGroupName("");
      setGroupMembers([]);
      void qc.invalidateQueries({ queryKey: ["groups"] });
      setActive({ kind: "group", id: res.id });
    },
  });

  const addMemberMut = useMutation({
    mutationFn: (username: string) =>
      addGroupMember({
        data: {
          by: me,
          groupId: active?.kind === "group" ? active.id : "",
          username,
        },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("عضو اضافه شد");
      setAddMemberUser("");
      void qc.invalidateQueries({ queryKey: ["groups"] });
    },
  });

  const removeMemberMut = useMutation({
    mutationFn: (username: string) =>
      removeGroupMember({
        data: {
          by: me,
          groupId: active?.kind === "group" ? active.id : "",
          username,
        },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("عضو حذف شد");
      void qc.invalidateQueries({ queryKey: ["groups"] });
    },
  });

  const clearGroupMut = useMutation({
    mutationFn: () =>
      clearGroupMessages({
        data: { by: me, groupId: active?.kind === "group" ? active.id : "" },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("چت گروه پاک شد");
      setManageGroupOpen(false);
      void qc.invalidateQueries({ queryKey: ["group-messages"] });
    },
  });

  const renameGroupMut = useMutation({
    mutationFn: (name: string) =>
      renameGroup({
        data: {
          by: me,
          groupId: active?.kind === "group" ? active.id : "",
          name,
        },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("نام گروه تغییر کرد");
      void qc.invalidateQueries({ queryKey: ["groups"] });
    },
  });

  const clearDmMut = useMutation({
    mutationFn: (other: string) =>
      clearConversation({ data: { username: me, other } }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("گفتگو پاک شد");
      void qc.invalidateQueries({ queryKey: ["messages"] });
    },
  });

  const sending = sendMut.isPending || sendGroupMut.isPending;

  function sendBody(body: string) {
    if (!active) return;
    if (active.kind === "dm") sendMut.mutate({ body, to: active.id });
    else sendGroupMut.mutate({ body, groupId: active.id });
  }

  function submit() {
    const t = draft.trim();
    if (!t || !active || sending) return;
    sendBody(t);
    setDraft("");
  }

  async function submitFile(file: File) {
    if (!active || sending || fileSending) return;
    setFileSending(true);
    try {
      const payload = await readFileAsBase64(file);
      const up = await uploadAppFile({
        data: {
          filename: payload.name,
          mime: payload.mime,
          sizeBytes: payload.size,
          dataBase64: payload.data,
          uploadedBy: me,
        },
      });
      if (!up.ok) {
        toast.error(up.error);
        return;
      }
      sendBody(
        encodeFileRef({
          fileId: up.id,
          name: payload.name,
          mime: payload.mime,
          size: payload.size,
        }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "ارسال فایل ناموفق بود.",
      );
    } finally {
      setFileSending(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function startEdit(id: string, body: string) {
    setEditingId(id);
    setEditingBody(body);
  }

  function saveEdit() {
    const t = editingBody.trim();
    if (!t || !editingId) return;
    if (active?.kind === "dm") editDmMut.mutate({ id: editingId, body: t });
    else editGroupMut.mutate({ id: editingId, body: t });
  }

  function askDelete(id: string) {
    if (!window.confirm("این پیام حذف شود؟")) return;
    if (active?.kind === "dm") deleteDmMut.mutate(id);
    else deleteGroupMut.mutate(id);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("کپی شد");
    } catch {
      toast.error("کپی نشد.");
    }
  }

  if (!user) return null;

  const headerTitle = currentDm
    ? currentDm.other.displayName
    : currentGroup?.name;
  const dmEntry = currentDm
    ? (usersQ.data ?? []).find((u) => u.username === currentDm.other.username)
    : undefined;
  const dmOnline = isOnline(dmEntry?.lastSeenAt);

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <aside
        className={cn(
          "flex h-full min-h-0 w-full shrink-0 flex-col border-e border-border lg:w-[320px]",
          active ? "hidden lg:flex" : "flex",
        )}
      >
        <div className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-lg font-semibold">پیام‌ها</h1>
              <p className="text-[12px] text-muted">گفتگو با همکاران واحد</p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={soundOn ? "قطع صدا" : "فعال‌سازی صدا"}
                onClick={toggleSound}
                title={
                  soundOn ? "صدای پیام‌ها فعال است" : "صدای پیام‌ها خاموش است"
                }
              >
                {soundOn ? <Volume2 /> : <VolumeX />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="گروه جدید"
                onClick={() => setGroupDialogOpen(true)}
                title="ایجاد گروه جدید"
              >
                <Plus />
              </Button>
            </div>
          </div>
          <Input
            className="mt-2 h-9"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="جستجوی همکار یا گروه…"
          />
        </div>
        {/* the people list has its OWN scrollbar and never moves with the chat */}
        <ul className="k-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {visible.length === 0 && visibleGroups.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-muted">
              چیزی برای پیام پیدا نشد.
            </li>
          ) : (
            <>
              {visibleGroups.map((g) => {
                const on = active?.kind === "group" && active.id === g.id;
                const unread = (groupUnreadQ.data ?? {})[g.id] ?? 0;
                return (
                  <li key={g.id}>
                    <button
                      type="button"
                      onClick={() => setActive({ kind: "group", id: g.id })}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-accent-soft",
                        on && "bg-accent-soft",
                      )}
                    >
                      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-fg">
                        <Users className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {g.name}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                            {g.members.length} عضو
                          </span>
                          {unread > 0 && (
                            <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">
                              {unread}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {visible.map((c) => {
                const on =
                  active?.kind === "dm" && active.id === c.other.username;
                return (
                  <li key={c.other.username}>
                    <button
                      type="button"
                      onClick={() =>
                        setActive({ kind: "dm", id: c.other.username })
                      }
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-accent-soft",
                        on && "bg-accent-soft",
                      )}
                    >
                      <UserAvatar
                        username={c.other.username}
                        name={c.other.displayName}
                        size="md"
                        presence
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {c.other.displayName}
                          </span>
                          {c.last && (
                            <span className="shrink-0 text-[11px] text-subtle">
                              {formatRelativeFa(c.last.createdAt)}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-[12px]",
                              c.unread > 0
                                ? "font-medium text-fg"
                                : "text-muted",
                            )}
                          >
                            {c.last
                              ? `${c.last.fromUsername === me ? "شما: " : ""}${previewText(c.last.body, Boolean(c.last.deletedAt))}`
                              : c.other.role}
                          </span>
                          {c.unread > 0 && (
                            <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">
                              {c.unread}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </>
          )}
        </ul>
      </aside>

      <section
        className={cn(
          "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          !active && "hidden lg:flex",
        )}
        onDragOver={(e) => {
          if (!active) return;
          if (Array.from(e.dataTransfer.types).includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (!active || !f) return;
          e.preventDefault();
          void submitFile(f);
        }}
      >
        {!currentDm && !currentGroup ? (
          <div className="grid flex-1 place-items-center px-6 text-center">
            <div>
              <MessageSquare
                className="mx-auto size-10 text-subtle"
                strokeWidth={1.5}
              />
              <p className="mt-3 text-sm font-medium">
                یک گفتگو را انتخاب کنید
              </p>
              <p className="mt-1 text-[13px] text-muted">
                از فهرست سمت راست برای شروع پیام استفاده کنید.
              </p>
            </div>
          </div>
        ) : (
          <>
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="lg:hidden"
                aria-label="بازگشت"
                onClick={() => setActive(null)}
              >
                <ArrowRight />
              </Button>
              {currentGroup ? (
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-fg">
                  <Users className="size-5" />
                </span>
              ) : (
                <UserAvatar
                  username={currentDm!.other.username}
                  name={currentDm!.other.displayName}
                  size="md"
                  presence
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{headerTitle}</p>
                <p className="truncate text-[12px] text-muted">
                  {currentGroup ? (
                    `${currentGroup.members.length} عضو`
                  ) : (
                    <>
                      {dmOnline ? (
                        <span className="text-success">آنلاین</span>
                      ) : dmEntry?.lastSeenAt ? (
                        <>آخرین بازدید {formatRelativeFa(dmEntry.lastSeenAt)}</>
                      ) : (
                        currentDm!.other.role
                      )}
                      {" · "}
                      {currentDm!.other.role}
                    </>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="جستجو در گفتگو"
                title="جستجو در این گفتگو"
                onClick={() => {
                  setFindOpen((v) => !v);
                  setFindQ("");
                }}
              >
                <Search className="size-4" />
              </Button>
              {currentGroup ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="مدیریت گروه"
                  onClick={() => {
                    setGroupRenameName(currentGroup.name);
                    setManageGroupOpen(true);
                  }}
                >
                  <Settings2 className="size-4" />
                </Button>
              ) : currentDm ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="پاک کردن گفتگو"
                  onClick={() => {
                    if (confirm("همه پیام‌های این گفتگو پاک شوند؟")) {
                      clearDmMut.mutate(currentDm.other.username);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </header>

            {findOpen && (
              <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
                <Search className="size-4 shrink-0 text-subtle" />
                <input
                  autoFocus
                  value={findQ}
                  onChange={(e) => setFindQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      stepFind(e.shiftKey ? 1 : -1);
                    }
                    if (e.key === "Escape") {
                      setFindOpen(false);
                      setFindQ("");
                    }
                  }}
                  placeholder="جستجو در پیام‌ها… (Enter = قدیمی‌تر)"
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                />
                <span className="shrink-0 text-[11px] tabular-nums text-muted">
                  {findQ.trim()
                    ? matches.length > 0
                      ? `${(findIdx + 1).toLocaleString("fa-IR")} از ${matches.length.toLocaleString("fa-IR")}`
                      : "پیدا نشد"
                    : ""}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="قبلی"
                  onClick={() => stepFind(-1)}
                  disabled={matches.length === 0}
                >
                  <ChevronUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="بعدی"
                  onClick={() => stepFind(1)}
                  disabled={matches.length === 0}
                >
                  <ChevronDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="بستن جستجو"
                  onClick={() => {
                    setFindOpen(false);
                    setFindQ("");
                  }}
                >
                  <X />
                </Button>
              </div>
            )}

            {/* the conversation's own scroll box */}
            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                onScroll={onThreadScroll}
                className="k-scroll absolute inset-0 overflow-y-auto overscroll-contain px-3 py-4"
              >
                {items.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted">
                    هنوز پیامی نیست. اولین پیام را بفرستید.
                  </p>
                ) : (
                  <div className="mx-auto flex max-w-3xl flex-col gap-1">
                    {items.map((m) => (
                      <Fragment key={m.id}>
                        {m.dayLabel && (
                          <div className="my-2 flex justify-center">
                            <span className="rounded-full bg-surface-2 px-3 py-0.5 text-[11px] text-muted">
                              {m.dayLabel}
                            </span>
                          </div>
                        )}
                        <MessageBubble
                          item={m}
                          me={me}
                          flash={flashId === m.id}
                          findQ={findOpen ? findQ : ""}
                          reactions={reactionsByMsg.get(m.id) ?? []}
                          editingId={editingId}
                          editingBody={editingBody}
                          onEditingBodyChange={setEditingBody}
                          onSaveEdit={saveEdit}
                          onCancelEdit={() => setEditingId(null)}
                          onStartEdit={startEdit}
                          onDelete={askDelete}
                          onCopy={() => void copyText(m.body)}
                          onReply={() => {
                            setReplyTo({
                              id: m.id,
                              fromDisplayName: m.fromName,
                              body: previewText(m.body, false),
                            });
                            textareaRef.current?.focus();
                          }}
                          onReact={(emoji) =>
                            reactMut.mutate({ messageId: m.id, emoji })
                          }
                          onJumpToReply={() =>
                            m.replyToId && jumpTo(m.replyToId)
                          }
                          onMediaLoaded={() => {
                            if (stickRef.current) scrollToBottom(false);
                          }}
                        />
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
              {showJump && (
                <button
                  type="button"
                  onClick={() => {
                    stickRef.current = true;
                    scrollToBottom(true);
                    setNewBelow(0);
                  }}
                  className="absolute bottom-3 start-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border k-elevated px-3 py-1.5 text-[12px] shadow-[var(--shadow-flyout)] rtl:translate-x-1/2"
                >
                  <ChevronDown className="size-4" />
                  {newBelow > 0
                    ? `${newBelow.toLocaleString("fa-IR")} پیام جدید`
                    : "رفتن به آخرین پیام"}
                </button>
              )}
              {dragOver && (
                <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft text-sm font-medium">
                  فایل را رها کنید تا ارسال شود
                </div>
              )}
            </div>

            <footer className="shrink-0 border-t border-border p-3">
              {replyTo && (
                <div className="mb-2 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px]">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      پاسخ به {replyTo.fromDisplayName}
                    </p>
                    <p className="line-clamp-2 text-muted">{replyTo.body}</p>
                  </div>
                  <button
                    type="button"
                    className="text-subtle hover:text-fg"
                    onClick={() => setReplyTo(null)}
                    aria-label="لغو پاسخ"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void submitFile(f);
                }}
              />
              <div className="mx-auto flex max-w-3xl items-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="ارسال فایل"
                  title="ارسال فایل (یا بکشید و رها کنید، یا عکس را Paste کنید)"
                  disabled={!active || sending || fileSending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="size-4" />
                </Button>
                <EmojiPicker onPick={(e) => setDraft((d) => d + e)} />
                <Textarea
                  ref={textareaRef}
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="پیام خود را بنویسید… (Enter برای ارسال، Shift+Enter خط جدید)"
                  className="max-h-[150px] min-h-10 resize-none py-2.5 leading-5"
                  onPaste={(e) => {
                    const f = Array.from(e.clipboardData.files ?? [])[0];
                    if (f) {
                      e.preventDefault();
                      void submitFile(f);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  disabled={!draft.trim() || sending || fileSending}
                  onClick={submit}
                  aria-label="ارسال"
                >
                  <Send />
                </Button>
              </div>
              {fileSending && (
                <p className="mx-auto mt-1 max-w-3xl text-[11px] text-muted">
                  در حال ارسال فایل…
                </p>
              )}
            </footer>
          </>
        )}
      </section>

      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent>
          <DialogTitle>ایجاد گروه جدید</DialogTitle>
          <DialogDescription>
            یک نام برای گروه انتخاب کنید و همکاران را اضافه کنید.
          </DialogDescription>
          <div className="mt-4 space-y-3">
            <Input
              placeholder="نام گروه"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
            <div>
              <p className="mb-2 text-[12px] font-medium text-muted">اعضا</p>
              <ul className="k-scroll max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {others.map((u) => {
                  const checked = groupMembers.includes(u.username);
                  return (
                    <li key={u.username}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent-soft">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            setGroupMembers((prev) =>
                              e.target.checked
                                ? [...prev, u.username]
                                : prev.filter((x) => x !== u.username),
                            );
                          }}
                        />
                        <span className="flex-1 truncate">{u.displayName}</span>
                        <span className="text-[11px] text-subtle">
                          {u.role}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
            <Button
              className="w-full"
              disabled={
                !groupName.trim() ||
                groupMembers.length === 0 ||
                createGroupMut.isPending
              }
              onClick={() => createGroupMut.mutate()}
            >
              ایجاد گروه
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={manageGroupOpen} onOpenChange={setManageGroupOpen}>
        <DialogContent>
          <DialogTitle>مدیریت گروه</DialogTitle>
          <DialogDescription>
            {currentGroup ? currentGroup.name : "گروه"}
          </DialogDescription>
          {currentGroup ? (
            <div className="mt-4 space-y-4">
              <div>
                <p className="mb-2 text-[12px] font-medium text-muted">
                  اعضای فعلی
                </p>
                <ul className="k-scroll max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                  {currentGroup.members.map((uname) => {
                    const u = (usersQ.data ?? []).find(
                      (x) => x.username === uname,
                    );
                    const isCreator = currentGroup.createdBy === me;
                    return (
                      <li
                        key={uname}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                      >
                        <span className="flex-1 truncate">
                          {u?.displayName ?? uname}
                          {uname === currentGroup.createdBy ? (
                            <span className="ms-1 text-[10px] text-subtle">
                              (سازنده)
                            </span>
                          ) : null}
                        </span>
                        {isCreator && uname !== me ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="حذف عضو"
                            disabled={removeMemberMut.isPending}
                            onClick={() => {
                              if (
                                confirm(
                                  `حذف ${u?.displayName ?? uname} از گروه؟`,
                                )
                              ) {
                                removeMemberMut.mutate(uname);
                              }
                            }}
                          >
                            <UserMinus className="size-4 text-danger" />
                          </Button>
                        ) : uname === me ? (
                          <span className="text-[11px] text-subtle">شما</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
              {currentGroup.createdBy === me ? (
                <>
                  <div>
                    <p className="mb-2 text-[12px] font-medium text-muted">
                      تغییر نام گروه
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={groupRenameName}
                        onChange={(e) => setGroupRenameName(e.target.value)}
                        placeholder="نام جدید"
                      />
                      <Button
                        disabled={
                          !groupRenameName.trim() || renameGroupMut.isPending
                        }
                        onClick={() =>
                          renameGroupMut.mutate(groupRenameName.trim())
                        }
                      >
                        ذخیره
                      </Button>
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 text-[12px] font-medium text-muted">
                      افزودن عضو
                    </p>
                    <div className="flex gap-2">
                      <select
                        className="h-10 flex-1 rounded-lg border border-border bg-surface px-2 text-sm"
                        value={addMemberUser}
                        onChange={(e) => setAddMemberUser(e.target.value)}
                      >
                        <option value="">انتخاب کاربر…</option>
                        {(usersQ.data ?? [])
                          .filter(
                            (u) =>
                              u.username !== me &&
                              !currentGroup.members.includes(u.username),
                          )
                          .map((u) => (
                            <option key={u.username} value={u.username}>
                              {u.displayName}
                            </option>
                          ))}
                      </select>
                      <Button
                        disabled={!addMemberUser || addMemberMut.isPending}
                        onClick={() => addMemberMut.mutate(addMemberUser)}
                      >
                        <UserPlus className="size-4" />
                      </Button>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    className="w-full text-danger"
                    disabled={clearGroupMut.isPending}
                    onClick={() => {
                      if (
                        confirm(
                          "همه پیام‌های این گروه پاک شوند؟ این کار قابل برگشت نیست.",
                        )
                      ) {
                        clearGroupMut.mutate();
                      }
                    }}
                  >
                    پاک کردن همه پیام‌های گروه
                  </Button>
                </>
              ) : (
                <p className="text-[12px] text-muted">
                  فقط سازنده گروه می‌تواند نام را عوض کند، عضو اضافه/حذف کند یا
                  چت را پاک کند.
                </p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type BubbleProps = {
  item: ThreadItem;
  me: string;
  flash: boolean;
  findQ: string;
  reactions: MessageReaction[];
  editingId: string | null;
  editingBody: string;
  onEditingBodyChange: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onStartEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onCopy: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onJumpToReply: () => void;
  onMediaLoaded: () => void;
};

function MessageBubble({
  item,
  me,
  flash,
  findQ,
  reactions,
  editingId,
  editingBody,
  onEditingBodyChange,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onDelete,
  onCopy,
  onReply,
  onReact,
  onJumpToReply,
  onMediaLoaded,
}: BubbleProps) {
  const { id, mine, body, deleted, tick } = item;
  const isEditing = editingId === id;
  const [pickerOpen, setPickerOpen] = useState(false);
  const file = isFileBody(body);

  const chips = useMemo(() => {
    const map = new Map<string, { n: number; mine: boolean; who: string[] }>();
    for (const r of reactions) {
      const cur = map.get(r.emoji) ?? { n: 0, mine: false, who: [] };
      cur.n += 1;
      cur.who.push(r.username);
      if (r.username === me) cur.mine = true;
      map.set(r.emoji, cur);
    }
    return Array.from(map.entries());
  }, [reactions, me]);

  return (
    <article
      id={`msg-${id}`}
      className={cn(
        "flex items-end gap-2 rounded-xl transition-colors duration-500",
        mine ? "justify-start" : "justify-end",
        flash && "bg-warning/20",
        item.showSender ? "mt-2" : "",
      )}
    >
      <div
        className={cn(
          "group flex max-w-[85%] items-center gap-1",
          mine ? "flex-row" : "flex-row-reverse",
        )}
      >
        {!deleted && !isEditing && (
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="واکنش"
                  className="rounded-full p-1 text-subtle hover:bg-accent-soft"
                >
                  <Smile className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto p-1.5"
                align={mine ? "start" : "end"}
              >
                <div className="flex gap-0.5">
                  {REACTION_EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="rounded-md px-1.5 py-1 text-lg leading-none hover:bg-accent-soft"
                      onClick={() => {
                        setPickerOpen(false);
                        onReact(e);
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="گزینه‌های پیام"
                  className="rounded-full p-1 text-subtle hover:bg-accent-soft"
                >
                  <MoreVertical className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={mine ? "start" : "end"}>
                <DropdownMenuItem onSelect={onReply}>
                  <Reply className="size-3.5" /> پاسخ
                </DropdownMenuItem>
                {!file && (
                  <DropdownMenuItem onSelect={onCopy}>
                    <Copy className="size-3.5" /> کپی متن
                  </DropdownMenuItem>
                )}
                {mine && (
                  <>
                    {!file && (
                      <DropdownMenuItem onSelect={() => onStartEdit(id, body)}>
                        <Pencil className="size-3.5" /> ویرایش
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="text-danger"
                      onSelect={() => onDelete(id)}
                    >
                      <Trash2 className="size-3.5" /> حذف
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        <div className="min-w-0">
          <div
            className={cn(
              "rounded-2xl px-3 py-2 text-start text-[13px] leading-relaxed",
              mine
                ? "rounded-es-md bg-accent text-accent-fg"
                : "rounded-ee-md bg-surface-2 text-fg",
              deleted && "italic opacity-70",
            )}
          >
            {item.showSender && !deleted && (
              <span className="mb-0.5 block text-[11px] font-semibold text-accent">
                {item.fromName}
              </span>
            )}
            {item.replyBody && !deleted && (
              <button
                type="button"
                onClick={onJumpToReply}
                className={cn(
                  "mb-1 block w-full rounded-md border-s-2 px-2 py-1 text-start text-[12px]",
                  mine
                    ? "border-accent-fg/50 bg-black/10 text-accent-fg/90"
                    : "border-accent bg-accent-soft text-muted",
                )}
              >
                <span className="block font-medium">{item.replyFromName}</span>
                <span className="line-clamp-2">
                  {previewText(item.replyBody, false)}
                </span>
              </button>
            )}

            {deleted ? (
              <span>این پیام حذف شد</span>
            ) : isEditing ? (
              <div className="min-w-[200px]">
                <Textarea
                  autoFocus
                  rows={2}
                  value={editingBody}
                  onChange={(e) => onEditingBodyChange(e.target.value)}
                  className="min-h-10 resize-none bg-transparent text-[13px]"
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      onSaveEdit();
                    }
                    if (e.key === "Escape") onCancelEdit();
                  }}
                />
                <div className="mt-1 flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={onCancelEdit}>
                    انصراف
                  </Button>
                  <Button
                    size="sm"
                    onClick={onSaveEdit}
                    disabled={!editingBody.trim()}
                  >
                    ذخیره
                  </Button>
                </div>
              </div>
            ) : file ? (
              <FileAttachment
                body={body}
                mine={mine}
                onLoaded={onMediaLoaded}
              />
            ) : (
              <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {renderText(body, findQ)}
              </span>
            )}

            {!deleted && !isEditing && (
              <span
                className={cn(
                  "mt-1 flex items-center gap-1 text-[10px] tabular-nums",
                  mine ? "text-accent-fg/70" : "text-subtle",
                )}
              >
                {item.editedAt && <span>(ویرایش شده)</span>}
                {formatTimeFa(item.createdAt)}
                {tick === "sent" && <Check className="size-3.5" />}
                {tick === "read" && (
                  <CheckCheck className="size-3.5 text-sky-400" />
                )}
              </span>
            )}
          </div>
          {chips.length > 0 && !deleted && (
            <div
              className={cn(
                "mt-1 flex flex-wrap gap-1",
                mine ? "justify-start" : "justify-end",
              )}
            >
              {chips.map(([emoji, c]) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onReact(emoji)}
                  title={c.who.join("، ")}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] tabular-nums",
                    c.mine
                      ? "border-accent bg-accent-soft"
                      : "border-border bg-surface",
                  )}
                >
                  <span>{emoji}</span>
                  <span>{c.n.toLocaleString("fa-IR")}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {item.isGroup && !mine && (
        <span className="mb-0.5 w-8 shrink-0">
          {item.showAvatar && (
            <UserAvatar
              username={item.fromUsername}
              name={item.fromName}
              size="sm"
            />
          )}
        </span>
      )}
    </article>
  );
}

/** Images show a preview (click = full size). Other files download only when clicked. */
function FileAttachment({
  body,
  mine,
  onLoaded,
}: {
  body: string;
  mine: boolean;
  onLoaded: () => void;
}) {
  const legacy = decodeFileBody(body);
  const ref = decodeFileRef(body);
  const [href, setHref] = useState<string | null>(
    legacy ? `data:${legacy.mime};base64,${legacy.data}` : null,
  );
  const [meta, setMeta] = useState<{
    name: string;
    mime: string;
    size: number;
  } | null>(
    legacy ? { name: legacy.name, mime: legacy.mime, size: legacy.size } : ref,
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isImage = Boolean(meta?.mime.startsWith("image/"));

  useEffect(() => {
    if (!ref || legacy || !isImage) return;
    let cancelled = false;
    void getAppFile({ data: { id: ref.fileId } }).then((res) => {
      if (cancelled || !res.ok) return;
      setHref(`data:${res.mime};base64,${res.dataBase64}`);
      setMeta({ name: res.filename, mime: res.mime, size: res.sizeBytes });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.fileId, isImage]);

  if (!meta)
    return <span className="text-[12px] opacity-70">فایل نامعتبر</span>;

  async function download() {
    if (!meta) return;
    if (legacy || href) {
      const a = document.createElement("a");
      a.href = href ?? "";
      a.download = meta.name;
      a.click();
      return;
    }
    if (!ref) return;
    setBusy(true);
    const err = await downloadAppFile(ref.fileId, meta.name);
    setBusy(false);
    if (err) toast.error(err);
  }

  return (
    <div className="space-y-2">
      {isImage &&
        (href ? (
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="block"
            >
              <img
                src={href}
                alt={meta.name}
                onLoad={onLoaded}
                className="max-h-56 max-w-full rounded-lg object-contain"
              />
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent className="max-w-4xl">
                <DialogTitle className="truncate text-sm">
                  {meta.name}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  پیش‌نمایش تصویر
                </DialogDescription>
                <img
                  src={href}
                  alt={meta.name}
                  className="mt-2 max-h-[75vh] w-full rounded-lg object-contain"
                />
                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void download()}
                  >
                    دانلود
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </>
        ) : (
          <span className="block h-24 w-40 animate-pulse rounded-lg bg-black/10" />
        ))}
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:underline",
          mine ? "bg-black/10" : "bg-accent-soft",
        )}
      >
        <FileIcon className="size-4 shrink-0" />
        <span className="min-w-0 max-w-[200px] truncate font-medium">
          {meta.name}
        </span>
        <span className="shrink-0 opacity-70">
          {busy ? "…" : formatFileSize(meta.size)}
        </span>
      </button>
    </div>
  );
}
