#!/usr/bin/env node
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };

new Command()
  .name('apigo')
  .description(pkg.description)
  .version(pkg.version)
  .parse();
