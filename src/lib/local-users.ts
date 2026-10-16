// Login accounts (username/password) — all checks happen on the SERVER.
//
// • Passwords are hashed with scrypt (see server/password.server.ts).
// • Login creates a signed HttpOnly cookie (see server/session.server.ts).
// • Brute-force protection: 5 wrong tries lock the account for 15 minutes.
// • Admin rights come from the `is_admin` column — never from the browser.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "./db";
import {
  adminMiddleware,
  authAllowPwChangeMiddleware,
  authMiddleware,
} from "./session-middleware";
import type { LocalUser } from "./session-types";
import { parse } from "./validate";

export type { LocalUser } from "./session-types";

export type LoginOutcome =
  | { ok: true; user: LocalUser }
  | { ok: false; error: string; ticket?: undefined }
  | { ok: false; error: string; ticket: string };

/** Security events go to the audit log under the account name (never throws). */
async function securityLog(username: string, action: string, summary: string, displayName?: string) {
  const { audit } = await import("./server/audit.server");
  await audit({ actor: username, actorName: displayName ?? "", category: "security", action, summary });
}

async function accountLog(
  by: { username: string; displayName: string },
  action: string,
  summary: string,
) {
  const { audit } = await import("./server/audit.server");
  await audit({ actor: by.username, actorName: by.displayName, category: "account", action, summary });
}

const BAD_LOGIN = "نام کاربری یا رمز عبور نادرست است.";
const MAX_USER_FAILURES = 5;
const MAX_IP_FAILURES = 50;

/* ───────────────────────────── login / logout ───────────────────────────── */

export const loginWithPassword = createServerFn({ method: "POST" })
  .validator(parse(z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) })))
  .handler(async ({ data }): Promise<LoginOutcome> => {
    const s = await import("./server/session.server");
    const { verifyPassword, dummyVerify } = await import("./server/password.server");
    s.assertSameSite();

    const username = data.username.toLowerCase();
    const userKey = `u:${username}`;
    const ipKey = `ip:${s.clientIp()}`;
    if (await s.anyLocked([userKey, ipKey])) {
      await securityLog(username, "login.blocked", "تلاش برای ورود در زمانی که حساب/آی‌پی موقتاً قفل بود");
      return { ok: false, error: s.LOCKED_MESSAGE };
    }

    const row = await s.findUser(username);
    let valid = false;
    if (row) valid = await verifyPassword(data.password, row.password);
    else await dummyVerify(); // same timing for unknown users

    if (!row || !valid) {
      await s.registerFailure(userKey, MAX_USER_FAILURES);
      await s.registerFailure(ipKey, MAX_IP_FAILURES);
      await securityLog(
        username,
        "login.failed",
        row ? "ورود ناموفق (رمز عبور نادرست)" : "ورود ناموفق با نام کاربری ناشناخته",
        row?.display_name,
      );
      return { ok: false, error: BAD_LOGIN };
    }
    await s.clearFailures(userKey);

    if (row.pin_enabled && row.pin_hash) {
      return { ok: false, error: "", ticket: s.signPinTicket(row.username, row.session_version) };
    }
    s.setSessionCookie(row.username, row.session_version);
    await securityLog(row.username, "login.success", "وارد برنامه شد", row.display_name);
    return { ok: true, user: s.toLocalUser(row) };
  });

