# راهنمای استقرار و به‌روزرسانی سیباموتور روی VPS با PM2 و Nginx

این راهنما برای همین مخزن نوشته شده است. برنامه به PostgreSQL واقعی نیاز دارد؛ دیتابیس PGlite فقط برای توسعه/پیش‌نمایش است. همچنین برنامه باید فعلاً با **یک process** اجرا شود، چون قفل نوشتن فضای کاری در حافظهٔ همان process است.

## ۱) پیش از به‌روزرسانی: پشتیبان

1. از داخل برنامه، با حساب ادمین، خروجی پشتیبان فضای کاری را بگیر و خارج از VPS نگه دار.
2. بکاپ PostgreSQL بساز و مطمئن شو می‌توانی آن را بازیابی کنی. فایل‌های متنی و خروجی JSON برنامه جای بکاپ دیتابیس را نمی‌گیرند.
3. مسیر استقرار فعلی و نام process در PM2 را یادداشت کن:

```bash
pm2 status
pm2 describe sibamotor
```

**مهم:** migrationهای SQL در این پروژه به‌صورت خودکار اجرا می‌شوند، اما rollback خودکار دیتابیس ندارند. پیش از نسخهٔ جدید بکاپ بگیر.

## ۲) پیش‌نیازها

- Ubuntu/Debian به‌روز (نمونهٔ دستورات در این راهنما برای همین خانواده است)
- Node.js نسخهٔ 22.12 یا جدیدتر از شاخهٔ 22، به‌همراه npm
- PostgreSQL قابل‌دسترسی با آدرس `DATABASE_URL`
- PM2 و Nginx
- دامنه‌ای که DNS آن به VPS اشاره می‌کند و گواهی HTTPS معتبر

نصب ابزارهای سیستم را با کاربر دارای sudo انجام بده. برنامه را با کاربر root اجرا نکن. ساخت کاربر، نصب Node و پیکربندی PostgreSQL را مطابق روش مدیریت سرور خود انجام بده.

```bash
node --version
npm --version
npm install --global pm2
sudo apt update
sudo apt install -y nginx
```

## ۳) فایل پروژه را روی سرور بگذار

یک مسیر ثابت انتخاب کن؛ در ادامه از `/var/www/sibamotor` استفاده شده است. مسیر باید متعلق به کاربر اجراکنندهٔ برنامه باشد:

```bash
sudo mkdir -p /var/www/sibamotor
sudo chown -R "$USER":"$USER" /var/www/sibamotor
```

محتویات پوشهٔ `sibamotor-main` را در همین مسیر قرار بده؛ خود پوشهٔ تو در تو نباشد. در ریشه باید `package.json`، `src/`، `scripts/`، `migrations/`، `server/` و `ecosystem.config.cjs` دیده شود.

