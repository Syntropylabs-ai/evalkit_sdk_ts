#!/usr/bin/env node
const { main, shellWord } = require("../dist/cli/index.js");
main(process.argv.slice(2), { out: console.log, err: console.error, binary: `${shellWord(process.execPath)} ${shellWord(__filename)}` }).then((code) => process.exit(code));
