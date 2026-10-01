/** The interfaces `os.networkInterfaces()` reports in the orchestration tests; null means the real ones. */
export const osMock: { interfaces: Record<string, unknown[]> | null } = { interfaces: null };
