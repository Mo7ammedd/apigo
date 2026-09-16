import { confirm, input, password, select } from '@inquirer/prompts';
import { ApigoError } from '../core/errors.js';
import type { Document, Parameter, PreparedRequest, PromptAdapter, Schema, SchemaObject } from '../core/types.js';
import { generateBody, schemaExample } from '../openapi/generator.js';
import { resolveSchema, schemaType } from '../openapi/resolver.js';
import { isRecord, parseJson } from '../utils/objects.js';
import { isSensitiveKey, terminalSafe } from '../utils/security.js';
import type { Redactor } from '../utils/security.js';

const terminal = { input: process.stdin, output: process.stderr };

export function canPrompt(nonInteractive = false, machine = false): boolean {
  return !nonInteractive && !machine && Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function secretPrompt(message: string): Promise<string> {
  if (!canPrompt()) throw new ApigoError('MISSING_INPUT', 'A credential is required in non-interactive mode.', 2, 'Use an environment reference or read the credential from stdin.');
  return password({ message: terminalSafe(message), mask: '*' }, terminal);
}

export async function confirmAction(message: string): Promise<boolean> {
  return confirm({ message: terminalSafe(message), default: false }, terminal);
}

export function requestPrompts(redactor: Redactor): PromptAdapter {
  async function value(label: string, schema: SchemaObject, initial?: unknown): Promise<unknown> {
    if (isSensitiveKey(label) || schema.format === 'password' || schema.writeOnly) {
      const secret = await secretPrompt(`${label}:`);
      redactor.add(secret);
      return secret;
    }
    if (schema.enum?.length) return select({ message: terminalSafe(`${label}:`), choices: schema.enum.map(item => ({ name: terminalSafe(redactor.text(typeof item === 'string' ? item : JSON.stringify(item))), value: item })), default: initial }, terminal);
    const type = schemaType(schema);
    if (type === 'boolean') return confirm({ message: terminalSafe(`${label}:`), default: typeof initial === 'boolean' ? initial : false }, terminal);
    const answer = await input({ message: terminalSafe(`${label}${['array', 'object'].includes(type) ? ' (JSON)' : ''}:`),
      ...(initial === undefined || initial === '' ? {} : { default: typeof initial === 'string' ? initial : JSON.stringify(initial) }),
      validate: text => text.trim().length > 0 || 'A value is required.',
    }, terminal);
    if (answer === 'null' && (schema.nullable || Array.isArray(schema.type) && schema.type.includes('null'))) return null;
    if (['array', 'object'].includes(type)) return parseJson(answer, 'prompt JSON');
    if (['integer', 'number'].includes(type)) {
      const number = Number(answer);
      if (!Number.isFinite(number)) throw new ApigoError('VALIDATION', `${label} must be a number.`);
      return number;
    }
    return answer;
  }

  async function body(schema: Schema, document: Document, example?: unknown, label = 'Body', depth = 0): Promise<unknown> {
    let resolved = resolveSchema(schema, document);
    if (resolved.oneOf?.length || resolved.anyOf?.length) {
      const branches = resolved.oneOf ?? resolved.anyOf!;
      const selected = await select({ message: terminalSafe(`${label} schema:`), choices: branches.map((item, index) => ({ name: terminalSafe(resolveSchema(item, document).title ?? `Variant ${index + 1}`), value: index })) }, terminal);
      resolved = { ...resolved, ...resolveSchema(branches[selected]!, document), oneOf: undefined, anyOf: undefined };
    }
    const initial = example ?? schemaExample(resolved) ?? generateBody(resolved, document, { requiredOnly: true });
    if (schemaType(resolved) !== 'object' || !resolved.properties || depth >= 6) return value(label, resolved, initial);
    const result: Record<string, unknown> = isRecord(example) ? { ...example } : {};
    for (const [key, property] of Object.entries(resolved.properties)) {
      const child = resolveSchema(property, document);
      if (child.readOnly) { delete result[key]; continue; }
      if (!resolved.required?.includes(key)) continue;
      result[key] = await body(property, document, isRecord(initial) ? initial[key] : undefined, label === 'Body' ? key : `${label}.${key}`, depth + 1);
    }
    return result;
  }

  return {
    parameter: (parameter: Parameter, schema: SchemaObject) => value(parameter.name, schema, parameter.example ?? schemaExample(schema)),
    body,
    async confirmRequest(request: PreparedRequest): Promise<boolean> {
      process.stderr.write(`\n${request.method} ${terminalSafe(redactor.url(request.url))}\n`);
      if (request.body) {
        let formatted = redactor.body(request.body);
        try { formatted = JSON.stringify(JSON.parse(formatted), null, 2); } catch { /* Keep plain text. */ }
        process.stderr.write(`\nBODY\n${terminalSafe(formatted)}\n\n`);
      }
      return confirm({ message: 'Send request?', default: true }, terminal);
    },
  };
}
