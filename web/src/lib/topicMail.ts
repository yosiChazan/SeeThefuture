// The e-mail draft that tells an employee about a topic assigned to them (SPEC decision 92).
// The topic stays visible to every staff member; the mail is only a heads-up, sent by the
// sender from their own mailbox. Pure, tested.

const NAMED = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g;
const full = (url: string, origin: string) => (url.startsWith('/') ? origin + url : url);

export interface TopicMailInput { title: string; notes: string | null; fixUrl: string | null; to: string; from: string; origin: string }

export function topicMail({ title, notes, fixUrl, to, from, origin }: TopicMailInput): { subject: string; body: string } {
  // A mail is plain text: a named link becomes "name: address".
  const text = (notes ?? '').trim().replace(NAMED, (_, name: string, url: string) => `${name}: ${full(url, origin)}`);
  const open = `${origin}/completeness?g=manual&q=${encodeURIComponent(title)}`;
  const lines = [
    `שלום ${to},`, '',
    `${from} שלח/ה אליך נושא במערכת: ${title}`,
    ...(text ? ['', text] : []),
    ...(fixUrl ? ['', `קישור לתיקון: ${full(fixUrl, origin)}`] : []),
    '', `לצפייה, לתשובה ולסימון "בוצע": ${open}`, '', 'תודה',
  ];
  return { subject: `נושא חדש: ${title}`, body: lines.join('\n') };
}

export const gmailLink = (email: string, subject: string, body: string) =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
export const mailtoLink = (email: string, subject: string, body: string) =>
  `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
