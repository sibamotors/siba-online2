/** Lets any screen (e.g. the Ctrl+K palette) ask the board page to open a card, even right after navigating to it. */
let pending: string | null = null;
const EVENT = "sibamotor:open-card";

export function requestOpenCard(cardId: string): void {
  pending = cardId;
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: cardId }));
  } catch {
    /* no window (SSR) */
  }
}

/** The board page calls this when it mounts or the board changes. */
export function takePendingCard(): string | null {
  const id = pending;
  pending = null;
  return id;
}

export function onOpenCardRequest(
  handler: (cardId: string) => void,
): () => void {
  const fn = (e: Event) => {
    const id = (e as CustomEvent<string>).detail;
    if (typeof id === "string") {
      pending = null;
      handler(id);
    }
  };
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
