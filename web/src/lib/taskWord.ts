// A task as a Word document (SPEC decisions 171, 174): the card as it is on the screen - its
// details, what it is linked to, who handles it, the replies as a tree with "טופל", and the
// history - right to left, with the replies' pictures inside it. A real .docx (Office Open XML,
// zipped with fflate), which every Word version opens with its pictures. Pure, tested.
import { strToU8, zipSync } from 'fflate';
import { splitLinks } from './links.ts';

export interface WordReply { who: string; at: string; body: string | null; edited: boolean; files: number; images?: string[]; open: boolean; resolved: { who: string; at: string; body: string | null } | null; children: WordReply[] }
export interface WordTask {
  subject: string; status: string; priority: string; trigger: string | null; category: string | null; series: string | null;
  author: string; created: string; body: string | null; links: string[]; assignees: string[];
  replies: WordReply[]; openBranches: number; history: { who: string; what: string; at: string; body: string | null }[];
}
// A picture: its name (as in WordReply.images), its kind, its bytes and its size in pixels.
export interface WordImage { name: string; ext: 'png' | 'jpeg' | 'gif'; bytes: Uint8Array; width: number; height: number }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface RunStyle { bold?: boolean; color?: string; size?: number }
function run(text: string, s: RunStyle = {}, link = false): string {
  const pr = `<w:rPr>${link ? '<w:rStyle w:val="Hyperlink"/>' : ''}<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>${s.bold ? '<w:b/><w:bCs/>' : ''}${s.color ? `<w:color w:val="${s.color}"/>` : link ? '<w:color w:val="1C7ED6"/><w:u w:val="single"/>' : ''}${s.size ? `<w:sz w:val="${s.size}"/><w:szCs w:val="${s.size}"/>` : ''}<w:rtl/></w:rPr>`;
  return text.split('\n').map((line, i) => `${i ? `<w:r>${pr}<w:br/></w:r>` : ''}<w:r>${pr}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`).join('');
}

class Doc {
  body: string[] = [];
  rels: string[] = [];
  media: Record<string, Uint8Array> = {};
  private n = 0;
  private origin: string;
  private images: Map<string, WordImage>;
  constructor(origin: string, images: Map<string, WordImage>) { this.origin = origin; this.images = images; }
  private rel(type: string, target: string, external = false) {
    const id = `rId${100 + ++this.n}`;
    this.rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return id;
  }
  // Text with its links clickable; an address inside the system opens on the site.
  linked(text: string, s: RunStyle = {}): string {
    return splitLinks(text).map((p) => ('url' in p
      ? `<w:hyperlink r:id="${this.rel('hyperlink', p.url.startsWith('/') ? this.origin + p.url : p.url, true)}">${run(p.label ?? p.url, s, true)}</w:hyperlink>`
      : run(p.text, s))).join('');
  }
  // indent: from the right edge (twips); bar: a line on the right in this color.
  p(runs: string, o: { indent?: number; bar?: string; box?: boolean; heading?: number; after?: number } = {}) {
    const bdr = o.box ? '<w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="4" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="4" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="4" w:color="CCCCCC"/></w:pBdr>'
      : o.heading === 2 ? '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="CCCCCC"/></w:pBdr>'
      : o.bar ? `<w:pBdr><w:right w:val="single" w:sz="12" w:space="6" w:color="${o.bar}"/></w:pBdr>` : '';
    const spacing = `<w:spacing w:before="${o.heading === 2 ? 280 : 0}" w:after="${o.after ?? 60}"/>`;
    this.body.push(`<w:p><w:pPr><w:keepLines/>${bdr}${spacing}${o.indent ? `<w:ind w:right="${o.indent}"/>` : ''}<w:bidi/><w:jc w:val="left"/></w:pPr>${runs}</w:p>`);
  }
  image(name: string): string {
    const im = this.images.get(name);
    if (!im) return '';
    const file = `media/image${Object.keys(this.media).length + 1}.${im.ext}`;
    this.media[`word/${file}`] = im.bytes;
    const id = this.rel('image', file);
    const maxW = 4572000; // 12.7 cm
    const cx = Math.min(maxW, Math.round(im.width * 9525));
    const cy = Math.round(cx * (im.height / Math.max(1, im.width)));
    const k = Object.keys(this.media).length;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${k}" name="תמונה ${k}"/>`
      + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${k}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
      + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }
}

