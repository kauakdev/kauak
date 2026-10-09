#!/usr/bin/env node
// The `kauak` executable (`npx @kauakdev/kauak <command>`, or `kauak <command>`
// after `npm install -g @kauakdev/kauak`). The command line itself is in
// cli/main.js.

import { main } from "../cli/main.js";

// A command that keeps running (`serve`) returns nothing and the process ends
// on Ctrl+C; the others return their exit code. Exiting here also stops a
// bridge that started but could not serve the page.
const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
