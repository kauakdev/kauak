// The kauak command line: `kauak [command] [options]`.
//
// bin/kauak.js passes its arguments to main(), which finds the command in
// COMMANDS, parses its options with node:util's parseArgs and runs it. A
// command is a module in cli/commands/ that exports
//
//   name     the word after `kauak`
//   summary  its line in `kauak --help`
//   usage    the text of `kauak <name> --help` and `kauak help <name>`
//   options  parseArgs options; -h/--help is added to every command
//   run      async (values) => an exit code, or nothing while it keeps the
//            process running (as `serve` does, until Ctrl+C)
//
// so a new command is one module and one entry in COMMANDS, and the help lists
// it on its own. Commands stay thin: they read their options and hand the work
// to the application (`serve` starts the bridge). A command throws UsageError
// for a bad value; any other error is a bug and surfaces as one.
//
// `kauak` alone runs DEFAULT_COMMAND, and so does `kauak` followed by
// options: the whole command line goes to it (`kauak --demo` is
// `kauak serve --demo`). Global options count only as the first argument, so
// a new one must not reuse an option of serve's (-p/--port, --demo,
// --no-open), or `kauak <that option>` would stop reaching serve.
//
// Exit codes: 0 done (help and --version too), 1 the command failed,
// 2 the command line is wrong (unknown command, bad option).

import fs from "node:fs";
import { parseArgs } from "node:util";
import * as serve from "./commands/serve.js";
import { UsageError } from "./errors.js";

export const COMMANDS = [serve];
const DEFAULT_COMMAND = serve;

const HELP_OPTION = { type: "boolean", short: "h" };

export async function main(argv) {
  const [first, ...rest] = argv;
  if (first === "-v" || first === "--version") return print(`${version()}\n`);
  if (first === "help" || first === "-h" || first === "--help") {
    if (!rest.length) return print(help());
    const command = COMMANDS.find((c) => c.name === rest[0]);
    return command ? print(command.usage) : usageError("kauak", `unknown command '${rest[0]}'`, help());
  }

  const named = first !== undefined && !first.startsWith("-");
  const command = named ? COMMANDS.find((c) => c.name === first) : DEFAULT_COMMAND;
  if (!command) return usageError("kauak", `unknown command '${first}'`, help());

  let values;
  try {
    ({ values } = parseArgs({ args: named ? rest : argv, options: { ...command.options, help: HELP_OPTION }, strict: true }));
  } catch (err) {
    if (!err.code?.startsWith("ERR_PARSE_ARGS_")) throw err;
    return usageError(`kauak ${command.name}`, err.message, command.usage);
  }
  if (values.help) return print(command.usage);
  try {
    return await command.run(values);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return usageError(`kauak ${command.name}`, err.message, command.usage);
  }
}

function help() {
  // Command names line up with the options below ("-v, --version").
  const width = Math.max(13, ...COMMANDS.map((c) => c.name.length));
  return `Usage: kauak [command] [options]

Shows your Herdr coding agents as a live isometric office.

Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join("\n")}

Options:
  -h, --help     show this help
  -v, --version  print the version

Run \`kauak help <command>\` for a command's options.
To start the office: kauak serve (or kauak serve --demo, no Herdr needed)
\`kauak\` alone runs \`kauak serve\`, and \`kauak --demo\` is \`kauak serve --demo\`.
`;
}

/** Read from the package itself, wherever it is installed. */
function version() {
  return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

function print(text) {
  process.stdout.write(text);
  return 0;
}

function usageError(prefix, message, usage) {
  // parseArgs messages start with a capital ("Unknown option '--x'").
  process.stderr.write(`${prefix}: ${message[0].toLowerCase()}${message.slice(1)}\n\n${usage}`);
  return 2;
}
