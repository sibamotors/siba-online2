import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, KeyRound, Trash2, ZoomIn } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { useLocalSession } from "@/lib/local-session";
import { removeMyAvatar, setMyAvatar } from "@/lib/profile";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { UserAvatar } from "./user-avatar";

/** Size of the saved picture (square). 256px keeps it sharp on retina and tiny in the database. */
const OUT = 256;
/** Size of the preview shown on screen (CSS px). */
const VIEW = 224;
const MAX_PICK_BYTES = 15 * 1024 * 1024;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChangePassword?: () => void;
};

type Pending = { img: HTMLImageElement; url: string };

export function ProfileDialog({ open, onOpenChange, onChangePassword }: Props) {
  const { user, updateUser } = useLocalSession();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // forget the half-finished edit whenever the dialog closes
  useEffect(() => {
    if (open) return;
    setPending((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
    setZoom(1);
    setOff({ x: 0, y: 0 });
  }, [open]);

  /** Where the (cover-scaled, zoomed, dragged) image lands on a canvas of `size` px. */
  function layout(img: HTMLImageElement, size: number, z: number, o: { x: number; y: number }, scaleOff: number) {
    const base = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    const s = base * z;
    const dw = img.naturalWidth * s;
    const dh = img.naturalHeight * s;
    const maxX = Math.max(0, (dw - size) / 2);
    const maxY = Math.max(0, (dh - size) / 2);
    const ox = Math.max(-maxX, Math.min(maxX, o.x * scaleOff));
    const oy = Math.max(-maxY, Math.min(maxY, o.y * scaleOff));
    return { x: size / 2 - dw / 2 + ox, y: size / 2 - dh / 2 + oy, w: dw, h: dh };
  }

  function draw(canvas: HTMLCanvasElement, img: HTMLImageElement, size: number, scaleOff: number) {
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = "high";
    const r = layout(img, size, zoom, off, scaleOff);
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
  }

  useEffect(() => {
    if (!pending || !canvasRef.current) return;
    draw(canvasRef.current, pending.img, VIEW, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, zoom, off]);

  function pick(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|gif|bmp)$/.test(file.type)) {
      toast.error("فقط فایل تصویر (JPG، PNG یا WebP) انتخاب کنید.");
      return;
    }
    if (file.size > MAX_PICK_BYTES) {
      toast.error("حجم تصویر بیش از ۱۵ مگابایت است.");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setPending((p) => {
        if (p) URL.revokeObjectURL(p.url);
        return { img, url };
      });
      setZoom(1);
      setOff({ x: 0, y: 0 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast.error("این تصویر خوانده نشد.");
    };
    img.src = url;
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!pending) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
  }
  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (!d || !pending) return;
    const next = { x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) };
    const r = layout(pending.img, VIEW, zoom, next, 1);
    // store the clamped value so the image never "sticks" outside the frame
    const base = layout(pending.img, VIEW, zoom, { x: 0, y: 0 }, 1);
    setOff({ x: r.x - base.x, y: r.y - base.y });
  }
  function onPointerUp() {
    drag.current = null;
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!pending) throw new Error("تصویری انتخاب نشده است.");
      const canvas = document.createElement("canvas");
      // the preview offset is in preview pixels → scale it to the output size
      draw(canvas, pending.img, OUT, OUT / VIEW);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.88));
      if (!blob) throw new Error("ساخت تصویر ناموفق بود.");
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          const s = String(r.result ?? "");
          resolve(s.slice(s.indexOf(",") + 1));
        };
        r.onerror = () => reject(new Error("خواندن تصویر ناموفق بود."));
        r.readAsDataURL(blob);
      });
      const res = await setMyAvatar({ data: { dataBase64: b64, mime: "image/jpeg" } });
      if (!res.ok) throw new Error(res.error);
    },
    onSuccess: async () => {
      toast.success("عکس پروفایل ذخیره شد");
      await qc.invalidateQueries({ queryKey: ["local-users"] });
      updateUser({ avatarVersion: Date.now() });
      setPending(null);
    },
    onError: (e: Error) => toast.error(e.message || "ذخیره عکس ناموفق بود."),
  });

  const removeMut = useMutation({
    mutationFn: () => removeMyAvatar(),
    onSuccess: async () => {
      toast.success("عکس پروفایل حذف شد");
      await qc.invalidateQueries({ queryKey: ["local-users"] });
      updateUser({ avatarVersion: null });
    },
    onError: () => toast.error("حذف عکس ناموفق بود."),
  });

  if (!user) return null;
  const busy = saveMut.isPending || removeMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogTitle>پروفایل من</DialogTitle>
        <DialogDescription>عکس پروفایل شما در پیام‌ها، گزارش‌ها و کارت‌ها برای همکاران دیده می‌شود.</DialogDescription>

        <div className="mt-4 flex flex-col items-center gap-3">
          {pending ? (
            <>
              <div className="overflow-hidden rounded-full ring-2 ring-accent" style={{ width: VIEW, height: VIEW }}>
                <canvas
                  ref={canvasRef}
                  style={{ width: VIEW, height: VIEW, touchAction: "none", cursor: "grab" }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  aria-label="پیش‌نمایش عکس؛ برای جابه‌جایی بکشید"
                />
              </div>
              <p className="text-[11px] text-subtle">برای تنظیم قاب، تصویر را بکشید یا بزرگ‌نمایی کنید.</p>
              <label className="flex w-full items-center gap-2 text-[12px] text-muted">
                <ZoomIn className="size-4 shrink-0" />
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="w-full accent-[var(--k-accent)]"
                  aria-label="بزرگ‌نمایی"
                />
              </label>
              <div className="flex w-full gap-2">
                <Button className="flex-1" disabled={busy} onClick={() => saveMut.mutate()}>
                  {saveMut.isPending ? "در حال ذخیره…" : "ذخیره عکس"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    URL.revokeObjectURL(pending.url);
                    setPending(null);
                  }}
                >
                  انصراف
                </Button>
              </div>
            </>
          ) : (
            <>
              <UserAvatar username={user.username} name={user.displayName} size="xl" />
              <div className="text-center">
                <p className="text-sm font-semibold">{user.displayName}</p>
                <p className="text-[12px] text-muted" dir="ltr">
                  {user.username}
                </p>
                {user.role && <p className="text-[12px] text-subtle">{user.role}</p>}
              </div>
              <div className="flex w-full flex-wrap justify-center gap-2">
                <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                  <Camera className="size-4" />
                  {user.avatarVersion ? "تغییر عکس" : "انتخاب عکس"}
                </Button>
                {user.avatarVersion ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-danger"
                    disabled={busy}
                    onClick={() => removeMut.mutate()}
                  >
                    <Trash2 className="size-4" />
                    حذف عکس
                  </Button>
                ) : null}
              </div>
              {onChangePassword && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onOpenChange(false);
                    onChangePassword();
                  }}
                >
                  <KeyRound className="size-4" />
                  تغییر رمز عبور
                </Button>
              )}
            </>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
