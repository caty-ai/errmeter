#!/usr/bin/env node
'use strict';
if (Number(process.versions.node.split('.')[0]) < 18) {
  process.stderr.write('errmeter: Node.js 18 or newer is required\n');
  process.exit(2);
}
const command = process.argv[2];
if (command === 'emit') {
  require('../src/emit').main(process.argv.slice(3));
} else if (command === 'flush') {
  Promise.resolve(require('../src/flush').main(process.argv.slice(3))).catch(() => {
    if (!process.argv.includes('--quiet')) process.stderr.write('flush: unexpected failure\n');
    process.exitCode = 1;
  });
} else if (command === 'watch') {
  require('../src/watch').main(process.argv.slice(3));
} else if (command === '_run') {
  require('../src/run').main(process.argv.slice(3));
} else if (command === '--version') {
  process.stdout.write(require('../package.json').version + '\n');
} else if (command === '--help' || command === undefined) {
  process.stdout.write(require('../src/cli').USAGE);
} else {
  process.stderr.write('errmeter: unknown command\n');
  process.exitCode = 2;
}
