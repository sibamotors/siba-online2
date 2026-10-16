import { createFileRoute } from "@tanstack/react-router";
import { ActivityView } from "@/components/activity-view";
import { WorkspaceLayout } from "@/components/workspace-layout";

type Search = { card?: string; board?: string };

export const Route = createFileRoute("/activity")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    card: typeof s.card === "string" ? s.card : undefined,
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  component: ActivityPage,
});

function ActivityPage() {
  const { card, board } = Route.useSearch();
  return (
    <WorkspaceLayout>
      {/* key: opening the page again with another ?card= resets the filters */}
      <ActivityView key={`${card ?? ""}|${board ?? ""}`} initialCardId={card} initialBoardId={board} />
    </WorkspaceLayout>
  );
}
