// Reads text from a scan in the browser (SPEC decision 66): images directly, PDFs page by
// page through pdf.js. The OCR engine (tesseract.js) and its English model are fetched
// from a public CDN the first time; the scan itself never leaves this computer.
// Both libraries are loaded on demand, only when someone asks to read a document.

import { findIdNumbers, type IdCandidate } from './idnumber';

type Worker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

async function pdfPages(data: ArrayBuffer, maxPages = 3): Promise<HTMLCanvasElement[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const doc = await pdfjs.getDocument({ data }).promise;
  const out: HTMLCanvasElement[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    out.push(canvas);
  }
  return out;
}

export class IdReader {
  private worker: Promise<Worker> | null = null;

  // Paths are for tests only; the app uses tesseract.js's own CDN defaults.
  constructor(private paths: { workerPath?: string; corePath?: string; langPath?: string } = {}) {}

  private get() {
    this.worker ??= import('tesseract.js').then((t) => t.createWorker('eng', 1, this.paths));
    return this.worker;
  }

  // The ID numbers found in one file, best first.
  async read(blob: Blob): Promise<IdCandidate[]> {
    const worker = await this.get();
    const isPdf = blob.type === 'application/pdf' || new Uint8Array(await blob.slice(0, 4).arrayBuffer()).join(',') === '37,80,68,70';
    const images: (Blob | HTMLCanvasElement)[] = isPdf ? await pdfPages(await blob.arrayBuffer()) : [blob];
    let text = '';
    for (const img of images) text += `${(await worker.recognize(img)).data.text}\n`;
    return findIdNumbers(text);
  }

  async close() {
    if (this.worker) await (await this.worker).terminate();
    this.worker = null;
  }
}
