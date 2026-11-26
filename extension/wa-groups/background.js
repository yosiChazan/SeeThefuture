// Sends what the page read to the system (SPEC decision 212). The content script cannot call
// another site itself; the extension's worker can, with the key kept in its storage.
const URL_ = 'https://oqvanprfxsdonzldgtnq.supabase.co/functions/v1/wa-groups-ingest';

chrome.runtime.onMessage.addListener((msg, _sender, done) => {
  if (msg?.type !== 'send') return false;
  chrome.storage.local.get(['key'], async ({ key }) => {
    if (!key) { done({ ok: false, error: 'אין מפתח: פותחים את התוסף ומדביקים את המפתח מההגדרות במערכת' }); return; }
    try {
      const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg.payload) });
      const j = await r.json().catch(() => ({}));
      await chrome.storage.local.set({ last: { at: new Date().toISOString(), ok: r.ok, added: j.added ?? 0, error: j.error ?? null } });
      done({ ok: r.ok, ...j });
    } catch (e) {
      await chrome.storage.local.set({ last: { at: new Date().toISOString(), ok: false, error: String(e) } });
      done({ ok: false, error: String(e) });
    }
  });
  return true;   // answers later
});
