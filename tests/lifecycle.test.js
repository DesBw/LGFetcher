const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, createHarness, deferred } = require("./helpers");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const params = { id: manifest.applications.zotero.id, version: manifest.version, rootURI: "file:///plugin/" };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("manifest keeps the existing plugin identity and permits Zotero 9 and 10", () => {
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.applications.zotero.id, "lgfetcher@example.com");
  assert.equal(manifest.applications.zotero.strict_min_version, "9.0");
  assert.equal(manifest.applications.zotero.strict_max_version, "10.0.*");
  // Zotero requires an HTTPS update_url even for manually installed plugins.
  assert.match(manifest.applications.zotero.update_url, /^https:\/\//);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version, manifest.version);
});

test("startup preserves existing preferences and initializes both menus once", async () => {
  const h = createHarness({ prefs: {
    "extensions.lgfetcher.mirrors": "https://custom.example",
    "extensions.lgfetcher.formats.pdf": false
  } });
  await h.context.startup(params, 1);
  assert.equal(h.prefs.get("extensions.lgfetcher.mirrors"), "https://custom.example");
  assert.equal(h.prefs.get("extensions.lgfetcher.formats.pdf"), false);
  assert.equal(h.prefs.get("extensions.lgfetcher.formats.epub"), true);
  assert.equal(h.registrations.length, 1);
  assert.equal(h.registrations[0].pluginID, params.id);
  assert.equal(h.registrations[0].src, "file:///plugin/preferences.xhtml");
  assert.equal(h.registrations[0].scripts[0], "file:///plugin/preferences-ui.js");

  const handler = h.window._lgFetcherCtxHandler;
  h.context.onMainWindowLoad({ window: h.window });
  assert.equal(h.window._lgFetcherCtxHandler, handler);
  assert.equal(h.document.querySelectorAll("#lgfetcher-context-menu-item").length, 1);
  assert.equal(h.document.querySelectorAll("#lgfetcher-tools-menu-item").length, 1);
  assert.equal(h.errors.length, 0);

  h.context.shutdown(params, 2);
  assert.equal(h.document.querySelector("#lgfetcher-context-menu-item"), null);
  assert.equal(h.document.querySelector("#lgfetcher-tools-menu-item"), null);
  assert.equal(h.window._lgFetcherCtxHandler, undefined);
  for (const id of ["zotero-itemmenu", "menu_ToolsPopup"]) {
    h.document.getElementById(id).dispatchEvent(new h.window.Event("popupshowing"));
  }
  assert.equal(h.document.querySelector("#lgfetcher-context-menu-item"), null);
  assert.equal(h.document.querySelector("#lgfetcher-tools-menu-item"), null);
  h.context.onMainWindowLoad({ window: h.window });
  assert.equal(h.document.querySelector("#lgfetcher-tools-menu-item"), null);
  h.dom.window.close();
});

test("context and Tools commands use selected item arrays without collection-row getters", async () => {
  const h = createHarness();
  const calls = [];
  h.context.runLGFetcher = async (window, items) => { calls.push({ window, items }); return ""; };
  await h.context.startup(params, 1);
  const first = { id: 1 };
  const second = { id: 2 };
  const popup = h.document.getElementById("zotero-itemmenu");
  h.selected.items = [first];
  popup.dispatchEvent(new h.window.Event("popupshowing"));
  h.selected.items = [second];
  const nested = h.document.createElement("div");
  popup.appendChild(nested);
  nested.dispatchEvent(new h.window.Event("popupshowing", { bubbles: true }));
  h.document.getElementById("lgfetcher-context-menu-item").dispatchEvent(new h.window.Event("command"));
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].window, h.window);
  assert.equal(calls[0].items[0], first);

  h.document.getElementById("lgfetcher-tools-menu-item").dispatchEvent(new h.window.Event("command"));
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].items[0], second);
  assert.equal(h.alerts.length, 0);
  h.context.shutdown(params, 2);
  h.dom.window.close();
});

test("menu alerts use plugin-scope XPCOM when the window exposes no Cc/Ci aliases", async () => {
  const h = createHarness();
  const alerts = [];
  h.window.Services = undefined;
  h.context.Ci.nsIPromptService = "nsIPromptService";
  h.context.Cc["@mozilla.org/embedcomp/prompt-service;1"] = {
    getService(iface) {
      assert.equal(iface, "nsIPromptService");
      return { alert: (window, title, message) => alerts.push({ window, title, message }) };
    }
  };
  h.context.runLGFetcher = async () => "Please select an item.";
  await h.context.startup(params, 1);
  h.document.getElementById("lgfetcher-tools-menu-item").dispatchEvent(new h.window.Event("command"));
  await tick();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].window, h.window);
  assert.equal(alerts[0].message, "Please select an item.");
  h.context.shutdown(params, 2);
  h.dom.window.close();
});

test("a rejected asynchronous preference registration does not prevent menu startup", async () => {
  const h = createHarness({ register: async () => { throw new Error("pane registration failed"); } });
  await h.context.startup(params, 1);
  assert.match(h.errors[0].message, /pane registration failed/);
  assert.ok(h.document.getElementById("lgfetcher-tools-menu-item"));
  assert.ok(h.document.getElementById("lgfetcher-context-menu-item"));
  h.context.shutdown(params, 2);
  h.dom.window.close();
});

test("shutdown during pending pane registration or UI initialization cannot resurrect menus", async () => {
  {
    const registration = deferred();
    const h = createHarness({ register: () => registration.promise });
    const startup = h.context.startup(params, 1);
    h.context.shutdown(params, 2);
    registration.resolve("lgfetcher-preferences");
    await startup;
    assert.deepEqual(h.unregistered, ["lgfetcher-preferences"]);
    assert.equal(h.document.getElementById("lgfetcher-tools-menu-item"), null);
    h.dom.window.close();
  }
  {
    const ready = deferred();
    const h = createHarness({ uiReadyPromise: ready.promise });
    const startup = h.context.startup(params, 1);
    await tick();
    h.context.shutdown(params, 2);
    ready.resolve();
    await startup;
    assert.equal(h.document.getElementById("lgfetcher-context-menu-item"), null);
    h.dom.window.close();
  }
});
