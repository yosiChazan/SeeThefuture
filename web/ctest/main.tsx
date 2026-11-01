import '@mantine/core/styles.css';
import { Button, DirectionProvider, MantineProvider, Modal } from '@mantine/core';
import { createRoot } from 'react-dom/client';
import { changes, useConfirmSave } from '../src/components/ConfirmSave';

function Demo() {
  const c = useConfirmSave();
  return (
    <Modal opened onClose={() => {}} title="עריכת פרטי לקוח" size="lg">
      <p>טופס</p>
      {c.element}
      <Button id="save" onClick={() => c.ask({ title: 'אישור שינויים: ישראל ישראלי', action: async () => { document.title = 'saved'; },
        rows: changes([{ label: 'שם', before: 'ישראל ישראלי', after: 'ישראל ישראלי' }, { label: 'טלפון', before: null, after: '+972-50-0000000' }, { label: 'מייל', before: 'old@example.com', after: 'new@example.com' }]) })}>שמירה</Button>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(<DirectionProvider initialDirection="rtl"><MantineProvider><Demo /></MantineProvider></DirectionProvider>);
