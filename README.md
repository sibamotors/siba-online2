# سیبا موتور — مدیریت کار تیمی

برنامهٔ وب مدیریت پروژه و کار تیمی (کانبان، اسکرام، تقویم، گانت، گزارش و دسترسی‌ها) با **TanStack Start + React + PostgreSQL**.

## استقرار
- **نسخهٔ توصیه‌شدهٔ Node.js:** 22.12 یا جدیدتر از شاخهٔ 22 (به‌خاطر سازگاری Start/runtime).
- **VPS با PM2 و Nginx:** راهنمای قدم‌به‌قدم [`docs/VPS-PM2-FA.md`](docs/VPS-PM2-FA.md)
- **Render:** [`docs/DEPLOY-FA.md`](docs/DEPLOY-FA.md)
- **گزارش ممیزی و یافته‌ها:** [`docs/AUDIT-FA.md`](docs/AUDIT-FA.md)

| تنظیم | مقدار |
|---|---|
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` (ابتدا migration دیتابیس، بعد سرور) |
| Health Check Path | `/login` |

### متغیرهای محیطی (Render یا فایل `.env` روی VPS)
| نام | توضیح |
|---|---|
| `DATABASE_URL` | آدرس Postgres (الزامی) |
| `SESSION_SECRET` | حداقل ۳۲ کاراکتر تصادفی؛ برای امضای کوکی ورود (الزامی) |
| `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` | ساخت اولین ادمین (فقط وقتی ادمین فعالی وجود ندارد) |

نمونه: `.env.example`

## امنیت (خلاصه)
- نشست سمت سرور با کوکی `HttpOnly` امضاشده؛ هویت کاربر هرگز از ورودی مرورگر خوانده نمی‌شود.
- همه‌ی توابع سرور با middleware احراز هویت/ادمین/دسترسی محافظت می‌شوند.
- رمزها با scrypt هش می‌شوند؛ ۵ تلاش ناموفق = قفل ۱۵ دقیقه‌ای.
- فایل‌ها فقط برای فرستنده/گیرنده‌ی همان پیام قابل دانلود هستند و فقط نوع‌های امن با MIME واقعی ارائه می‌شوند.
- هدرهای امنیتی (CSP، HSTS، …) روی همه‌ی پاسخ‌ها.

## توسعه‌ی محلی
```bash
npm ci
cp .env.example .env      # DATABASE_URL و SESSION_SECRET را پر کنید
npm run dev               # http://localhost:8080
npm run typecheck && npm run lint && npm test
```
بدون `DATABASE_URL` در حالت توسعه یک دیتابیس محلی (PGlite) ساخته می‌شود.

## نکات
- فعلاً فقط **یک** نمونه (instance) از برنامه اجرا شود؛ قفل نوشتن workspace داخل همان پروسه است. در PM2 از حالت `fork` و `instances: 1` استفاده کنید، نه `cluster`.
- مهاجرت‌ها در پوشه‌ی `migrations/` هستند و در هر استارت به‌صورت خودکار اجرا می‌شوند.

---
ساختهٔ **علی عباسی** (Ali Abbasi).
