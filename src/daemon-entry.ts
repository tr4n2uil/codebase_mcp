#!/usr/bin/env node
import './ort-env-early.js';
import { runDaemonCliMain } from './daemon-cli.js';

void runDaemonCliMain().catch((e) => {
  console.error(e);
  process.exit(1);
});
