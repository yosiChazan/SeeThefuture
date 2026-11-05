import { supabase } from './supabase';

// PDF and Office files open in Google's document viewer instead of downloading (SPEC
// decision 105). The viewer reads the file through a temporary signed link (10 minutes);
// images and other files open as they are.

const VIEWABLE = /\.(pdf|docx?|xlsx?|pptx?|rtf|odt)$/i;
export const inViewer = (name: string) => VIEWABLE.test(name);
export const viewerUrl = (signedUrl: string, embedded = false) =>
  `https://docs.google.com/viewer?url=${encodeURIComponent(signedUrl)}${embedded ? '&embedded=true' : ''}`;

// The link to open a stored document: Google's viewer for documents, the file itself otherwise.
export async function documentLink(storagePath: string, fileName?: string | null): Promise<{ url?: string; error?: string }> {
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(storagePath, 600);
  if (error) return { error: error.message };
  return { url: inViewer(fileName || storagePath) ? viewerUrl(data.signedUrl) : data.signedUrl };
}
