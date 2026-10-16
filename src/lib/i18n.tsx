import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const translations = {
  fa: {
    // صفحه ورود
    login_title: "ورود به فضای کاری",
    login_subtitle: "برای دسترسی به بوردها و میز کار خود، اطلاعات کاربری را وارد کنید.",
    username: "نام کاربری",
    password: "رمز عبور",
    remember_me: "خاطر داشتن نام کاربری در این دستگاه",
    login_btn: "ورود به فضای کاری",
    security_badge: "نشست رمزنگاری‌شده و امن",
    pin_badge: "تأیید هویت دومرحله‌ای (PIN)",
    audit_badge: "پایش و ثبت کامل رخدادها",
    // منوی اصلی
    board: "تخته",
    gantt: "گانت",
    calendar: "تقویم",
    scrum: "اسکرام",
    dashboard: "داشبورد",
    report: "گزارش",
    my_tasks: "کارهای من",
    messages: "پیام‌ها",
    people: "افراد",
    activity: "لاگ",
    admin_users: "کاربران",
    // هدر و ابزارها
    search_placeholder: "جستجوی کارت…",
    appearance: "شخصی‌سازی ظاهر",
    account_menu: "منوی حساب کاربری",
    profile_avatar: "پروفایل و عکس",
    change_password: "تغییر رمز عبور",
    backup_json: "پشتیبان‌گیری (خروجی فایل)",
    restore_backup: "بازیابی از فایل پشتیبان",
    sign_out: "خروج",
    signing_out: "در حال خروج…",
    // راهنما
    help_title: "راهنمای سیباموتور",
    help_subtitle: "همه‌چیز برای شروع، حتی اگر قبلاً با کانبان و اسکرام کار نکرده‌اید.",
    quick_start: "شروع سریع",
    board_cards: "تخته و کارت",
    scrum_guide: "راهنمای اسکرام",
    calendar_gantt: "تقویم و گانت",
    chat_guide: "پیام‌ها و گفتگوها",
    reports_guide: "گزارش‌های رسمی",
    dash_guide: "داشبورد و کارهای من",
    log_guide: "لاگ فعالیت‌ها",
    security_guide: "حساب کاربری و امنیت",
    shortcuts_guide: "میان‌برها و نکات طلایی",
  },
  en: {
    // Login Screen
    login_title: "Workspace Login",
    login_subtitle: "Enter your credentials to access your boards and workspace.",
    username: "Username",
    password: "Password",
    remember_me: "Remember username on this device",
    login_btn: "Sign In to Workspace",
    security_badge: "Encrypted & Secure Session",
    pin_badge: "Two-Factor Auth (PIN)",
    audit_badge: "Full Audit & Event Logging",
    // Main Nav
    board: "Board",
    gantt: "Gantt",
    calendar: "Calendar",
    scrum: "Scrum",
    dashboard: "Dashboard",
    report: "Report",
    my_tasks: "My Tasks",
    messages: "Messages",
    people: "People",
    activity: "Activity",
    admin_users: "Users",
    // Header & Tools
    search_placeholder: "Search cards...",
    appearance: "Appearance",
    account_menu: "Account Menu",
    profile_avatar: "Profile & Avatar",
    change_password: "Change Password",
    backup_json: "Backup (Export JSON)",
    restore_backup: "Restore from Backup",
    sign_out: "Sign Out",
    signing_out: "Signing out...",
    // Help
    help_title: "SibaMotor Guide",
    help_subtitle: "Everything you need to get started, even if you are new to Kanban and Scrum.",
    quick_start: "Quick Start",
    board_cards: "Board & Cards",
    scrum_guide: "Scrum Guide",
    calendar_gantt: "Calendar & Gantt",
    chat_guide: "Messages & Chats",
    reports_guide: "Official Reports",
    dash_guide: "Dashboard & My Tasks",
    log_guide: "Activity Logs",
    security_guide: "Account & Security",
    shortcuts_guide: "Shortcuts & Tips",
  },
};

type LangContextType = {
  lang: "fa" | "en";
  setLang: (l: "fa" | "en") => void;
  t: (key: keyof typeof translations["fa"]) => string;
};

const LanguageContext = createContext<LangContextType>({
  lang: "fa",
  setLang: () => {},
  t: (k) => translations.fa[k] || k,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<"fa" | "en">("fa");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("sibamotor-lang") as "fa" | "en";
      if (saved === "en" || saved === "fa") {
        setLangState(saved);
        document.documentElement.setAttribute("lang", saved);
        document.documentElement.setAttribute("dir", saved === "fa" ? "rtl" : "ltr");
      }
    } catch {
      // ignore
    }
  }, []);

  const setLang = (l: "fa" | "en") => {
    setLangState(l);
    try {
      localStorage.setItem("sibamotor-lang", l);
      document.documentElement.setAttribute("lang", l);
      document.documentElement.setAttribute("dir", l === "fa" ? "rtl" : "ltr");
    } catch {
      // ignore
    }
  };

  const t = (key: keyof typeof translations["fa"]) => {
    return translations[lang]?.[key] || translations.fa[key] || key;
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useTranslation() {
  return useContext(LanguageContext);
}
