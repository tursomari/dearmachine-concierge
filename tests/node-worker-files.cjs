// NixOS/nixpkgs#536039: affected Darwin Node builds corrupt worker fd tracking.
const { Worker, isMainThread } = require('node:worker_threads');
const { openSync, readSync, closeSync } = require('node:fs');

if (isMainThread) {
  const worker = new Worker(__filename);
  worker.on('error', error => {
    console.error(error);
    process.exitCode = 1;
  });
  worker.on('exit', code => {
    if (code !== 0) process.exitCode = 1;
  });
} else {
  process.on('warning', warning => { throw warning; });
  for (let iteration = 0; iteration < 800; iteration++) {
    const descriptor = openSync(__filename, 'r');
    try {
      readSync(descriptor, Buffer.alloc(16), 0, 16, 0);
    } finally {
      closeSync(descriptor);
    }
  }
}
