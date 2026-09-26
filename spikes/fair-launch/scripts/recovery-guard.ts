export type ExecutionManifest = {
  readonly status: string;
  readonly actions: Readonly<Record<string, unknown>>;
  readonly contractAddress?: string;
  readonly pending?: unknown;
};

/** There is no resume path; only a clean, fully preflighted run may submit transactions. */
export function assertFreshExecution(manifest: ExecutionManifest): void {
  if (manifest.status !== 'preflighted' || manifest.pending !== undefined ||
      Object.keys(manifest.actions).length !== 0 || manifest.contractAddress !== undefined) {
    throw new Error('Refusing a non-pristine or un-preflighted recovery manifest.');
  }
}
