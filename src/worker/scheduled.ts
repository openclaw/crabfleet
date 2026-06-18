export type ScheduledExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type ScheduledReconciliationDependencies = {
  now(): number;
  reconcile(now: number): Promise<void>;
  reportError(error: unknown): void;
};

export type ScheduledRecurringCardDependencies = {
  now(): number;
  run(now: number): Promise<unknown>;
  reportError(error: unknown): void;
};

export function scheduleInteractiveSessionReconciliation(
  context: ScheduledExecutionContext,
  dependencies: ScheduledReconciliationDependencies,
): void {
  context.waitUntil(
    dependencies.reconcile(dependencies.now()).catch((error) => {
      dependencies.reportError(error);
    }),
  );
}

export function scheduleRecurringCardTick(
  context: ScheduledExecutionContext,
  dependencies: ScheduledRecurringCardDependencies,
): void {
  context.waitUntil(
    dependencies.run(dependencies.now()).catch((error) => {
      dependencies.reportError(error);
    }),
  );
}
