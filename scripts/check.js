'use strict';

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');

for (const directory of ['server', 'src', 'tests', 'scripts']) {
  for (const file of readdirSync(directory, { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
}
