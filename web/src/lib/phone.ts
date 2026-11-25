// Phone numbers in one international form (+972521234567), so that a WhatsApp message is
// matched to its client by number (SPEC decision 135). Pure, tested.

const INVISIBLE = /[‎‏⁦-⁩‪-‮ ]/g;

export interface PhoneParse { e164: string | null; extra: string[]; why?: string }

// One number: +country…, 00country…, 972…, or Israeli 0… (mobile, VoIP and landline).
export function toE164(raw: string): string | null {
  const s = raw.replace(INVISIBLE, '').trim();
  if (!s) return null;
  const plus = s.startsWith('+');
  const d = s.replace(/\D/g, '');
  if (plus) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.startsWith('00')) return d.length - 2 >= 8 && d.length - 2 <= 15 ? `+${d.slice(2)}` : null;
  if (d.startsWith('972') && (d.length === 12 || d.length === 11)) return `+${d}`;
  if (d.startsWith('0') && (d.length === 10 || d.length === 9)) return `+972${d.slice(1)}`;
  // Romanian mobiles written without "+" (40 7xx xxx xxx), Ukrainian (380…).
  if ((d.startsWith('407') && d.length === 11) || (d.startsWith('380') && d.length === 12)) return `+${d}`;
  return null;
}

// A field may hold several numbers ("0587880836   0583238008"): the first is the phone,
// the rest are kept apart for the office to place.
export function parsePhoneField(raw: string): PhoneParse {
  const s = raw.replace(INVISIBLE, '').trim();
  if (!s) return { e164: null, extra: [], why: 'ריק' };
  const whole = toE164(s);
  if (whole) return { e164: whole, extra: [] };
  const parts = s.split(/\s{2,}|[,;/|]|\s+(?=[+0])/).map((x) => x.trim()).filter(Boolean);
  const nums = parts.map(toE164);
  if (parts.length > 1 && nums.every(Boolean)) return { e164: nums[0], extra: nums.slice(1) as string[] };
  return { e164: null, extra: [], why: 'לא ברור איך לתקן' };
}
