/** Wait before the nth failed replay attempt of a pending write: 1 minute doubling to a 30 minute cap. */
export const sleepBackoff = (attempts: number): number => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
