// Reads text from a photo or screenshot of a bill using Tesseract OCR.
// The English language data ships with npm (@tesseract.js-data/eng), so this works offline with no API key.
const path = require('path');
const { createWorker } = require('tesseract.js');

const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

let workerPromise = null;

// One shared worker, created on first use (it takes a second or two to start).
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, { langPath: LANG_PATH, gzip: true, cacheMethod: 'none' })
      .then(async (worker) => {
        // Treat the image as one block of text and keep column spacing, which suits receipts.
        await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        return worker;
      })
      .catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

async function readReceiptImage(buffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer);
  return data.text;
}

// Stop the background OCR worker (used by tests so Node can exit).
async function closeOcr() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  if (worker) await worker.terminate();
}

module.exports = { readReceiptImage, closeOcr };
