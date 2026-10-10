export const contractorUuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
export const contractorFailure = (statusCode: number) => Object.assign(new Error('Invalid contractor action'), { statusCode });
export function contractorIdentifier(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !new RegExp(contractorUuid.pattern).test(value)) throw contractorFailure(400);
  return value.toLowerCase();
}
export function contractorInput(value: unknown, update = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractorFailure(400);
  const body = value as Record<string, unknown>;
  const allowed = update ? ['name', 'status', 'expectedVersion'] : ['name'];
  if (Object.keys(body).some(key => !allowed.includes(key)) || typeof body.name !== 'string' || /\p{Cc}/u.test(body.name)) throw contractorFailure(400);
  const name = body.name.trim();
  if (!name || [...name].length > 200) throw contractorFailure(400);
  if (update && (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)
    || body.expectedVersion < 1 || body.expectedVersion >= 2147483647 || !['active', 'inactive'].includes(body.status as string))) throw contractorFailure(400);
  return { name, status: update ? body.status as string : 'active', expectedVersion: update ? body.expectedVersion as number : 0 };
}
