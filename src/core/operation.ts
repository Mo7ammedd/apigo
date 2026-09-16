import { ApigoError } from './errors.js';
import type { ApiDefinition, HttpMethod, Operation } from './types.js';
import { slug } from '../utils/objects.js';

export function defaultAction(method: HttpMethod, path: string): string {
  if (method === 'GET') return /\{[^}]+\}/.test(path) ? 'get' : 'list';
  return ({ POST: 'create', PUT: 'update', PATCH: 'patch', DELETE: 'delete', HEAD: 'head', OPTIONS: 'options', TRACE: 'trace' } as const)[method];
}

export function actionName(operationId: string | undefined, group: string, method: HttpMethod, path: string): string {
  if (!operationId) return defaultAction(method, path);
  const words = slug(operationId).split('-');
  const groupWords = new Set(group.split('-').flatMap(word => [word, word.replace(/s$/, '')]));
  let meaningful = words.filter(word => !groupWords.has(word) && !groupWords.has(word.replace(/s$/, '')) && word !== 'async');
  if (meaningful.at(-2) === 'by' && ['id', 'uuid', 'key'].includes(meaningful.at(-1)!)) meaningful = meaningful.slice(0, -2);
  const actions: Record<string, string> = { post: 'create', add: 'create', put: 'update', remove: 'delete' };
  if (meaningful[0] && actions[meaningful[0]]) meaningful[0] = actions[meaningful[0]]!;
  return meaningful.join('-') || defaultAction(method, path);
}

export function nameOperations(operations: Operation[]): void {
  const counts = new Map<string, number>();
  for (const operation of operations) counts.set(operation.key, (counts.get(operation.key) ?? 0) + 1);
  const used = new Set<string>();
  for (const operation of [...operations].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))) {
    if ((counts.get(operation.key) ?? 0) > 1) operation.key = `${operation.group}.${defaultAction(operation.method, operation.path)}`;
    if (used.has(operation.key)) {
      const detail = slug(operation.operationId ?? operation.path).replace(new RegExp(`^${operation.group}-?`), '');
      const base = `${operation.key}-${detail || operation.method.toLowerCase()}`;
      let name = base;
      let suffix = 2;
      while (used.has(name)) name = `${base}-${suffix++}`;
      operation.key = name;
    }
    used.add(operation.key);
    operation.aliases = [...new Set([operation.operationId, `${operation.group}.${defaultAction(operation.method, operation.path)}`].filter((item): item is string => Boolean(item)))].filter(alias => alias !== operation.key);
  }
}

export function findOperation(api: ApiDefinition, name: string): Operation {
  const exact = api.operations.find(operation => operation.key === name);
  if (exact) return exact;
  const matches = api.operations.filter(operation => operation.aliases.includes(name));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new ApigoError('AMBIGUOUS_OPERATION', `Operation alias is ambiguous: ${name}.`, 2, `Use one of: ${matches.map(operation => operation.key).join(', ')}.`);
  throw new ApigoError('OPERATION_NOT_FOUND', `Operation not found: ${name}.`, 2, 'Use apigo api show to list operation names.');
}
