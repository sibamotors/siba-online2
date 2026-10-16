import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "./db";
import { adminMiddleware, authMiddleware } from "./session-middleware";
import { parse } from "./validate";

/** The browser shrinks the picture to ~256px before upload; this is the hard server limit. */
export const MAX_AVATAR_BYTES = 300 * 1024;

const AVATAR_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Real format check by file signature (never trust the MIME the browser says). */
function sniffImage(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes.length > 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

type Result = { ok: true } | { ok: false; error: string };

/** Set MY profile picture. */
export const setMyAvatar = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ dataBase64: z.string().min(20).max(500_000), mime: z.string().max(40) })))
  .handler(async ({ data, context }): Promise<Result> => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data.dataBase64)) return { ok: false, error: "تصویر نامعتبر است." };
    const bytes = Buffer.from(data.dataBase64, "base64");
    if (bytes.length > MAX_AVATAR_BYTES) return { ok: false, error: "حجم تصویر بیش از حد مجاز است." };
    const real = sniffImage(bytes);
    if (!real || !AVATAR_MIMES.has(real)) return { ok: false, error: "فقط تصویر JPG، PNG یا WebP مجاز است." };
    const sql = await getSql();
    await sql`
      update login_users
      set avatar = ${bytes}, avatar_mime = ${real}, avatar_updated_at = now()
      where username = ${context.user.username}
    `;
    const { audit } = await import("./server/audit.server");
    await audit({
      actor: context.user.username,
      actorName: context.user.displayName,
      category: "account",
      action: "avatar.set",
      summary: "عکس پروفایل خود را تغییر داد",
    });
    return { ok: true };
  });

export const removeMyAvatar = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Result> => {
    const sql = await getSql();
    await sql`
      update login_users set avatar = null, avatar_mime = null, avatar_updated_at = null
      where username = ${context.user.username}
    `;
    const { audit } = await import("./server/audit.server");
    await audit({
      actor: context.user.username,
      actorName: context.user.displayName,
      category: "account",
      action: "avatar.remove",
      summary: "عکس پروفایل خود را حذف کرد",
    });
    return { ok: true };
  });

/** Admin: remove somebody's picture (e.g. an inappropriate one). */
export const adminRemoveAvatar = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .validator(parse(z.object({ username: z.string().min(1).max(64) })))
  .handler(async ({ data, context }): Promise<Result> => {
    const username = data.username.trim().toLowerCase();
    const sql = await getSql();
    await sql`
      update login_users set avatar = null, avatar_mime = null, avatar_updated_at = null
      where username = ${username}
    `;
    const { audit } = await import("./server/audit.server");
    await audit({
      actor: context.user.username,
      actorName: context.user.displayName,
      category: "account",
      action: "avatar.admin_remove",
      summary: `عکس پروفایل «${username}» را حذف کرد`,
    });
    return { ok: true };
  });

/**
 * One user's picture as a data: URL. The browser caches it per (username, version)
 * through react-query, so it is downloaded once until the picture changes.
 */
export const getAvatar = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(parse(z.object({ username: z.string().min(1).max(64), v: z.number().optional() })))
  .handler(async ({ data }): Promise<{ dataUrl: string | null }> => {
    const sql = await getSql();
    const rows = await sql<{ avatar: Uint8Array | null; avatar_mime: string | null }>`
      select avatar, avatar_mime from login_users where username = ${data.username.trim().toLowerCase()}
    `;
    const r = rows[0];
    if (!r?.avatar || !r.avatar_mime || !AVATAR_MIMES.has(r.avatar_mime)) return { dataUrl: null };
    return { dataUrl: `data:${r.avatar_mime};base64,${Buffer.from(r.avatar).toString("base64")}` };
  });

/** "I'm online" ping (the browser calls it every minute). Cheap: writes at most once per 30 s per user. */
export const touchPresence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ ok: true }> => {
    const sql = await getSql();
    await sql`
      update login_users set last_seen_at = now()
      where username = ${context.user.username}
        and (last_seen_at is null or last_seen_at < now() - interval '30 seconds')
    `;
    return { ok: true };
  });
