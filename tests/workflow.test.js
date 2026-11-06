const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHarness, installFakeFileSystem } = require("./helpers");

// A small ZIP containing an EPUB mimetype entry, for signature detection.
const EPUB_BYTES = Buffer.from("UEsDBBQAAAAAACWbZV1vYassFAAAABQAAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi9lcHViK3ppcFBLAwQUAAAAAAAlm2VdkVPT0iEAAAAhAAAAFgAAAE1FVEEtSU5GL2NvbnRhaW5lci54bWw8P3htbCB2ZXJzaW9uPSIxLjAiPz48Y29udGFpbmVyLz5QSwECFAMUAAAAAAAlm2Vdb2GrLBQAAAAUAAAACAAAAAAAAAAAAAAAgAEAAAAAbWltZXR5cGVQSwECFAMUAAAAAAAlm2VdkVPT0iEAAAAhAAAAFgAAAAAAAAAAAAAAgAE6AAAATUVUQS1JTkYvY29udGFpbmVyLnhtbFBLBQYAAAAAAgACAHoAAACPAAAAAAA=", "base64");

function item(overrides = {}) {
  const fields = {
    title: "An Example Book",
    publisher: "Example Press",
    numPages: "200",
    pages: "",
    date: "2024",
    ISBN: "",
    DOI: "",
    shortTitle: "",
    ...overrides.fields
  };
  return {
    id: 123,
    libraryID: 5,
    itemType: "book",
    isRegularItem: () => true,
    getField: name => fields[name] || "",
    getCreators: () => [{ lastName: "Smith" }],
    getAttachments: () => [],
    ...overrides,
    fields
  };
}

function fakeMirror(h, bytes, { contentType = "application/octet-stream", format = "PDF", firstChunk = bytes.length } = {}) {
  const requests = [];
  const attachments = [];
  const searchPage = `<!doctype html><html><body><table class="table">
    <tr><th>Author</th><th>Title</th><th>Publisher</th><th>Year</th><th>Pages</th><th>Format</th></tr>
    <tr><td>Alice Smith</td><td><a href="/ads.php?md5=abc">An Example Book</a></td>
    <td>Example Press</td><td>2024</td><td>200</td><td>${format}</td></tr>
  </table></body></html>`;
  const landingPage = `<!doctype html><html><body><a href="/get.php?md5=abc&amp;key=test">Get</a></body></html>`;
  h.Zotero.HTTP.request = async (method, url) => {
    requests.push([method, url]);
    if (url.includes("/index.php?req=")) return { status: 200, responseText: searchPage };
    if (url.includes("/ads.php?")) return { status: 200, responseText: landingPage };
    throw new Error(`Unexpected test URL: ${url}`);
  };
  h.window.fetch = async url => {
    requests.push(["FETCH", url]);
    let offset = 0;
    return {
      ok: true,
      url,
      headers: { get: name => name.toLowerCase() === "content-type" ? contentType : null },
      body: { getReader: () => ({
        async read() {
          if (offset >= bytes.length) return { done: true };
          const end = offset === 0 ? Math.min(firstChunk, bytes.length) : bytes.length;
          const value = new Uint8Array(bytes.subarray(offset, end));
          offset = end;
          return { done: false, value };
        },
        async cancel() {}
      }) }
    };
  };
  h.Zotero.Attachments.importFromFile = async options => {
    attachments.push({ ...options, bytes: fs.readFileSync(options.file) });
  };
  return { requests, attachments };
}

async function waitForOverlay(h) {
  for (let i = 0; i < 100; i++) {
    const overlay = h.document.getElementById("lgfetcher-options-overlay");
    if (overlay) return overlay;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`The search did not display the candidate chooser: ${JSON.stringify(h.progress)}`);
}

async function chooseDownload(h) {
  const overlay = await waitForOverlay(h);
  const radio = overlay.querySelector('input[type="radio"]');
  assert.ok(radio, "a search result should be selectable");
  radio.checked = true;
  radio.dispatchEvent(new h.window.Event("change", { bubbles: true }));
  const download = [...overlay.querySelectorAll("button")].find(button => button.textContent === "Download");
  assert.equal(download.disabled, false);
  download.click();
}

function withHarness(callback) {
  return async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lgfetcher-test-"));
    const h = createHarness({ prefs: { "extensions.lgfetcher.mirrors": "https://mirror.example" } });
    installFakeFileSystem(h, tempDir);
    try {
      await callback(h, tempDir);
    } finally {
      h.dom.window.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test("search, choose, stream, inspect, rename and import a PDF using Zotero-like APIs", withHarness(async (h, tempDir) => {
  // A synthetic PDF-like payload exercises page counting below the fallback
  // 1 MB size threshold used for a 200-page book.
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n1 0 obj << /Type /Pages /Count 200 >> endobj\n"),
    Buffer.alloc(6000, 32)
  ]);
  const { requests, attachments } = fakeMirror(h, bytes);
  const originalOpenDialog = h.window.openDialog;
  assert.equal(h.window.Cc, undefined);
  assert.equal(h.window.Ci, undefined);
  const run = h.context.runLGFetcher(h.window, [item()]);
  await chooseDownload(h);
  const result = await run;

  assert.match(result, /SUCCESS \(mirror\.example\)/);
  assert.equal(h.window.openDialog, originalOpenDialog);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].parentItemID, 123);
  assert.equal(attachments[0].title, "Smith - 2024 - An Example Book.pdf");
  assert.deepEqual(attachments[0].bytes, bytes);
  assert.ok(h.progress.some(message => message.includes("Detected 200 pages")));
  assert.ok(requests.some(([method, url]) => method === "FETCH" && url.includes("get.php")));
  assert.deepEqual(fs.readdirSync(tempDir), []);
}));

