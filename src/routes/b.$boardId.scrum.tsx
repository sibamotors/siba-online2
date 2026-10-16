import { createFileRoute } from "@tanstack/react-router";
import { ScrumView } from "@/components/scrum-view";
import { useBoardCtx } from "@/lib/board-context";

export const Route = createFileRoute("/b/$boardId/scrum")({ component: ScrumPage });

function ScrumPage() {
  const { board, setOpenCardId } = useBoardCtx();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrumView board={board} onOpenCard={(id) => setOpenCardId(id)} />
    </div>
  );
}
