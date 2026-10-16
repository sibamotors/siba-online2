import { createFileRoute } from "@tanstack/react-router";
import { CalendarView } from "@/components/calendar-view";
import { useBoardCtx } from "@/lib/board-context";

export const Route = createFileRoute("/b/$boardId/calendar")({
  component: CalendarPage,
});

function CalendarPage() {
  const { board, setOpenCardId } = useBoardCtx();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CalendarView board={board} onOpenCard={(id) => setOpenCardId(id)} />
    </div>
  );
}
