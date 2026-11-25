import { AmsDate, type AmsRecord, type AmsData } from "@openams/contracts";
import { AmsError, digest } from "./repository.js";

export function calendarDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  const result = AmsDate.safeParse(value.toISOString().slice(0, 10));
  if (!result.success)
    throw new AmsError(
      422,
      "follow_up_out_of_range",
      "The follow-up date is outside the supported calendar range.",
    );
  return result.data;
}
export function nextTaskDate(
  due: string,
  today: string,
  interval: number,
): string {
  const elapsed = Math.floor(
    (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) /
      86400000,
  );
  return calendarDays(
    due,
    Math.max(1, Math.floor(elapsed / interval) + 1) * interval,
  );
}
export function reminderId(
  taskId: string,
  generation: number,
  type: "due" | "escalation",
) {
  return `reminder_${digest({ taskId, generation, type }).slice(0, 48)}`;
}
export function taskScheduleKey(task: AmsRecord<"tasks">) {
  const d = task.data;
  return digest({
    accountId: d.accountId,
    ownerId: d.ownerId,
    dueDate: d.dueDate,
    status: d.status,
    followUp: d.followUp,
    archivedAt: task.archivedAt,
  });
}
export function taskReminders(
  task: AmsRecord<"tasks">,
): Array<{ id: string; data: AmsData<"reminders"> }> {
  const d = task.data;
  if (task.archivedAt || d.status === "done" || !d.ownerId) return [];
  const rules = d.followUp;
  const targets = [
    ...(rules.reminderDaysBefore !== null
      ? [
          {
            type: "due" as const,
            ownerId: d.ownerId,
            dueDate: calendarDays(d.dueDate, -rules.reminderDaysBefore),
          },
        ]
      : []),
    ...(rules.escalationAfterDays && rules.escalationOwnerId
      ? [
          {
            type: "escalation" as const,
            ownerId: rules.escalationOwnerId,
            dueDate: calendarDays(d.dueDate, rules.escalationAfterDays),
          },
        ]
      : []),
  ];
  return targets.map((target) => {
    const id = reminderId(task.id, d.reminderGeneration, target.type);
    return {
      id,
      data: {
        ...target,
        accountId: d.accountId,
        taskId: task.id,
        generation: d.reminderGeneration,
        title: d.title,
        status: "scheduled",
        queueKey: `${target.dueDate}:${id}`,
        deliveredAt: null,
        dismissedAt: null,
        dismissedBy: null,
        detail: "",
      },
    };
  });
}
