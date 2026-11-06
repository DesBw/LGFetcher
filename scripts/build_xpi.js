// npm wrapper; building directly with Python does not require Node.
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const command = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");
const prefix = process.platform === "win32" && !process.env.PYTHON ? ["-3"] : [];
const result = spawnSync(command, [...prefix, path.join(__dirname, "build_xpi.py"), ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) console.error(`Could not run Python: ${result.error.message}`);
process.exit(result.status ?? 1);
