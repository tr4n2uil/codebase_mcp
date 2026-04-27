#!/usr/bin/env node
import { runDaemonCliMain } from './daemon-cli.js';

void runDaemonCliMain().catch((e) => {
  console.error(e);
  process.exit(1);
});
