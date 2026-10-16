import {
  CalendarDays,
  Eye,
  EyeOff,
  FileText,
  History,
  LayoutGrid,
  Lock,
  MessageSquare,
  Palette,
  Shield,
  ShieldCheck,
  Target,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { APP_CREDIT, APP_NAME, APP_TAGLINE } from "@/lib/constants";
import { useLocalSession } from "@/lib/local-session";
import { AppearancePanel } from "@/components/appearance-panel";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const FEATURES = [
  {
    icon: LayoutGrid,
    title: "تخته کانبان",
    desc: "کارت، چک‌لیست، وابستگی و مهلت",
  },
  {
    icon: Target,
    title: "اسکرام",
    desc: "اسپرینت، بک‌لاگ، استندآپ و برن‌داون",
  },
  {
    icon: CalendarDays,
    title: "تقویم و گانت",
    desc: "برنامهٔ زمانی با تقویم شمسی",
  },
  {
    icon: FileText,
    title: "گزارش و تأیید",
    desc: "ارسال، بررسی و پیگیری وضعیت",
  },
  {
    icon: MessageSquare,
    title: "پیام‌رسان تیمی",
    desc: "چت خصوصی و گروهی، فایل و واکنش",
  },
  {
    icon: History,
    title: "تاریخچهٔ تغییرات",
    desc: "پیگیری تغییرات ثبت‌شده با نام و زمان",
  },
];

const TRUST = [
  { icon: ShieldCheck, label: "نشست امن و امضاشده" },
  { icon: Shield, label: "ورود دومرحله‌ای اختیاری" },
  { icon: History, label: "تاریخچهٔ تغییرات مهم" },
];

/** A small, purely decorative picture of the product (no real data). */
function ProductPreview() {
  const cols = [
    {
      t: "در صف",
      cards: [
        ["w-4/5", "bg-danger"],
        ["w-3/5", "bg-warning"],
      ],
    },
    {
      t: "در حال انجام",
      cards: [
        ["w-full", "bg-accent"],
        ["w-2/3", "bg-accent"],
        ["w-4/5", "bg-warning"],
      ],
    },
    { t: "تمام‌شده", cards: [["w-3/4", "bg-success"]] },
  ] as const;
  return (
    <div
      className="login-float relative mx-auto w-full max-w-md rounded-2xl border border-border/70 bg-bg-elevated/60 p-3 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)] backdrop-blur-md"
      aria-hidden
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-danger/70" />
          <span className="size-2 rounded-full bg-warning/70" />
          <span className="size-2 rounded-full bg-success/70" />
        </div>
        <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[10px] font-medium">
          ⚡ اسپرینت ۱۲ · ۶ روز مانده
        </span>
      </div>
      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-2 mx-1">
        <div className="h-full w-[62%] rounded-full bg-accent" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {cols.map((c) => (
          <div key={c.t} className="rounded-xl bg-surface-2/70 p-2">
            <p className="mb-1.5 text-[10px] font-medium text-muted">{c.t}</p>
            <div className="space-y-1.5">
              {c.cards.map(([w, tone], i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border/60 bg-surface p-1.5"
                >
                  <div className={cn("h-1.5 rounded-full bg-fg/20", w)} />
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className={cn("h-1 w-6 rounded-full", tone)} />
                    <span className="size-3.5 rounded-full bg-accent/30" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between px-1 text-[10px] text-muted">
        <span>برن‌داون: طبق برنامه</span>
        <span className="flex -space-x-1.5 rtl:space-x-reverse">
          {["#3b82f6", "#10b981", "#f59e0b", "#a855f7"].map((c) => (
            <span
              key={c}
              className="size-4 rounded-full ring-2 ring-[var(--k-surface)]"
              style={{ background: c }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

export function LoginScreen() {
  const { login, completePinLogin } = useLocalSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [pinTicket, setPinTicket] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [remember, setRemember] = useState(true);

  // remember the last username on this device (never the password)
  useEffect(() => {
    try {
      const last = localStorage.getItem("sibamotor-last-user");
      if (last) setUsername(last);
    } catch {
      /* storage unavailable */
    }
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (pinTicket) {
        const res = await completePinLogin(pinTicket, pin);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        void navigate({ to: "/" });
        return;
      }

      const result = await login(username, password);
      if (!result.ok) {
        if (result.ticket) {
          setPinTicket(result.ticket);
          return;
        }
        setError(result.error);
        return;
      }
      try {
        if (remember)
          localStorage.setItem("sibamotor-last-user", username.trim());
        else localStorage.removeItem("sibamotor-last-user");
      } catch {
        /* ignore */
      }
      void navigate({ to: "/" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[var(--k-bg,#0b0d12)] text-fg">
      {/* Dynamic background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="k-wallpaper absolute inset-0 opacity-80" />
        <div
          className="absolute -top-32 -start-24 size-[28rem] rounded-full opacity-40 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklab, var(--color-accent) 55%, transparent), transparent 70%)",
            animation: "floatA 14s ease-in-out infinite",
          }}
        />
        <div
          className="login-background-orb absolute -bottom-40 -end-20 size-[32rem] rounded-full opacity-30 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklab, #38bdf8 40%, transparent), transparent 70%)",
            animation: "floatB 18s ease-in-out infinite",
          }}
        />
        <div
          className="login-background-orb absolute top-1/3 start-1/2 size-64 -translate-x-1/2 rounded-full opacity-20 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklab, #a78bfa 35%, transparent), transparent 70%)",
            animation: "floatC 20s ease-in-out infinite",
          }}
        />
        {/* subtle grid */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(var(--k-fg) 1px, transparent 1px), linear-gradient(90deg, var(--k-fg) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <style>{`
        @keyframes floatA {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(40px, 24px) scale(1.08); }
        }
        @keyframes floatB {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(-32px, -20px) scale(1.05); }
        }
        @keyframes floatC {
          0%, 100% { transform: translate(-50%, 0); opacity: 0.15; }
          50% { transform: translate(-50%, 16px); opacity: 0.28; }
        }
        @keyframes riseIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes loginFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
        .login-float { animation: loginFloat 7s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .login-float, .login-rise { animation: none !important; }
          .login-background-orb { animation: none !important; }
        }
        .login-rise { animation: riseIn 0.55s ease-out both; }
        .login-rise-delay-1 { animation-delay: 0.08s; }
        .login-rise-delay-2 { animation-delay: 0.16s; }
        .login-rise-delay-3 { animation-delay: 0.24s; }
      `}</style>

      <button
        type="button"
        onClick={() => setAppearanceOpen(true)}
        className="absolute end-4 top-4 z-20 inline-flex h-10 items-center gap-2 rounded-full border border-border/80 bg-bg-elevated/70 px-3 text-[13px] text-muted backdrop-blur-md transition hover:text-fg"
        aria-label="ظاهر برنامه"
      >
        <Palette className="size-4" />
        <span className="hidden sm:inline">ظاهر</span>
      </button>

      <div className="relative z-10 mx-auto grid min-h-dvh max-w-6xl items-center gap-12 px-4 py-12 lg:grid-cols-2 lg:gap-16">
        {/* Brand panel */}
        <section className="hidden lg:block">
          <div className="login-rise flex items-center gap-3">
            <LogoMark className="size-12" />
            <div>
              <p className="text-lg font-semibold leading-tight">{APP_NAME}</p>
              <p className="text-[12px] text-muted">{APP_TAGLINE}</p>
            </div>
          </div>
          <h1 className="login-rise login-rise-delay-1 mt-8 text-4xl font-semibold leading-[1.25] tracking-tight xl:text-[44px]">
            کار تیم،
            <br />
            <span className="bg-gradient-to-l from-accent to-sky-400 bg-clip-text text-transparent">
              منظم، شفاف و قابل پیگیری
            </span>
          </h1>
          <p className="login-rise login-rise-delay-1 mt-4 max-w-md text-[15px] leading-8 text-muted">
            از کانبان و اسپرینت تا تقویم، گزارش و گفت‌وگو؛ برنامه‌ریزی، پیگیری و
            تصمیم‌گیری در یک محیط یکپارچهٔ فارسی.
          </p>

          <div className="login-rise login-rise-delay-2 mt-8">
            <ProductPreview />
          </div>

          <ul className="login-rise login-rise-delay-3 mt-8 grid grid-cols-2 gap-2.5 xl:grid-cols-3">
            {FEATURES.map((h) => (
              <li
                key={h.title}
                className="group rounded-2xl border border-border/70 bg-bg-elevated/40 p-3 backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-border-strong hover:bg-bg-elevated/70"
              >
                <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent transition group-hover:scale-110">
                  <h.icon className="size-4" />
                </span>
                <p className="mt-2 text-[13px] font-medium">{h.title}</p>
                <p className="mt-0.5 text-[11px] leading-5 text-muted">
                  {h.desc}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Form card */}
        <section className="login-rise login-rise-delay-3 mx-auto w-full max-w-[420px]">
          <div className="rounded-3xl border border-border/80 bg-bg-elevated/80 p-6 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:p-8">
            <div className="mb-6 flex items-center gap-3 lg:hidden">
              <LogoMark className="size-10" />
              <div>
                <h1 className="font-semibold">{APP_NAME}</h1>
                <p className="text-[12px] text-muted">{APP_TAGLINE}</p>
              </div>
            </div>

            <div className="mb-6">
              <h2 className="text-lg font-semibold tracking-tight">
                {pinTicket ? "تأیید هویت دومرحله‌ای" : "ورود به حساب"}
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                {pinTicket
                  ? "پین امنیتی ۴ تا ۸ رقمی حساب خود را وارد کنید."
                  : "نام کاربری و رمز حساب سازمانی‌تان را وارد کنید. اگر رمز موقت دارید، پس از ورود آن را تغییر دهید."}
              </p>
            </div>

            <form className="space-y-3.5" onSubmit={onSubmit}>
              <div>
                <Label htmlFor="username">نام کاربری</Label>
                <div className="relative mt-1.5">
                  <User className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                  <Input
                    id="username"
                    autoComplete="username"
                    required
                    className="h-11 ps-10"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    dir="ltr"
                    disabled={Boolean(pinTicket)}
                    placeholder="username"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="password">رمز عبور</Label>
                <div className="relative mt-1.5" dir="ltr">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                  <Input
                    id="password"
                    type={showPass ? "text" : "password"}
                    autoComplete="current-password"
                    required={!pinTicket}
                    className="h-11 px-10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyUp={(e) => setCapsOn(e.getModifierState("CapsLock"))}
                    onBlur={() => setCapsOn(false)}
                    dir="ltr"
                    disabled={Boolean(pinTicket)}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-subtle hover:text-fg"
                    onClick={() => setShowPass((v) => !v)}
                    aria-label={showPass ? "مخفی کردن رمز" : "نمایش رمز"}
                  >
                    {showPass ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
              </div>

              {capsOn && !pinTicket && (
                <p className="text-[12px] text-warning">
                  ⚠️ Caps Lock روشن است.
                </p>
              )}
              {!pinTicket && (
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="size-4 accent-[var(--k-accent)]"
                  />
                  نام کاربری در این دستگاه یادم بماند
                </label>
              )}

              {pinTicket && (
                <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-3">
                  <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
                    <Shield className="size-3.5 text-accent" />
                    پین امنیتی فعال است
                  </div>
                  <Label htmlFor="pin">پین (۴ تا ۸ رقم)</Label>
                  <Input
                    id="pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    className="mt-1.5 h-11 tracking-[0.3em]"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    dir="ltr"
                    placeholder="••••"
                    autoFocus
                  />
                </div>
              )}

              {error && (
                <p
                  className={cn(
                    "rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger",
                  )}
                  role="alert"
                >
                  {error}
                </p>
              )}

              <Button
                type="submit"
                className="h-11 w-full text-[14px]"
                disabled={busy}
              >
                {busy
                  ? "در حال بررسی…"
                  : pinTicket
                    ? "تأیید و ورود"
                    : "ورود به سامانه"}
              </Button>

              {pinTicket && (
                <button
                  type="button"
                  className="w-full text-center text-[12px] text-muted transition hover:text-fg"
                  onClick={() => {
                    setPinTicket(null);
                    setPin("");
                    setError(null);
                  }}
                >
                  بازگشت به ورود
                </button>
              )}
            </form>

            <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-border/70 pt-4">
              {TRUST.map((t) => (
                <li
                  key={t.label}
                  className="flex items-center gap-1.5 text-[11px] text-muted"
                >
                  <t.icon className="size-3.5 text-accent" />
                  {t.label}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-center text-[11px] leading-relaxed text-subtle">
              {APP_CREDIT}
            </p>
          </div>

          <p className="mt-5 text-center text-[11px] text-subtle/80">
            رمز عبور را فراموش کرده‌اید؟ از ادمین بخواهید رمز جدید برایتان
            بسازد.
          </p>
        </section>
      </div>

      <AppearancePanel open={appearanceOpen} onOpenChange={setAppearanceOpen} />
    </div>
  );
}
