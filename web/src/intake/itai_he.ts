// Hebrew for the recurring phrases of Itai's file, so the office reads "דמי ניהול
// ינואר 2026" instead of "jan.2026 management commision". Anything not in the list
// stays as written; the original text is always kept next to the translation.

const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "2026-01-01" → "ינואר 2026"
export const monthHe = (period: string) => `${MONTHS_HE[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

// Longer phrases first, so "broker fee for finding new tenant" wins over "broker fee".
const PHRASES: [RegExp, string | ((m: string) => string)][] = [
  // Lease notes: "starting 09.07.2026 ctr. prolonged for one year, rent increased from 400 EUR to 425 EUR"
  [/rent increased from (\d+) EUR to (\d+) EUR/gi, 'השכירות עלתה מ-$1 € ל-$2 €'],
  [/ctr\.? prolonged for one year/gi, 'החוזה הוארך בשנה'],
  [/\bstarting (\d{2}\.\d{2}\.\d{4})/gi, 'החל מ-$1'],
  [/management\s+(commission|commision|fee)s?/gi, 'דמי ניהול'],
  [/rent income tax withheld as per law[^,;]*/gi, 'מס הכנסה על השכירות שנוכה במקור (8%)'],
  [/repairs fund paid by the tenant/gi, 'קרן תיקונים של הבניין, שולם על ידי השוכר'],
  [/repairs fund/gi, 'קרן תיקונים של הבניין'],
  [/\brent \(([\d\s,-]+)\) as per ctr\.?\s*(\d+) from (\d{2}\.\d{2}\.\d{4})/gi, 'שכירות ($1) לפי חוזה $2 מ-$3'],
  [/transfer to new wise account/gi, 'העברה לחשבון WISE החדש'],
  [/fee for obtaining ghiseul\.ro credentials/gi, 'עמלה על פתיחת גישה ל-ghiseul.ro'],
  [/\bperiod\b/gi, 'תקופה'],
  [/broker fee for finding (a )?new tenant/gi, 'דמי תיווך על מציאת שוכר חדש'],
  [/broker fee/gi, 'דמי תיווך'],
  [/issuing of invoices in smar?t?bill/gi, 'הפקת חשבוניות ב-SmartBill'],
  [/translation of general poa/gi, 'תרגום ייפוי כוח כללי'],
  [/duplicate of entrance key for new tenant/gi, 'שכפול מפתח כניסה לשוכר חדש'],
  [/duplicate of (the )?entrance key/gi, 'שכפול מפתח כניסה'],
  [/deposit for unexpected works/gi, 'פיקדון לעבודות לא צפויות'],
  [/heating system repair/gi, 'תיקון מערכת החימום'],
  [/toilet system replacement/gi, 'החלפת מערכת השירותים'],
  [/toilet replacement/gi, 'החלפת אסלה'],
  [/toilet repair/gi, 'תיקון שירותים'],
  [/central heating/gi, 'חימום מרכזי'],
  [/new electric counter/gi, 'מונה חשמל חדש'],
  [/electric boiler/gi, 'דוד חשמל'],
  [/\bac check and repair\b/gi, 'בדיקה ותיקון מזגן'],
  [/\bac (check|repair)\b/gi, (m) => (/check/i.test(m) ? 'בדיקת מזגן' : 'תיקון מזגן')],
  [/sewage repair/gi, 'תיקון ביוב'],
  [/disinfection( against co[ac]+kroaches)?/gi, 'חיטוי נגד מזיקים'],  // "coakroaches" in the file
  [/materials for/gi, 'חומרים ל'],
  [/supervision/gi, 'פיקוח'],
  [/\bexpenses\b/gi, 'הוצאות'],
  [/\butilities\b/gi, 'חשבונות'],
  [/\bdeposit\b/gi, 'פיקדון'],
  [/\brent\b/gi, 'שכירות'],
  [/\bctr\.\s*/gi, 'חוזה '],
  // Romanian receipts: ff = factura fiscală (invoice), bf = bon fiscal (till receipt).
  [/\bff\b/gi, 'חשבונית'],
  [/\bbf\b/gi, 'קבלה'],
];

// "apr. - jun.2025" → "אפריל–יוני 2025"; "jan.2026" → "ינואר 2026".
function months(s: string): string {
  const m = (x: string) => MONTHS_HE[MON.indexOf(x.toLowerCase().slice(0, 3))];
  return s
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*-\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(20\d\d)/gi,
      (_, a, b, y) => `${m(a)}–${m(b)} ${y}`)
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(20\d\d)/gi, (_, a, y) => `${m(a)} ${y}`);
}

export function itaiHebrew(s: string): string {
  let out = months(s.trim());
  for (const [re, he] of PHRASES) out = typeof he === 'string' ? out.replace(re, he) : out.replace(re, he);
  // "ינואר 2026 דמי ניהול" reads better as "דמי ניהול ינואר 2026".
  out = out.replace(/^([א-ת]+(?:–[א-ת]+)? 20\d\d)\s+(.+)$/, '$2 $1');
  return out.replace(/\s+/g, ' ').trim();
}
