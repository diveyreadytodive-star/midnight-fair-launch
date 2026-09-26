export type ExecutionRecoveryState = {
  readonly status: string;
  readonly actions: Readonly<Record<string, unknown>>;
  readonly contractAddress?: string;
  readonly pending?: unknown;
};

/** Allow execution only from a pristine protected manifest; this runner has no resume flow. */
export function assertFreshExecution(state: ExecutionRecoveryState): void {
  if (state.status !== 'prepared' || state.pending !== undefined ||
      Object.keys(state.actions).length !== 0 || state.contractAddress !== undefined) {
    throw new Error('Refusing execution from a non-pristine recovery manifest; reconcile manually.');
  }
}
