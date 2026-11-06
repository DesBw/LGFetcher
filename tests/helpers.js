const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const BOOTSTRAP = fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="zotero-itemmenu"></div><div id="menu_ToolsPopup"></div>
  </body></html>`, { url: "https://zotero-test.invalid/" });
  const window = dom.window;
  const document = window.document;
  document.createXULElement = name => document.createElementNS(
    "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", name
  );
  const selected = { items: [] };
  const prefs = new Map(Object.entries(options.prefs || {}));
  const registrations = [];
  const unregistered = [];
  const errors = [];
  const alerts = [];
  const progress = [];
  const dialogs = [];
  const windows = [window];

  const Zotero = {
    Prefs: {
      get(name, global) {
        if (!global) throw new Error(`Expected a global preference: ${name}`);
        return prefs.get(name);
      },
      set(name, value, global) {
        if (!global) throw new Error(`Expected a global preference: ${name}`);
        prefs.set(name, value);
      }
    },
    PreferencePanes: {
      async register(config) {
        registrations.push(config);
        if (options.register) return options.register(config);
        return config.id;
      },
      unregister(id) { unregistered.push(id); }
    },
    uiReadyPromise: options.uiReadyPromise || Promise.resolve(),
    getMainWindows: () => windows,
    getActiveZoteroPane: () => window.ZoteroPane,
    logError: error => errors.push(error),
    debug: message => progress.push(String(message)),
    ProgressWindowSet: { tile() {} },
    HTTP: { request: async () => { throw new Error("Unexpected HTTP request"); } },
    Items: { get: () => null },
    Attachments: { importFromFile: async () => { throw new Error("Unexpected attachment import"); } }
  };
  Zotero.ProgressWindow = function ({ window: parent }) {
    this.changeHeadline = text => progress.push(text);
    this.show = () => {
      this.nativeWindow = parent.openDialog("chrome://zotero/content/progressWindow.xhtml");
    };
    this.close = () => { if (this.nativeWindow) this.nativeWindow.close(); };
    this.ItemProgress = function (icon, text) {
      progress.push(text);
      this.setText = value => progress.push(value);
    };
  };

  window.Zotero = Zotero;
  window.ZoteroPane = { getSelectedItems: () => selected.items };
  window.Services = { prompt: { alert: (parent, title, text) => alerts.push(text) } };
  window.alert = text => alerts.push(text);
  window.fetch = async () => { throw new Error("Unexpected fetch"); };
  window.openDialog = url => {
    const dialog = {
      url,
      closed: false,
      document: { getElementById: () => null },
      addEventListener() {},
      sizeToContent() {},
      close() { this.closed = true; }
    };
    dialogs.push(dialog);
    return dialog;
  };
  // Don't leave the production five-second close timer running after a test.
  window.setTimeout = (callback, delay, ...args) => {
    const timer = setTimeout(callback, delay, ...args);
    timer.unref();
    return timer;
  };
  window.clearTimeout = clearTimeout;

  const Cc = {};
  const Ci = {};
  const context = vm.createContext({ Zotero, Cc, Ci, console, setTimeout, clearTimeout, btoa: value => Buffer.from(value, "binary").toString("base64") });
  vm.runInContext(BOOTSTRAP, context, { filename: "bootstrap.js" });
  return { context, window, document, Zotero, prefs, registrations, unregistered, errors, alerts, progress, dialogs, selected, windows, dom };
}

function installFakeFileSystem(harness, tempDir) {
  class File {
    constructor(filePath = "") { this.path = filePath; }
    initWithPath(filePath) { this.path = filePath; }
    append(name) { this.path = path.join(this.path, name); }
    moveTo(dir, name) {
      const newPath = path.join(dir ? dir.path : path.dirname(this.path), name);
      fs.renameSync(this.path, newPath);
      this.path = newPath;
    }
    remove() { fs.unlinkSync(this.path); }
    get fileSize() { return fs.statSync(this.path).size; }
  }
  class FileOutput {
    init(file) { this.fd = fs.openSync(file.path, "w"); }
    close() { if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; } }
  }
  class BinaryOutput {
    setOutputStream(stream) { this.stream = stream; }
    writeByteArray(bytes) { fs.writeSync(this.stream.fd, Buffer.from(bytes)); }
    close() { this.stream.close(); }
  }
  class FileInput {
    init(file) { this.bytes = fs.readFileSync(file.path); }
    available() { return this.bytes.length; }
    close() {}
  }
  class BinaryInput {
    setInputStream(stream) { this.stream = stream; }
    readBytes(count) { return this.stream.bytes.subarray(0, count).toString("latin1"); }
    close() {}
  }
  const Ci = {
    nsIFile: "nsIFile",
    nsIFileOutputStream: "nsIFileOutputStream",
    nsIBinaryOutputStream: "nsIBinaryOutputStream",
    nsIFileInputStream: "nsIFileInputStream",
    nsIBinaryInputStream: "nsIBinaryInputStream"
  };
  const contracts = {
    "@mozilla.org/file/local;1": [Ci.nsIFile, File],
    "@mozilla.org/network/file-output-stream;1": [Ci.nsIFileOutputStream, FileOutput],
    "@mozilla.org/binaryoutputstream;1": [Ci.nsIBinaryOutputStream, BinaryOutput],
    "@mozilla.org/network/file-input-stream;1": [Ci.nsIFileInputStream, FileInput],
    "@mozilla.org/binaryinputstream;1": [Ci.nsIBinaryInputStream, BinaryInput]
  };
  const Cc = Object.fromEntries(Object.entries(contracts).map(([name, [expected, Constructor]]) => [
    name,
    { createInstance(iface) {
      if (iface !== expected) throw new Error(`${name} does not implement ${iface}`);
      return new Constructor();
    } }
  ]));
  // Zotero's plugin sandbox exposes Cc/Ci even when the main window doesn't.
  harness.context.Cc = Cc;
  harness.context.Ci = Ci;
  harness.Zotero.File = { pathToFile: filePath => new File(filePath) };
  harness.Zotero.getTempDirectory = () => new File(tempDir);
}

module.exports = { ROOT, createHarness, deferred, installFakeFileSystem };
