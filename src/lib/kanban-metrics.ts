import type { Card, List } from "./types";

export type OpenAgeRow = {
  listId: string;
  listTitle: string;
  count: number;
  averageAgeDays: number | null;
  medianAgeDays: number | null;
  oldestAgeDays: number | null;
  oldestCardId: string | null;
  oldestCardTitle: string | null;
};

export type KanbanFlowMetrics = {
  doneListId: string | undefined;
  completedCount: number;
  openCount: number;
  createToDoneSampleSize: number;
  medianCreateToDoneDays: number | null;
  averageCreateToDoneDays: number | null;
  averageOpenAgeDays: number | null;
  completedLast7Days: number;
  completedLast30Days: number;
  openAgeRows: OpenAgeRow[];
};

/** Parse only the calendar-date part so Jalali-facing UI remains timezone-stable. */
function dateOrdinal(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ordinal = Date.UTC(year, month - 1, day);
  const parsed = new Date(ordinal);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(ordinal / 86_400_000);
}

export function calendarDaysBetween(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  const start = dateOrdinal(from);
  const end = dateOrdinal(to);
  if (start === null || end === null || end < start) return null;
  return end - start;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle]!;
  return Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

/**
 * Flow metrics based on the board's final column as its Done state.
 * Creation-to-completion is createdAt → enteredListAt for cards currently in Done.
 * It is only a standard Lead Time measure if card creation represents this team's
 * commitment point; backlog waiting is included. It is NOT Cycle Time (which starts
 * when active work begins); the model does not persist a reliable first-start timestamp.
 * Open age is time since a non-Done card entered
 * its current column. Legacy data may have only date precision, so results are
 * calendar days, not elapsed 24-hour periods. Completion throughput only counts
 * cards currently in the final column; reopened work is not a historical transition log.
 */
export function calculateKanbanFlowMetrics(
  cards: readonly Card[],
  lists: readonly Pick<List, "id" | "title">[],
  asOf: string,
): KanbanFlowMetrics {
  const doneListId = lists.at(-1)?.id;
  const activeCards = cards.filter((card) => !card.archived);
  const isDone = (card: Card) => doneListId !== undefined && card.listId === doneListId;
  const completed = activeCards.filter(isDone);
  const open = activeCards.filter((card) => !isDone(card));

  const createToDoneTimes = completed
    .map((card) => calendarDaysBetween(card.createdAt, card.enteredListAt))
    .filter((days): days is number => days !== null);

  const allOpenAges = open
    .map((card) => calendarDaysBetween(card.enteredListAt, asOf))
    .filter((days): days is number => days !== null);

  const openAgeRows: OpenAgeRow[] = lists
    .filter((list) => list.id !== doneListId)
    .map((list) => {
      const inList = open.filter((card) => card.listId === list.id);
      const aged = inList
        .map((card) => ({
          card,
          age: calendarDaysBetween(card.enteredListAt, asOf),
        }))
        .filter((entry): entry is { card: Card; age: number } => entry.age !== null)
        .sort((a, b) => b.age - a.age);
      const ages = aged.map((entry) => entry.age);
      const oldest = aged[0];
      return {
        listId: list.id,
        listTitle: list.title,
        count: inList.length,
        averageAgeDays: average(ages),
        medianAgeDays: median(ages),
        oldestAgeDays: oldest?.age ?? null,
        oldestCardId: oldest?.card.id ?? null,
        oldestCardTitle: oldest?.card.title ?? null,
      };
    });

  const asOfOrdinal = dateOrdinal(asOf);
  const completionsSince = (days: number) => completed.filter((card) => {
    const completedOrdinal = dateOrdinal(card.enteredListAt);
    return completedOrdinal !== null && asOfOrdinal !== null &&
      completedOrdinal <= asOfOrdinal && completedOrdinal >= asOfOrdinal - (days - 1);
  }).length;

  return {
    doneListId,
    completedCount: completed.length,
    openCount: open.length,
    createToDoneSampleSize: createToDoneTimes.length,
    medianCreateToDoneDays: median(createToDoneTimes),
    averageCreateToDoneDays: average(createToDoneTimes),
    averageOpenAgeDays: average(allOpenAges),
    completedLast7Days: completionsSince(7),
    completedLast30Days: completionsSince(30),
    openAgeRows,
  };
}
