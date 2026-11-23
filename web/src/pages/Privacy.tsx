import { Anchor, Container, Divider, List, Stack, Text, Title } from '@mantine/core';

// The public privacy policy (SPEC decision 180), at /privacy, without signing in: Meta asks for
// one for the WhatsApp app. In Hebrew and in English (Meta's reviewers read the English).

const CONTACT_PHONE = '+972 55-775-0300';
const CONTACT_EMAIL = 'yossi@bhrei.net';
const UPDATED = '23.11.2026';

export function Privacy() {
  return (
    <Container size="md" py="xl">
      <Stack gap="md">
        <div dir="rtl">
          <Title order={1} mb="xs">מדיניות פרטיות</Title>
          <Text c="dimmed" size="sm" mb="md">See the Future LTD · עודכן {UPDATED}</Text>
          <Stack gap="sm">
            <Text>See the Future LTD ("החברה") מלווה לקוחות שמחזיקים דירות באוקראינה, רומניה, גאורגיה ויוון. המערכת הפנימית של החברה משמשת את עובדי המשרד בלבד, כדי לנהל את הנתונים של הלקוחות ולענות להם.</Text>
            <Title order={3}>איזה מידע נאסף</Title>
            <List spacing={4}>
              <List.Item>פרטי לקוחות: שם, טלפון, מייל, הנכסים והתנועות הכספיות שלהם, כפי שהלקוח או המנהלים המקומיים מסרו.</List.Item>
              <List.Item>הודעות וואטסאפ: כשלקוח או כל אדם אחר כותב למספר הוואטסאפ של החברה, נשמרים מספר הטלפון שלו, השם שמופיע בוואטסאפ, תוכן ההודעה וקבצים שצירף, וגם התשובות שלנו.</List.Item>
            </List>
            <Title order={3}>למה</Title>
            <Text>רק כדי לענות לפונים, לשייך פנייה ללקוח הנכון ולתת שירות. איננו שולחים הודעות שיווקיות, ואיננו משתמשים במידע לפרסום.</Text>
            <Title order={3}>עם מי המידע משותף</Title>
            <Text>המידע לא נמכר ולא מועבר לאף גורם. הוא נשמר אצל ספקי תשתית שהחברה משתמשת בהם להפעלת המערכת (שרתי ענן ומסד נתונים, ו-WhatsApp Business Platform של Meta להעברת ההודעות), תחת תנאי השימוש שלהם.</Text>
            <Title order={3}>אבטחה ושמירה</Title>
            <Text>הגישה למערכת מוגבלת לעובדי החברה, עם סיסמה ואימות דו-שלבי, וכל עובד רואה רק את מה שנדרש לעבודתו. המידע נשמר כל עוד הוא נחוץ לשירות או כפי שהחוק מחייב.</Text>
            <Title order={3}>הזכויות שלך</Title>
            <Text>אפשר לבקש לראות את המידע שנשמר עליך, לתקן אותו או למחוק אותו, במייל ל-<Anchor href={`mailto:${CONTACT_EMAIL}`} dir="ltr">{CONTACT_EMAIL}</Anchor> או בהודעת וואטסאפ למספר <Anchor href="https://wa.me/972557750300" dir="ltr">{CONTACT_PHONE}</Anchor>. כדי להפסיק לקבל מאיתנו הודעות, אפשר לכתוב "הסר" או לחסום את המספר.</Text>
          </Stack>
        </div>

        <Divider my="lg" />

        <div dir="ltr" style={{ textAlign: 'left' }}>
          <Title order={1} mb="xs">Privacy Policy</Title>
          <Text c="dimmed" size="sm" mb="md">See the Future LTD · Updated {UPDATED}</Text>
          <Stack gap="sm">
            <Text>See the Future LTD ("the Company") assists clients who own apartments in Ukraine, Romania, Georgia and Greece. The Company's internal system is used only by its office staff, to manage client information and to answer clients.</Text>
            <Title order={3}>What we collect</Title>
            <List spacing={4}>
              <List.Item>Client details: name, phone, e-mail, their properties and financial records, as provided by the client or by local property managers.</List.Item>
              <List.Item>WhatsApp messages: when a client or anyone else writes to the Company's WhatsApp number, we keep their phone number, their WhatsApp profile name, the message content and any files they attach, together with our replies.</List.Item>
            </List>
            <Title order={3}>Why</Title>
            <Text>Only to answer those who contact us, to link a conversation to the right client, and to provide our service. We do not send marketing messages and do not use the information for advertising.</Text>
            <Title order={3}>Sharing</Title>
            <Text>We do not sell or share this information with anyone. It is stored with the infrastructure providers the Company uses to run its system (cloud hosting and database, and Meta's WhatsApp Business Platform for delivering messages), under their terms.</Text>
            <Title order={3}>Security and retention</Title>
            <Text>Access to the system is limited to Company staff, with a password and two-step verification, and each staff member sees only what their work requires. Information is kept as long as it is needed for the service or as required by law.</Text>
            <Title order={3}>Your rights</Title>
            <Text>You may ask to see, correct or delete the information we keep about you by e-mail to <Anchor href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</Anchor> or by a WhatsApp message to <Anchor href="https://wa.me/972557750300">{CONTACT_PHONE}</Anchor>. To stop receiving messages from us, reply "STOP" or block the number.</Text>
          </Stack>
        </div>
      </Stack>
    </Container>
  );
}
