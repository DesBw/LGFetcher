const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { ROOT } = require("./helpers");

function loadPreferences(initial = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "preferences.xhtml"), "utf8"), {
    contentType: "application/xhtml+xml"
  });
  const { window } = dom;
  const prefs = new Map(Object.entries(initial));
  const errors = [];
  const Zotero = {
    Prefs: {
      get(name, global) { assert.equal(global, true); return prefs.get(name); },
      set(name, value, global) { assert.equal(global, true); prefs.set(name, value); }
    },
    logError: error => errors.push(error)
  };
  const context = vm.createContext({ window, document: window.document, Zotero });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "preferences-ui.js"), "utf8"), context);
  return { dom, window, document: window.document, prefs, errors, ui: window.LGFetcher_Preferences };
}

test("settings initialize with saved mirror and format preferences", () => {
  const h = loadPreferences({
    "extensions.lgfetcher.mirrors": "https://mirror.example/\nhttps://other.example/",
    "extensions.lgfetcher.formats.pdf": false,
    "extensions.lgfetcher.formats.epub": true
  });
  h.ui.init();
  assert.equal(h.document.getElementById("lgfetcher-mirrors").value, "https://mirror.example\nhttps://other.example");
  assert.equal(h.document.getElementById("lgfetcher-format-pdf").checked, false);
  assert.equal(h.document.getElementById("lgfetcher-format-epub").checked, true);
  assert.equal(h.document.getElementById("lgfetcher-format-djvu").checked, true);
  assert.equal(h.errors.length, 0);
  h.dom.window.close();
});

test("settings seed defaults and migrate the old single-mirror value", () => {
  for (const initial of [{}, { "extensions.lgfetcher.mirrors": "https://libgen.is" }]) {
    const h = loadPreferences(initial);
    h.ui.init();
    const mirrors = h.prefs.get("extensions.lgfetcher.mirrors");
    assert.ok(mirrors.includes("https://libgen.li\n"));
    assert.ok(mirrors.endsWith("https://libgen.is"));
    assert.equal(h.document.getElementById("lgfetcher-mirrors").value, mirrors);
    h.dom.window.close();
  }
});

test("settings validate and save URLs and formats without overwriting on error", () => {
  const h = loadPreferences({ "extensions.lgfetcher.mirrors": "https://original.example" });
  h.ui.init();
  const box = h.document.getElementById("lgfetcher-mirrors");
  const status = h.document.getElementById("lgfetcher-save-status");
  box.value = "invalid.example";
  h.ui.save();
  assert.match(status.textContent, /Invalid URL/);
  assert.equal(h.prefs.get("extensions.lgfetcher.mirrors"), "https://original.example");

  box.value = " https://one.example///\nhttp://two.example/ ";
  for (const format of ["pdf", "epub", "djvu", "mobi"]) {
    h.document.getElementById(`lgfetcher-format-${format}`).checked = false;
  }
  h.ui.save();
  assert.match(status.textContent, /Select at least one file type/);
  assert.equal(h.prefs.get("extensions.lgfetcher.mirrors"), "https://original.example");

  h.document.getElementById("lgfetcher-format-epub").checked = true;
  h.ui.save();
  assert.equal(status.textContent, "Settings saved.");
  assert.equal(h.prefs.get("extensions.lgfetcher.mirrors"), "https://one.example\nhttp://two.example");
  assert.equal(h.prefs.get("extensions.lgfetcher.formats.pdf"), false);
  assert.equal(h.prefs.get("extensions.lgfetcher.formats.epub"), true);
  assert.equal(h.errors.length, 0);
  h.dom.window.close();
});
