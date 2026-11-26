// A Word document as the adapters see it (SPEC decision 207): its paragraphs, each with its runs
// of text and the highlight colour of each run ("green", "darkYellow"…; null: none). Ofir marks
// every amount with a colour that says what it is, so the colour is part of the data.
// Pure: reads the XML of word/document.xml with regular expressions, so it runs in the browser
// and in the tests alike.

export interface DocRun { text: string; mark: string | null }
export interface DocParagraph { text: string; runs: DocRun[] }
export interface Doc { paragraphs: DocParagraph[] }

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function docFromXml(xml: string): Doc {
  const paragraphs: DocParagraph[] = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const runs: DocRun[] = [];
    for (const r of p.match(/<w:r[ >][\s\S]*?<\/w:r>/g) ?? []) {
      const text = unescape([...r.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br)\/>/g)].map((m) => m[1] ?? ' ').join(''));
      if (!text) continue;
      const mark = /<w:highlight w:val="(\w+)"/.exec(r)?.[1] ?? null;
      const last = runs[runs.length - 1];
      // Word splits a number into several runs ("3" "00 רון"): runs of one colour are one.
      if (last && last.mark === (mark === 'none' ? null : mark)) last.text += text;
      else runs.push({ text, mark: mark === 'none' ? null : mark });
    }
    const text = runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
    if (text) paragraphs.push({ text, runs });
  }
  return { paragraphs };
}

// A .docx file in the browser: the ZIP's word/document.xml.
export async function docFromDocx(data: ArrayBuffer): Promise<Doc> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(data), { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('הקובץ אינו מסמך Word (docx)');
  return docFromXml(strFromU8(xml));
}