test("a generic PDF response can split its header across streaming chunks", withHarness(async h => {
  const bytes = Buffer.concat([
    Buffer.from("    %PDF-1.7\n1 0 obj << /Type /Pages /Count 200 >> endobj\n"),
    Buffer.alloc(6000, 32)
  ]);
  const { attachments } = fakeMirror(h, bytes, { firstChunk: 4 });
  const run = h.context.runLGFetcher(h.window, [item()]);
  await chooseDownload(h);
  assert.match(await run, /SUCCESS/);
  assert.equal(attachments.length, 1);
  assert.deepEqual(attachments[0].bytes, bytes);
}));

test("an EPUB-signature archive is attached with the EPUB extension", withHarness(async h => {
  const bytes = EPUB_BYTES;
  const { attachments } = fakeMirror(h, bytes, { format: "EPUB" });
  const run = h.context.runLGFetcher(h.window, [item()]);
  await chooseDownload(h);
  assert.match(await run, /SUCCESS/);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].title, "Smith - 2024 - An Example Book.epub");
  assert.deepEqual(attachments[0].bytes, bytes);
}));

test("a ZIP signature takes precedence over a misleading PDF catalog format", withHarness(async h => {
  const { attachments } = fakeMirror(h, EPUB_BYTES, { format: "PDF" });
  const run = h.context.runLGFetcher(h.window, [item()]);
  await chooseDownload(h);
  assert.match(await run, /SUCCESS/);
  assert.equal(attachments.length, 1);
  assert.ok(attachments[0].title.endsWith(".epub"));
  assert.deepEqual(attachments[0].bytes, EPUB_BYTES);
}));

test("an HTML error page served as generic binary is never imported", withHarness(async h => {
  const bytes = Buffer.from("    <!doctype html><html><body>Access denied</body></html>");
  const { attachments } = fakeMirror(h, bytes, { firstChunk: 4 });
  const run = h.context.runLGFetcher(h.window, [item()]);
  await chooseDownload(h);
  const result = await run;
  assert.match(result, /returned an HTML page instead of a document/);
  assert.equal(attachments.length, 0);
}));

test("an HTML error page with a UTF-8 BOM and leading comment is rejected", withHarness(async h => {
  const bytes = Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from("  <!-- blocked -->\n<html><body>Access denied</body></html>")
  ]);
  const { attachments } = fakeMirror(h, bytes, { firstChunk: 3 });
  const run = h.context.runLGFetcher(h.window, [item()]);
  await chooseDownload(h);
  assert.match(await run, /returned an HTML page instead of a document/);
  assert.equal(attachments.length, 0);
}));

test("a short review PDF is rejected instead of attached to a book", withHarness(async h => {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n1 0 obj << /Type /Pages /Count 3 >> endobj\n"),
    Buffer.alloc(6000, 32)
  ]);
  const { attachments } = fakeMirror(h, bytes);
  const run = h.context.runLGFetcher(h.window, [item()]);
  await chooseDownload(h);
  const result = await run;
  assert.match(result, /rejected as a short review/);
  assert.equal(attachments.length, 0);
}));

test("cancelling the chooser does not download or attach anything", withHarness(async h => {
  const { requests, attachments } = fakeMirror(h, Buffer.from("%PDF-1.7 test"));
  const run = h.context.runLGFetcher(h.window, [item()]);
  const overlay = await waitForOverlay(h);
  const cancel = [...overlay.querySelectorAll("button")].find(button => button.textContent === "Cancel");
  cancel.click();
  assert.equal(await run, "");
  assert.equal(h.document.getElementById("lgfetcher-options-overlay"), null);
  assert.equal(requests.some(([method]) => method === "FETCH"), false);
  assert.equal(attachments.length, 0);
}));

test("preflight reports invalid selection and disabled settings", withHarness(async h => {
  assert.match(await h.context.runLGFetcher(h.window, []), /select one item/i);
  assert.match(await h.context.runLGFetcher(h.window, [item(), item()]), /only one item/i);
  h.prefs.set("extensions.lgfetcher.mirrors", "");
  assert.match(await h.context.runLGFetcher(h.window, [item()]), /No LibGen mirror URLs/);
  h.prefs.set("extensions.lgfetcher.mirrors", "https://mirror.example");
  for (const format of ["pdf", "epub", "djvu", "mobi"]) {
    h.prefs.set(`extensions.lgfetcher.formats.${format}`, false);
  }
  assert.match(await h.context.runLGFetcher(h.window, [item()]), /No file types are enabled/);
}));
