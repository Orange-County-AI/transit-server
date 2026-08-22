export const ALARM_BUDGET_PER_HOUR = 120;

// Polling connectors legitimately need a far denser alarm stream than the
// redelivery/retry alarms the default budget was sized for: a 5s cadence is
// 720 wakeups an hour. The budget still exists to stop a runaway connector
// from billing an unbounded alarm stream, so it is raised, not removed.
export const POLL_ALARM_BUDGET_PER_HOUR = 900;
const HOUR_MS = 60 * 60 * 1_000;
const CURRENT_HOUR_KEY = "alarm_budget:current_hour";
const EXHAUSTED_KEY = "budget_exhausted";

export type AlarmBudgetStatus = {
  hourStart: number;
  resumeAt: number;
};


export async function budgetedAlarm(
  storage: Pick<DurableObjectStorage, "transaction">,
  atMs: number,
  limit: number = ALARM_BUDGET_PER_HOUR,
): Promise<boolean> {
  const now = Date.now();
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const resumeAt = hourStart + HOUR_MS;
  const currentCountKey = `alarm_budget:count:${hourStart}`;
  const currentResumeKey = `alarm_budget:resume:${hourStart}`;

  return storage.transaction(async (transaction) => {
    const previousHour = await transaction.get<number>(CURRENT_HOUR_KEY);
    if (previousHour !== hourStart) {
      if (previousHour !== undefined) {
        await transaction.delete([
          `alarm_budget:count:${previousHour}`,
          `alarm_budget:resume:${previousHour}`,
        ]);
      }
      await transaction.put(CURRENT_HOUR_KEY, hourStart);
      await transaction.delete(EXHAUSTED_KEY);
    }

    const count = (await transaction.get<number>(currentCountKey)) ?? 0;
    if (count >= limit) {
      await transaction.put<AlarmBudgetStatus>(EXHAUSTED_KEY, { hourStart, resumeAt });
      const resumeScheduled = await transaction.get<boolean>(currentResumeKey);
      if (!resumeScheduled) {
        await transaction.setAlarm(resumeAt);
        await transaction.put(currentResumeKey, true);
      }
      return false;
    }

    await transaction.put(currentCountKey, count + 1);
    await transaction.setAlarm(atMs);
    return true;
  });
}

export async function alarmBudgetStatus(
  storage: Pick<DurableObjectStorage, "get">,
): Promise<AlarmBudgetStatus | null> {
  return (await storage.get<AlarmBudgetStatus>(EXHAUSTED_KEY)) ?? null;
}