function reply(d: Doc, r: WordReply, depth: number) {
  const indent = depth * 360;
  const bar = depth ? 'CCCCCC' : '999999';
  d.p(run(r.who, { bold: true }) + run(` ${r.at}${r.edited ? ' · נערך' : ''}`, { color: '777777' }) + (r.open ? run(' · בטיפול', { color: 'D9480F' }) : ''), { indent, bar, after: 0 });
  if (r.body) d.p(d.linked(r.body), { indent, bar, after: 0 });
  for (const name of r.images ?? []) d.p(d.image(name), { indent, bar, after: 0 });
  const missing = r.files - (r.images?.length ?? 0);
  if (missing > 0) d.p(run(`${missing} תמונות לא נטענו (במערכת)`, { color: '777777' }), { indent, bar, after: 0 });
  d.p('', { after: 0 });
  for (const c of r.children) reply(d, c, depth + 1);
  if (r.resolved) {
    d.p(run('✓ טופל', { bold: true, color: '2B8A3E' }) + run(` · ${r.resolved.who} · ${r.resolved.at}`, { color: '2B8A3E' }), { indent: indent + 360, bar: '2B8A3E', after: 0 });
    if (r.resolved.body) d.p(d.linked(r.resolved.body), { indent: indent + 360, bar: '2B8A3E', after: 0 });
    d.p('', { after: 0 });
  }
}

// The document's parts (paths inside the zip and their contents).
export function taskDocxParts(t: WordTask, origin: string, images: WordImage[] = []): Record<string, Uint8Array> {
  const d = new Doc(origin, new Map(images.map((i) => [i.name, i])));
  d.p(run(t.subject, { bold: true, size: 36 }), { after: 80 });
  d.p(run([`מצב: ${t.status}`, `עדיפות: ${t.priority}`, t.trigger, t.series, t.category].filter(Boolean).join(' · ')));
  d.p(run(`נפתחה ע"י ${t.author}, ${t.created}`, { color: '777777' }));
  if (t.body) d.p(d.linked(t.body), { box: true, after: 120 });
  d.p(run('קשור ל: ', { bold: true }) + run(t.links.length ? t.links.join(', ') : '—'));
  d.p(run('בטיפול של: ', { bold: true }) + run(t.assignees.length ? t.assignees.join(', ') : '—'));
  if (t.replies.length) {
    d.p(run(`תגובות${t.openBranches ? ` (${t.openBranches} ${t.openBranches === 1 ? 'ענף' : 'ענפים'} בטיפול)` : ' (כל הענפים טופלו)'}`, { bold: true, size: 26 }), { heading: 2, after: 120 });
    for (const r of t.replies) reply(d, r, 0);
  }
  if (t.history.length) {
    d.p(run('היסטוריה', { bold: true, size: 26 }), { heading: 2, after: 120 });
    for (const h of t.history) d.p(run(h.who, { bold: true }) + run(` ${h.what} `) + run(`· ${h.at}`, { color: '777777' }) + (h.body ? run('\n') + d.linked(h.body) : ''));
  }
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${d.body.join('')}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>';
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:bidi="he-IL"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:bidi/><w:spacing w:after="60" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1C7ED6"/><w:u w:val="single"/></w:rPr></w:style></w:styles>';
  const exts = [...new Set(images.map((i) => i.ext))];
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + exts.map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + d.rels.join('') + '</Relationships>';
  return {
    '[Content_Types].xml': strToU8(types), '_rels/.rels': strToU8(rootRels),
    'word/document.xml': strToU8(document), 'word/styles.xml': strToU8(styles), 'word/_rels/document.xml.rels': strToU8(docRels),
    ...d.media,
  };
}

export function taskDocx(t: WordTask, origin: string, images: WordImage[] = []): Uint8Array {
  return zipSync(taskDocxParts(t, origin, images));
}
