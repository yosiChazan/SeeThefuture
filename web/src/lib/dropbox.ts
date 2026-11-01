import { must, supabase } from './supabase';

// Dropbox, read-only: Itai's client files through the folder's shared link (SPEC
// decision 53). The app is a public client (PKCE), so it needs no secret; the key
// below is the app's public identifier. Scopes on the Dropbox side:
// files.metadata.read, files.content.read, sharing.read.
const APP_KEY = 'b7vd5tnnmgj61op';
const redirectUri = () => `${window.location.origin}/dropbox`;
const VERIFIER = 'dropbox-pkce-verifier';

export interface DropboxSettings { shared_link?: string; files?: Record<string, string> }
export interface Integration { refresh_token: string | null; settings: DropboxSettings; connected_at: string | null }
export interface DropboxFile { name: string; content_hash: string; server_modified: string; size: number }

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Step 1: send the admin to Dropbox to allow read access.
export async function startConnect() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  sessionStorage.setItem(VERIFIER, verifier);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({
    client_id: APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    token_access_type: 'offline', redirect_uri: redirectUri(),
  });
  window.location.assign(`https://www.dropbox.com/oauth2/authorize?${q}`);
}

async function token(body: Record<string, string>) {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: APP_KEY, ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Dropbox: ${json.error_description ?? json.error ?? res.status}`);
  return json as { access_token: string; refresh_token?: string };
}

// Step 2, on /dropbox: exchange the code for a long-lived refresh token and keep it.
export async function finishConnect(code: string, userId: string) {
  const verifier = sessionStorage.getItem(VERIFIER);
  if (!verifier) throw new Error('החיבור התחיל בדפדפן אחר או פג תוקפו. התחילו שוב ממסך ההגדרות');
  const t = await token({ code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirectUri() });
  sessionStorage.removeItem(VERIFIER);
  if (!t.refresh_token) throw new Error('Dropbox לא החזיר הרשאה קבועה (refresh token)');
  must(await supabase.from('integrations').upsert({
    name: 'dropbox', refresh_token: t.refresh_token, connected_by: userId, connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));
}

export async function loadDropbox(): Promise<Integration | null> {
  return must(await supabase.from('integrations').select('refresh_token, settings, connected_at').eq('name', 'dropbox').maybeSingle()) as Integration | null;
}

export async function saveSettings(settings: DropboxSettings) {
  must(await supabase.from('integrations').upsert({ name: 'dropbox', settings, updated_at: new Date().toISOString() }));
}

const accessToken = async (refresh: string) => (await token({ grant_type: 'refresh_token', refresh_token: refresh })).access_token;

async function api<T>(access: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.dropboxapi.com/2/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Dropbox ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

type Listing = { entries: ({ '.tag': string } & DropboxFile)[]; cursor: string; has_more: boolean };

// The files at the top of the shared folder (not "archive" or "other").
export async function listSharedFiles(i: Integration): Promise<DropboxFile[]> {
  if (!i.refresh_token || !i.settings.shared_link) throw new Error('צריך קודם לחבר את Dropbox ולשמור את הקישור לתיקייה, במסך ההגדרות');
  const access = await accessToken(i.refresh_token);
  let page = await api<Listing>(access, 'files/list_folder', { path: '', shared_link: { url: i.settings.shared_link } });
  const files = [...page.entries];
  while (page.has_more) { page = await api<Listing>(access, 'files/list_folder/continue', { cursor: page.cursor }); files.push(...page.entries); }
  return files.filter((f) => f['.tag'] === 'file');
}

// Downloads one file of the shared folder as a File, ready for the intake screen.
export async function downloadShared(i: Integration, name: string): Promise<File> {
  const access = await accessToken(i.refresh_token!);
  // HTTP headers carry ASCII only: other characters go as \u escapes.
  const arg = JSON.stringify({ url: i.settings.shared_link, path: `/${name}` }).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const res = await fetch('https://content.dropboxapi.com/2/sharing/get_shared_link_file', {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Dropbox-API-Arg': arg },
  });
  if (!res.ok) throw new Error(`הורדת ${name} נכשלה: ${(await res.text()).slice(0, 200)}`);
  return new File([await res.blob()], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
