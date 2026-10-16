import { useQuery } from "@tanstack/react-query";
import { getAvatar } from "@/lib/profile";
import { listLocalUsers } from "@/lib/local-users";
import { cn, initials } from "@/lib/utils";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE: Record<AvatarSize, string> = {
  xs: "size-6 text-[10px]",
  sm: "size-8 text-[12px]",
  md: "size-10 text-[13px]",
  lg: "size-14 text-lg",
  xl: "size-28 text-4xl",
};

const DOT: Record<AvatarSize, string> = {
  xs: "size-1.5",
  sm: "size-2",
  md: "size-2.5",
  lg: "size-3",
  xl: "size-4",
};

/** A user counts as "online" when their browser pinged the server in the last 2 minutes. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export function isOnline(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const t = new Date(lastSeenAt).getTime();
  return Number.isFinite(t) && now - t < ONLINE_WINDOW_MS;
}

/** Stable colour per person for the letter fallback. */
function hueOf(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

/** Shared, cached team directory (same query the chat and report screens already use). */
export function useDirectory() {
  return useQuery({
    queryKey: ["local-users"],
    queryFn: () => listLocalUsers(),
    staleTime: 30_000,
  });
}

type Props = {
  /** Login name. Without it (e.g. a person with no account) only the letters are shown. */
  username?: string | null;
  /** Display name — used for the letters and the tooltip. */
  name: string;
  size?: AvatarSize;
  /** Green dot when the person is online. */
  presence?: boolean;
  className?: string;
  /** Used instead of the directory (e.g. in the profile dialog preview). */
  src?: string | null;
};

export function UserAvatar({ username, name, size = "md", presence = false, className, src }: Props) {
  const dirQ = useDirectory();
  // No login name known (a person card, a comment author)? Fall back to matching by display name.
  const entry = username
    ? dirQ.data?.find((u) => u.username === username)
    : dirQ.data?.find((u) => u.displayName === name);
  const login = entry?.username ?? username ?? "";
  const version = entry?.avatarVersion ?? null;

  const imgQ = useQuery({
    queryKey: ["avatar", login, version],
    queryFn: () => getAvatar({ data: { username: login, v: version ?? undefined } }),
    enabled: Boolean(login) && version !== null && src === undefined,
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
  });
  const url = src !== undefined ? src : (imgQ.data?.dataUrl ?? null);
  const online = presence && isOnline(entry?.lastSeenAt);

  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", className)}>
      <span
        className={cn(
          "grid place-items-center overflow-hidden rounded-full font-semibold text-white select-none",
          SIZE[size],
        )}
        style={url ? undefined : { backgroundColor: `hsl(${hueOf(login || name)} 42% 40%)` }}
        title={name}
      >
        {url ? (
          <img src={url} alt={name} className="size-full object-cover" draggable={false} />
        ) : (
          initials(name)
        )}
      </span>
      {presence && (
        <span
          aria-label={online ? "آنلاین" : "آفلاین"}
          className={cn(
            "absolute -bottom-0.5 -end-0.5 rounded-full ring-2 ring-[var(--k-surface)]",
            DOT[size],
            online ? "bg-success" : "bg-subtle/60",
          )}
        />
      )}
    </span>
  );
}
