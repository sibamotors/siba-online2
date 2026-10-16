import { getAppFile } from "./files";

/** Fetches a stored file from the server and saves it through the browser's download. Returns an error text or null. */
export async function downloadAppFile(fileId: string, fallbackName = "file"): Promise<string | null> {
  try {
    const res = await getAppFile({ data: { id: fileId } });
    if (!res.ok) return res.error;
    const bin = atob(res.dataBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = res.filename || fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return null;
  } catch {
    return "دانلود فایل ناموفق بود.";
  }
}
