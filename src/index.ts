#!/usr/bin/env node
import { CommanderError } from 'commander';
import { ApigoError } from './core/errors.js';
import { createProgram } from './cli/parser.js';
import { closeContext, commandRedactor } from './cli/context.js';
import { terminalSafe } from './utils/security.js';

process.stdout.on('error', error => {
  if ('code' in error && error.code === 'EPIPE') process.exit(0);
  throw error;
});

// Commander can report invalid option values before the application context exists.
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index]!;
  const equals = arg.indexOf('=');
  const name = arg.replace(/^-+/, '').split('=')[0]!;
  if (commandRedactor.sensitive(name)) commandRedactor.add(equals < 0 ? process.argv[index + 1] : arg.slice(equals + 1));
  if (['-H', '--header', '-q', '--query', '-p', '--param'].includes(arg)) {
    const value = process.argv[index + 1] ?? '';
    const separator = /^-H$|--header/.test(arg) ? ':' : '=';
    const split = value.indexOf(separator);
    if (split > 0) commandRedactor.collect({ [value.slice(0, split).trim()]: value.slice(split + 1).trim() });
  }
}

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else if (error instanceof CommanderError) {
    process.exitCode = 2;
  } else {
    const redactor = commandRedactor;
    const known = error instanceof ApigoError;
    const cancelled = error instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(error.name);
    const code = known ? error.code : cancelled ? 'CANCELLED' : 'INTERNAL_ERROR';
    const message = known ? error.message : cancelled ? 'Cancelled.' : 'An unexpected error occurred.';
    process.stderr.write(`${terminalSafe(redactor.text(message))}\n${code}\n`);
    if (known && error.hint) process.stderr.write(`${terminalSafe(redactor.text(error.hint))}\n`);
    if (process.argv.includes('--debug') && error instanceof Error) process.stderr.write(`${terminalSafe(redactor.text(error.stack ?? ''))}\n`);
    process.exitCode = known ? error.exitCode : cancelled ? 130 : 1;
  }
} finally { closeContext(); }