/** Step 2 of login for accounts with a PIN. The ticket proves the password step passed. */
export const loginWithPin = createServerFn({ method: "POST" })
  .validator(parse(z.object({ ticket: z.string().min(10).max(1000), pin: z.string().regex(/^\d{4,8}$/, "پین باید ۴ تا ۸ رقم باشد") })))
  .handler(async ({ data }): Promise<LoginOutcome> => {
    const s = await import("./server/session.server");
    const { verifyPassword } = await import("./server/password.server");
    s.assertSameSite();

    const t = s.readPinTicket(data.ticket);
    if (!t) return { ok: false, error: "مدت اعتبار ورود تمام شد؛ دوباره با رمز عبور وارد شوید." };
    const pinKey = `pin:${t.username}`;
    if (await s.anyLocked([pinKey])) {
      await securityLog(t.username, "login.blocked", "تلاش برای ورود با پین در زمانی که حساب قفل بود");
      return { ok: false, error: s.LOCKED_MESSAGE };
    }

    const row = await s.findUser(t.username);
    if (!row || row.session_version !== t.sessionVersion || !row.pin_hash) {
      return { ok: false, error: "ورود نامعتبر است؛ دوباره تلاش کنید." };
    }
    if (!(await verifyPassword(data.pin, row.pin_hash))) {
      await s.registerFailure(pinKey, MAX_USER_FAILURES);
      await securityLog(row.username, "login.pin_failed", "ورود ناموفق (پین نادرست)", row.display_name);
      return { ok: false, error: "پین نادرست است." };
    }
    await s.clearFailures(pinKey);
    s.setSessionCookie(row.username, row.session_version);
    await securityLog(row.username, "login.success", "وارد برنامه شد (با پین)", row.display_name);
    return { ok: true, user: s.toLocalUser(row) };
  });

/** Who am I? Called once when the page loads. */
export const getSessionUser = createServerFn({ method: "GET" }).handler(async (): Promise<LocalUser | null> => {
  const s = await import("./server/session.server");
  return s.readSessionUser();
});

export const logoutSession = createServerFn({ method: "POST" }).handler(async (): Promise<{ ok: true }> => {
  const s = await import("./server/session.server");
  s.assertSameSite();
  const who = await s.readSessionUser().catch(() => null);
  s.clearSessionCookie();
  if (who) await securityLog(who.username, "logout", "از برنامه خارج شد", who.displayName);
  return { ok: true };
});

/* ───────────────────────────── user directory ───────────────────────────── */

/** Everyone who is logged in can see the team list (needed for chat) — never passwords. */
export const listLocalUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async (): Promise<LocalUser[]> => {
    const sql = await getSql();
    const rows = await sql<{
      username: string;
      display_name: string;
      role: string;
      is_admin: boolean;
      avatar_updated_at: string | null;
      last_seen_at: string | null;
    }>`
      select username, display_name, role, is_admin, avatar_updated_at, last_seen_at
      from login_users order by username
    `;
    return rows.map((r) => ({
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      isAdmin: Boolean(r.is_admin),
      avatarVersion: r.avatar_updated_at ? new Date(r.avatar_updated_at).getTime() : null,
      lastSeenAt: r.last_seen_at,
    }));
  });

/* ───────────────────────────── admin only ───────────────────────────── */

type Result = { ok: true } | { ok: false; error: string };

/** Admin: create a login, or reset an existing one's password/name/role. */
export const upsertLocalUser = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .validator(
    parse(
      z.object({
        username: z.string().max(64),
        password: z.string().max(200),
        displayName: z.string().max(80),
        role: z.string().max(80),
      }),
    ),
  )
  .handler(async ({ data, context }): Promise<Result> => {
    const { hashPassword, passwordProblem } = await import("./server/password.server");
    const username = data.username.trim().toLowerCase();
    if (!username) return { ok: false, error: "نام کاربری الزامی است." };
    if (!/^[a-z0-9._-]+$/.test(username)) {
      return { ok: false, error: "نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد، نقطه و خط تیره باشد." };
    }
    const problem = passwordProblem(data.password, username);
    if (problem) return { ok: false, error: problem };

    const hashed = await hashPassword(data.password);
    const sql = await getSql();
    // New or reset accounts must choose their own password at first login,
    // and every old session of that user stops working (session_version + 1).
    await sql`
      insert into login_users (username, password, display_name, role, must_change_password)
      values (${username}, ${hashed}, ${data.displayName.trim() || username}, ${data.role.trim()}, true)
      on conflict (username) do update set
        password = excluded.password,
        display_name = excluded.display_name,
        role = excluded.role,
        must_change_password = true,
        session_version = login_users.session_version + 1
    `;
    await accountLog(
      context.user,
      "user.upsert",
      `حساب «${data.displayName.trim() || username}» (${username}) را ساخت یا رمز آن را بازنشانی کرد`,
    );
    return { ok: true };
  });