```bash
cd /var/www/sibamotor
ls -la
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

اگر هر کدام از تست‌ها شکست خورد، قبل از تعویض نسخهٔ در حال اجرا علت را برطرف کن. `npm run build` باید پوشهٔ `.output/` بسازد.

## ۴) متغیرهای محیطی

فایل نمونه را کپی کن و مقادیر واقعی را در آن بگذار:

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

حداقل این‌ها باید درست باشند:

```dotenv
NODE_ENV=production
DATABASE_URL=postgres://USER:PASSWORD@DB_HOST:5432/DB_NAME
SESSION_SECRET=یک-رشته-تصادفی-طولانی-و-منحصربه-فرد
ADMIN_BOOTSTRAP_USERNAME=نام-ادمین
ADMIN_BOOTSTRAP_PASSWORD=رمز-موقت-منحصربه-فرد-حداقل-۱۰-کاراکتری
```

برای ساخت secret با Node:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

نکته‌ها:

- `DATABASE_URL` را از ارائه‌دهندهٔ دیتابیس بگیر؛ آن را در Git، پیام‌رسان یا اسکرین‌شات منتشر نکن.
- از TLS دیتابیس با اعتبارسنجی گواهی استفاده کن. `DATABASE_SSL=disable` را فقط برای اتصال خصوصی و قابل‌اعتماد در همان میزبان/شبکه به کار ببر.
- `SESSION_SECRET` باید حداقل ۳۲ کاراکتر و پس از استقرار ثابت بماند؛ عوض‌کردن آن همهٔ نشست‌های فعلی را نامعتبر می‌کند.
- بعد از اینکه ادمین با موفقیت وارد شد و رمز خودش را تغییر داد، `ADMIN_BOOTSTRAP_PASSWORD` را از `.env` حذف کن. `ADMIN_BOOTSTRAP_FORCE=1` را فقط برای بازیابی کنترل‌شدهٔ حساب استفاده کن و بلافاصله حذفش کن.
- پس از ذخیره، بررسی کن فایل `.env` قابل‌خواندن برای سایر کاربران سرور نباشد: `stat -c '%a %U %n' .env` باید مجوز `600` را نشان دهد.

## ۵) اجرای آزمایشی با Start Script

اسکریپت `scripts/start.mjs` فایل `.env` را با parser داخلی Node بارگذاری می‌کند، سپس migrationهای PostgreSQL را اجرا می‌کند و فقط در صورت موفقیت، سرور Nitro را بالا می‌آورد.

```bash
npm start
```

در خروجی باید migrationها «applied» یا «up to date» شوند و بعد سرور بالا بیاید. با `Ctrl+C` از اجرای آزمایشی خارج شو. اگر خطای اتصال/مجوز دیتابیس دیدی، پیش از شروع PM2 حلش کن.

## ۶) راه‌اندازی زیر PM2

این مخزن `ecosystem.config.cjs` دارد؛ تنظیم آن روی `fork` با `instances: 1` است و سرور را روی `127.0.0.1:3000` قرار می‌دهد تا از اینترنت مستقیماً در دسترس نباشد.

```bash
cd /var/www/sibamotor
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs sibamotor --lines 100
curl -I http://127.0.0.1:3000/login
```

پاسخ HTTP از `/login` باید دریافت شود. سپس اجرای خودکار بعد از reboot را فعال کن:

```bash
pm2 startup
```

PM2 یک دستور `sudo ...` در خروجی چاپ می‌کند؛ **همان دستور واقعی‌ای را که روی سرور نشان می‌دهد** اجرا کن. سپس:

```bash
pm2 save
```

بعد از reboot سرور، `pm2 status` و `curl` را دوباره تست کن.

## ۷) Nginx و HTTPS

فایل نمونهٔ زیر را در `/etc/nginx/sites-available/sibamotor` بساز و `app.example.com` را با دامنهٔ واقعی جایگزین کن:

```nginx
server {
    listen 80;
    server_name app.example.com;
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
```

فعال‌سازی و تست پیکربندی:

```bash
sudo ln -s /etc/nginx/sites-available/sibamotor /etc/nginx/sites-enabled/sibamotor
sudo nginx -t
sudo systemctl reload nginx
```

پس از آن برای دامنه گواهی HTTPS از Certbot/Let's Encrypt یا سامانهٔ گواهی مورداعتماد خودت تهیه کن و ریدایرکت HTTP به HTTPS را فعال کن. در فایروال فقط پورت‌های ضروری (معمولاً 22 با محدودیت IP، 80 و 443) را باز بگذار؛ پورت 3000 و پورت PostgreSQL نباید عمومی باشند. اگر `includeSubDomains` در HSTS فعال است، تمام زیردامنه‌های همان دامنه باید HTTPS داشته باشند.

## ۸) فرآیند امن به‌روزرسانی

برای به‌روزرسانی، نسخهٔ در حال اجرا را درجا overwrite نکن. نسخهٔ جدید را در پوشهٔ release جداگانه بساز و تست کن؛ تا وقتی تست/build موفق نشده، process فعلی و فایل‌های build فعلی را دست نزن. در این روش تعویض نهایی process چند لحظه downtime دارد، اما build ناموفق نسخهٔ فعلی را خراب نمی‌کند.

### ۸.۱) بکاپ و شناسایی process فعلی

ZIP جدید را از رایانه به `/tmp/sibamotor-audited.zip` روی VPS آپلود کن. سپس نام و دستور اجرای واقعی سرویس را ببین؛ ممکن است اسم process با `sibamotor` فرق کند:

```bash
pm2 status
pm2 describe نام-واقعی-process
```

از دیتابیس و فضای کاری بکاپ بگیر. برای بکاپ اضطراری فایل کد و build جاری را هم نگه دار؛ عمداً `.output` از این بکاپ حذف نشده است:

```bash
sudo mkdir -p /var/backups/sibamotor
sudo tar -czf "/var/backups/sibamotor/code-$(date +%Y%m%d-%H%M%S).tar.gz" \
  --exclude=node_modules --exclude=logs --exclude=.env \
  -C /var/www sibamotor
```

اگر مسیر برنامه‌ات `/var/www/sibamotor` نیست، مسیر واقعی را در فرمان بالا جایگزین کن. فرمان `pm2 describe` و دستور قدیمی شروع برنامه را برای rollback یادداشت کن.

### ۸.۲) ساخت release جدید بدون دست‌زدن به نسخهٔ فعال

```bash
mkdir -p /tmp/sibamotor-release /var/www/releases
unzip -q /tmp/sibamotor-audited.zip -d /tmp/sibamotor-release
ls -la /tmp/sibamotor-release/sibamotor-main

RELEASE_DIR="/var/www/releases/sibamotor-$(date +%Y%m%d-%H%M%S)"
cp -a /tmp/sibamotor-release/sibamotor-main "$RELEASE_DIR"
```

فایل محیط واقعی را از مسیر فعلی برنامه به release جدید کپی کن (در صورت متفاوت بودن مسیر، آن را اصلاح کن):

```bash
cp /var/www/sibamotor/.env "$RELEASE_DIR/.env"
chmod 600 "$RELEASE_DIR/.env"
mkdir -p "$RELEASE_DIR/logs"
cd "$RELEASE_DIR"
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

اگر هر فرمانی شکست خورد، **نسخهٔ فعلی را متوقف نکن**. release ناموفق را بررسی یا حذف کن و علت خطا را حل کن. مهاجرت دیتابیس در این مرحله عمداً به‌صورت دستی اجرا نمی‌شود؛ آن را start script انجام می‌دهد، پس در لحظهٔ تعویض process بکاپ دیتابیس باید حاضر باشد.

### ۸.۳) تعویض process

نام process قدیمی را از `pm2 status` بردار و در متغیر زیر بگذار. این فرمان را با اسم فرضی اجرا نکن. اجرای `stop/delete` برای process قدیمی و سپس start نسخهٔ جدید باعث downtime کوتاه می‌شود؛ تعویض آدرس Nginx برای blue/green در این نسخه پیکربندی نشده است.

بلوک زیر را پس از جایگزین‌کردن نام واقعی process اجرا کن:

```bash
OLD_PM2_NAME="نام-واقعی-process"
pm2 stop "$OLD_PM2_NAME"
pm2 delete "$OLD_PM2_NAME"
pm2 start "$RELEASE_DIR/ecosystem.config.cjs"
```

پس از start، وضعیت و لاگ‌ها را بررسی کن:

```bash
pm2 status
pm2 logs sibamotor --lines 100
curl -fsS http://127.0.0.1:3000/login >/dev/null && echo OK
pm2 save
```

در نسخهٔ release جدید، PM2 اسم process را `sibamotor` می‌گذارد. اگر سرور بالا نیامد، تا وقتی علت روشن نشده releaseهای قبلی را حذف نکن. برای rollback process جدید را stop/delete کن و نسخهٔ قبلی را با همان دستور واقعی‌ای که پیش از deploy ثبت کرده‌ای راه بینداز. اگر migration روی دیتابیس با موفقیت اجرا شده، اجرای مجدد کد قدیمی ممکن است بدون بازگرداندن backup سازگار نباشد؛ بازگرداندن backup دیتابیس، تغییرات کاربران بعد از آن زمان را از بین می‌برد.

### ۸.۴) پس از تأیید نسخهٔ جدید

در برنامه ورود و خروج، تغییر رمز اجباری، ساخت و جابه‌جایی کارت، پیام و پیوست، گزارش، مجوزهای کاربر غیرادمین و نمودار اسکرام را تست کن. پس از چند روز پایداری، می‌توانی releaseهای قدیمی را با حفظ یک نسخهٔ rollback حذف کنی. پوشهٔ موقت را پاک کن:

```bash
rm -rf /tmp/sibamotor-release /tmp/sibamotor-audited.zip
```

## ۹) عیب‌یابی رایج

| نشانه | بررسی |
|---|---|
| `DATABASE_URL is not set` | `.env`، مجوز فایل و آدرس PostgreSQL را بررسی کن؛ در production نباید PGlite جایگزین شود. |
| خطای TLS/گواهی دیتابیس | گواهی/نام میزبان و `sslmode` URL را بررسی کن؛ برای دور زدن خطا اعتبارسنجی TLS را بی‌دلیل خاموش نکن. |
| صفحه 502 در Nginx | `pm2 status`، لاگ PM2 و `curl http://127.0.0.1:3000/login` را بررسی کن. |
| PM2 بعد از reboot برنامه را بالا نمی‌آورد | دوباره `pm2 startup` را اجرا کن، دستور چاپ‌شده را اجرا و سپس `pm2 save` بزن. |
| خطای CSP یا صفحهٔ سفید | F12 → Console را بررسی و policy را بر اساس منبع واقعی اصلاح کن. CSP را در production خاموش رها نکن. |
| ورود ادمین انجام نمی‌شود | لاگ `[bootstrap]` و `SESSION_SECRET` را بررسی کن. برای بازنشانی فقط در صورت ضرورت `ADMIN_BOOTSTRAP_FORCE=1` را موقتاً فعال و پس از ورود حذف کن. |

## ۱۰) عملیات دوره‌ای

- هر روز/هفته بر اساس اهمیت داده، بکاپ دیتابیس بگیر و بازیابی بکاپ را دوره‌ای تمرین کن.
- فضای دیسک، RAM، `pm2 status`، خطاهای Nginx و لاگ‌های برنامه را پایش کن.
- وابستگی‌ها را با تغییر نسخهٔ کنترل‌شده و پس از گذراندن تست/build به‌روز کن؛ به‌روزرسانی خودکار نسخهٔ اصلی runtime را بدون تست وارد production نکن.
- چون فضای کاری با قفل درون‌فرایندی ذخیره می‌شود، برای بیش از یک instance یا چند سرور ابتدا معماری persistence/locking را به دیتابیس و قفل توزیع‌شده منتقل کن.
