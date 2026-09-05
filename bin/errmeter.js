#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 18) {
  process.stderr.write('errmeter: Node.js 18 or newer is required\n');
  process.exit(2);
}
'use strict';
const command = process.argv[2];
if (command === 'emit') {
  require('../src/emit').main(process.argv.slice(3));
} else if (command === 'flush') {
  process.stderr.write('flush: not implemented in this build (see #4)\n');
  process.exitCode = 3;
} else if (command === '--version') {
  process.stdout.write(require('../package.json').version + '\n');
} else if (command === '--help' || command === undefined) {
  process.stdout.write(require('../src/cli').USAGE);
} else {
  process.stderr.write('errmeter: unknown command\n');
  process.exitCode = 2;
}