/** Admin: remove a login. Admin accounts and your own account cannot be removed. */
export const deleteLocalUser = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .validator(parse(z.object({ username: z.string().max(64) })))
  .handler(async ({ data, context }): Promise<Result> => {
    const username = data.username.trim().toLowerCase();
    if (username === context.user.username) return { ok: false, error: "نمی‌توانید حساب خودتان را حذف کنید." };
    const sql = await getSql();
    const target = await sql<{ is_admin: boolean }>`select is_admin from login_users where username = ${username}`;
    if (target[0]?.is_admin) return { ok: false, error: "حساب مدیر سیستم قابل حذف نیست." };
    await sql`delete from login_users where username = ${username}`;
    await sql`delete from user_permissions where username = ${username}`;
    await accountLog(context.user, "user.delete", `حساب «${username}» را حذف کرد`);
    return { ok: true };
  });

/* ───────────────────────────── my own account ───────────────────────────── */

/** Change MY password (must know the current one). Other devices are logged out. */
export const changeOwnPassword = createServerFn({ method: "POST" })
  .middleware([authAllowPwChangeMiddleware])
  .validator(
    parse(
      z.object({
        username: z.string().optional(), // ignored — the server uses the session
        currentPassword: z.string().max(200),
        newPassword: z.string().max(200),
      }),
    ),
  )
  .handler(async ({ data, context }): Promise<Result> => {
    const s = await import("./server/session.server");
    const { hashPassword, verifyPassword, passwordProblem } = await import("./server/password.server");
    const username = context.user.username;
    const key = `pw:${username}`;
    if (await s.anyLocked([key])) return { ok: false, error: s.LOCKED_MESSAGE };

    const problem = passwordProblem(data.newPassword, username);
    if (problem) return { ok: false, error: problem };
    if (data.newPassword === data.currentPassword) {
      return { ok: false, error: "رمز جدید نباید با رمز فعلی یکی باشد." };
    }
    const row = await s.findUser(username);
    if (!row || !(await verifyPassword(data.currentPassword, row.password))) {
      await s.registerFailure(key, MAX_USER_FAILURES);
      return { ok: false, error: "رمز فعلی نادرست است." };
    }
    await s.clearFailures(key);

    const hashed = await hashPassword(data.newPassword);
    const sql = await getSql();
    const updated = await sql<{ session_version: number }>`
      update login_users
      set password = ${hashed}, must_change_password = false, session_version = session_version + 1
      where username = ${username}
      returning session_version
    `;
    // keep THIS device logged in with the new session version
    s.setSessionCookie(username, updated[0]!.session_version);
    await accountLog(context.user, "password.change", "رمز عبور خود را تغییر داد");
    return { ok: true };
  });

/** Set or disable the optional PIN (second step at login) for MY account. */
export const setOwnPin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    parse(
      z.object({
        username: z.string().optional(), // ignored — the server uses the session
        password: z.string().max(200),
        pin: z.string().max(20).nullable(),
      }),
    ),
  )
  .handler(async ({ data, context }): Promise<Result> => {
    const s = await import("./server/session.server");
    const { hashPassword, verifyPassword } = await import("./server/password.server");
    const username = context.user.username;
    const key = `pw:${username}`;
    if (await s.anyLocked([key])) return { ok: false, error: s.LOCKED_MESSAGE };

    const row = await s.findUser(username);
    if (!row || !(await verifyPassword(data.password, row.password))) {
      await s.registerFailure(key, MAX_USER_FAILURES);
      return { ok: false, error: "رمز عبور نادرست است." };
    }
    await s.clearFailures(key);

    const sql = await getSql();
    if (data.pin === null || data.pin === "") {
      await sql`update login_users set pin_hash = null, pin_enabled = false where username = ${username}`;
      await accountLog(context.user, "pin.disable", "پین ورود را غیرفعال کرد");
      return { ok: true };
    }
    if (!/^\d{4,8}$/.test(data.pin)) return { ok: false, error: "پین باید ۴ تا ۸ رقم باشد." };
    const hashed = await hashPassword(data.pin);
    await sql`update login_users set pin_hash = ${hashed}, pin_enabled = true where username = ${username}`;
    await accountLog(context.user, "pin.enable", "پین ورود را فعال/تغییر داد");
    return { ok: true };
  });

