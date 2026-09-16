import { ApigoError } from '../core/errors.js';
import { isRecord } from '../utils/objects.js';

export type Variables = Record<string, string>;

export function interpolate<T>(value: T, variables: Variables): T {
  const resolve = (text: string, seen = new Set<string>()): string => text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_match, key: string) => {
    if (seen.has(key)) throw new ApigoError('ENV_CYCLE', `Environment variable ${key} contains a circular reference.`);
    if (!Object.hasOwn(variables, key)) throw new ApigoError('ENV_MISSING', `Environment variable ${key} is not set.`, 2, 'Set it with apigo env set <environment> <name> <value>.');
    return resolve(variables[key]!, new Set(seen).add(key));
  });
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return resolve(item);
    if (Array.isArray(item)) return item.map(walk);
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
    return item;
  };
  return walk(value) as T;
}
