const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ROOT } = require("./helpers");

const python = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");
const pythonPrefix = process.platform === "win32" && !process.env.PYTHON ? ["-3"] : [];
const runPython = (args, options) => execFileSync(python, [...pythonPrefix, ...args], options);

test("XPI build packages the real plugin files at the archive root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lgfetcher-package-"));
  const output = path.join(dir, "test.xpi");
  try {
    runPython([path.join(ROOT, "scripts/build_xpi.py"), output]);
    const inspect = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    print(json.dumps({name: hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()}))
`;
    const archived = JSON.parse(runPython(["-c", inspect, output], { encoding: "utf8" }));
    const expected = [
      "manifest.json", "bootstrap.js", "icon.svg", "preferences-default.js",
      "preferences-ui.js", "preferences.xhtml", "selection.js", "selection.xhtml"
    ];
    assert.deepEqual(Object.keys(archived).sort(), expected.sort());
    for (const name of expected) {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, name))).digest("hex");
      assert.equal(archived[name], hash, `${name} in the XPI should match the source`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
