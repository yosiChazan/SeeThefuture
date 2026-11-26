// Reads WhatsApp Web as it is on the screen (SPEC decision 212). Never clicks, never types:
//  · the chat list: the last line of each group (a group's line names who wrote it);
//  · a group open on the screen: every message shown, with WhatsApp's own id, who and when,
//    the pictures shown (as they are on the screen) and the names of files.
// Only groups: one-to-one chats reach the system through the WhatsApp connection.
(() => {
  const sent = new Set();
  let queue = [];
  let timer = null;

  const flush = () => {
    timer = null;
    if (!queue.length) return;
    const messages = queue.splice(0, 200);
    const groups = [...new Map(messages.map((m) => [m.group, { title: m.group, jid: m.jid || null }])).values()];
    chrome.runtime.sendMessage({ type: 'send', payload: { groups, messages } }, (r) => {
      if (chrome.runtime.lastError || !r?.ok) messages.forEach((m) => sent.delete(m.wa_id || m.preview_key));   // try again next time
    });
    if (queue.length) timer = setTimeout(flush, 1500);
  };
  const push = (m) => {
    const k = m.wa_id || m.preview_key;
    if (!k || sent.has(k)) return;
    sent.add(k);
    queue.push(m);
    if (!timer) timer = setTimeout(flush, 2000);
  };
  const text = (el) => (el ? el.innerText.replace(/\s+\n/g, '\n').trim() : '');
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  // A picture on the screen, as base64 (the page's own copy; nothing is downloaded).
  async function picture(img) {
    try {
      if (!img || !img.src || !img.complete || img.naturalWidth < 60) return null;
      const c = document.createElement('canvas');
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85).split(',')[1];
    } catch { return null; }
  }

  // The open chat: its rows carry ids like "false_1203…@g.us_3EB0…_9725…@c.us"; "@g.us" is a group.
  async function readOpen() {
    const main = document.querySelector('#main');
    if (!main) return;
    const title = text(main.querySelector('header span[dir="auto"]'));
    if (!title) return;
    for (const row of main.querySelectorAll('[data-id]')) {
      const id = row.getAttribute('data-id') || '';
      if (!id.includes('@g.us')) continue;
      if (sent.has(id)) continue;
      const jid = (/_(\d+(?:-\d+)?@g\.us)_/.exec(id) || [])[1] || null;
      const meta = row.querySelector('[data-pre-plain-text]');
      const pre = meta ? meta.getAttribute('data-pre-plain-text') : '';   // "[13:05, 26.11.2026] Dana: "
      const sender = (/\]\s*(.*?):\s*$/.exec(pre) || [])[1] || (id.startsWith('true_') ? 'אני' : null);
      const body = text(row.querySelector('span.selectable-text')) || null;
      const img = [...row.querySelectorAll('img')].find((i) => /^blob:|^data:image/.test(i.src) && i.naturalWidth >= 60);
      const file = [...row.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).find((t) => /\.\w{2,5}$/.test(t || ''));
      const kind = img ? 'image' : file ? 'document' : body ? 'text' : 'other';
      if (kind === 'other') continue;
      push({ group: title, jid, wa_id: id, sender, body, sent_at_text: (/\[(.*?)\]/.exec(pre) || [])[0] || null, kind,
        file_name: file ? file.replace(/^(הורדה|Download)\s*"?|"$/g, '') : null, image: img ? await picture(img) : null });
    }
  }

  // The chat list: a group's last line starts with who wrote it, in a span of its own ("Dana:").
  function readList() {
    const side = document.querySelector('#pane-side');
    if (!side) return;
    for (const item of side.querySelectorAll('[role="listitem"], [role="row"]')) {
      const spans = [...item.querySelectorAll('span[title]')];
      if (spans.length < 2) continue;
      const title = spans[0].getAttribute('title');
      const last = spans[spans.length - 1];
      const author = [...last.parentElement.querySelectorAll('span')].find((s) => /[:：]\s*$/.test(s.textContent || '') && s !== last);
      if (!title || !author) continue;
      const body = last.getAttribute('title');
      const time = text(item.querySelector('[role="gridcell"] > div:last-child, div[class*="time"]')) || '';
      push({ group: title, preview_key: `${title}|${hash(author.textContent + body + time)}`, sender: author.textContent.replace(/[:：]\s*$/, '').trim(), body, sent_at_text: null, kind: 'text' });
    }
  }

  let busy = false;
  const scan = async () => { if (busy) return; busy = true; try { readList(); await readOpen(); } finally { busy = false; } };
  new MutationObserver(() => { clearTimeout(scan.t); scan.t = setTimeout(scan, 800); }).observe(document.body, { childList: true, subtree: true });
  setInterval(scan, 15000);
  setTimeout(scan, 1500);
})();
