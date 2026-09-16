import type { ApiDiff } from '../core/types.js';
import { hasChanges } from '../openapi/diff.js';
import { terminalSafe } from '../utils/security.js';

export function renderDiff(diff: ApiDiff): string {
  if (!hasChanges(diff)) return 'No OpenAPI changes.\n';
  const lines: string[] = ['OpenAPI changed', ''];
  const added = [...diff.addedOperations, ...diff.addedSchemas.map(name => `schema ${name}`)];
  const removed = [...diff.removedOperations, ...diff.removedSchemas.map(name => `schema ${name}`)];
  if (added.length) lines.push('ADDED', ...added.map(name => `+ ${name}`), '');
  if (removed.length) lines.push('REMOVED', ...removed.map(name => `- ${name}  [potentially breaking]`), '');
  if (diff.changedOperations.length || diff.changedSchemas.length || diff.changes.length) {
    lines.push('CHANGED');
    for (const item of [...diff.changedOperations, ...diff.changedSchemas]) {
      lines.push(`~ ${item.name}`);
      for (const change of item.changes) lines.push(`  ${change.message}${change.breaking ? '  [potentially breaking]' : ''}`);
    }
    for (const change of diff.changes) lines.push(`~ ${change.message}${change.breaking ? '  [potentially breaking]' : ''}`);
  }
  return `${terminalSafe(lines.join('\n'))}\n`;
}
