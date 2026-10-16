import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateKanbanFlowMetrics, calendarDaysBetween } from "./kanban-metrics.ts";
import type { Card } from "./types.ts";

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "c1",
    listId: "doing",
    boardId: "b1",
    title: "کار آزمایشی",
    notes: "",
    priority: "med",
    dueDate: null,
    startDate: null,
    coverColor: null,
    position: 1,
    archived: false,
    followerId: null,
    memberIds: [],
    labelIds: [],
    progress: 0,
    createdAt: "2026-10-01",
    checklists: [],
    comments: [],
    activities: [],
    dependsOnIds: [],
    enteredListAt: "2026-10-03T21:30:00.000Z",
    ...overrides,
  };
}

const lists = [
  { id: "todo", title: "در صف" },
  { id: "doing", title: "در حال انجام" },
  { id: "done", title: "انجام‌شده" },
];

test("calendarDaysBetween uses the date portion and rejects invalid or reversed dates", () => {
  assert.equal(calendarDaysBetween("2026-10-01", "2026-10-03T23:59:00.000Z"), 2);
  assert.equal(calendarDaysBetween("2026-10-03", "2026-10-01"), null);
  assert.equal(calendarDaysBetween("2026-02-30", "2026-03-01"), null);
  assert.equal(calendarDaysBetween(null, "2026-03-01"), null);
});

test("last column defines Done; progress alone does not close a card", () => {
  const result = calculateKanbanFlowMetrics(
    [card({ id: "done", listId: "done", progress: 100 }), card({ id: "p100", progress: 100 })],
    lists,
    "2026-10-05",
  );
  assert.equal(result.completedCount, 1);
  assert.equal(result.openCount, 1);
});

test("flow metrics compute lead time, open age and oldest card per status", () => {
  const result = calculateKanbanFlowMetrics(
    [
      card({ id: "a", listId: "done", createdAt: "2026-10-01", enteredListAt: "2026-10-04T08:00:00Z" }),
      card({ id: "b", listId: "done", createdAt: "2026-10-01", enteredListAt: "2026-10-06T08:00:00Z" }),
      card({ id: "old", listId: "doing", enteredListAt: "2026-10-01T08:00:00Z" }),
      card({ id: "new", listId: "doing", enteredListAt: "2026-10-04T08:00:00Z" }),
      card({ id: "archived", listId: "doing", archived: true, enteredListAt: "2026-09-01T08:00:00Z" }),
    ],
    lists,
    "2026-10-05",
  );
  assert.equal(result.completedCount, 2);
  assert.equal(result.createToDoneSampleSize, 2);
  assert.equal(result.medianCreateToDoneDays, 4);
  assert.equal(result.completedLast7Days, 1);
  assert.equal(result.completedLast30Days, 1);
  assert.equal(result.openCount, 2);
  assert.equal(result.averageOpenAgeDays, 2.5);
  const doing = result.openAgeRows.find((row) => row.listId === "doing");
  assert.equal(doing?.count, 2);
  assert.equal(doing?.oldestCardId, "old");
  assert.equal(doing?.oldestAgeDays, 4);
});

test("empty/one-column boards return safe empty metrics", () => {
  const empty = calculateKanbanFlowMetrics([], [], "2026-10-05");
  assert.equal(empty.doneListId, undefined);
  assert.equal(empty.completedCount, 0);
  assert.equal(empty.medianCreateToDoneDays, null);
  assert.equal(empty.averageOpenAgeDays, null);
  const oneColumn = calculateKanbanFlowMetrics([card({ listId: "todo" })], [{ id: "todo", title: "تنها" }], "2026-10-05");
  assert.equal(oneColumn.completedCount, 1);
  assert.equal(oneColumn.openCount, 0);
});

test("throughput is bounded to the as-of date and excludes archived cards", () => {
  const result = calculateKanbanFlowMetrics(
    [
      card({ id: "recent", listId: "done", enteredListAt: "2026-10-05T10:00:00Z" }),
      card({ id: "future", listId: "done", enteredListAt: "2026-10-06T10:00:00Z" }),
      card({ id: "archived", listId: "done", archived: true, enteredListAt: "2026-10-04T10:00:00Z" }),
    ],
    lists,
    "2026-10-05",
  );
  assert.equal(result.completedLast7Days, 1);
  assert.equal(result.completedLast30Days, 1);
});
