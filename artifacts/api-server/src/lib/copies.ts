/**
 * Expands compact import membership into the same logical rows represented by
 * an uploaded WIP file. Consumers of this output must add each row once;
 * compact SQL aggregates instead multiply their measure by `copies`.
 */
export function expandCopies<T extends { copies: number }, R>(
  members: readonly T[],
  map: (member: T) => R,
): R[] {
  const expanded: R[] = [];
  for (const member of members) {
    for (let copy = 0; copy < member.copies; copy += 1) {
      expanded.push(map(member));
    }
  }
  return expanded;
}

/** Total a compact membership without expanding it first. */
export function copyWeightedTotal<T extends { copies: number }>(
  members: readonly T[],
  weightKg: (member: T) => number | null | undefined,
): number {
  return members.reduce(
    (total, member) => total + (weightKg(member) ?? 0) * member.copies,
    0,
  );
}