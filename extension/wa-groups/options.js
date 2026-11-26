const s = document.getElementById('s');
const show = () => chrome.storage.local.get(['key', 'last'], ({ key, last }) => {
  s.textContent = (key ? 'יש מפתח שמור. ' : 'אין מפתח. ') + (last ? `שליחה אחרונה: ${new Date(last.at).toLocaleString('he-IL')} · ${last.ok ? `נוספו ${last.added}` : `שגיאה: ${last.error}`}` : '');
});
document.getElementById('save').onclick = () => {
  const key = document.getElementById('key').value.trim();
  if (!key) return;
  chrome.storage.local.set({ key }, () => { document.getElementById('key').value = ''; show(); });
};
show();
