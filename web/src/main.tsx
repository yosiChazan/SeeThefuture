import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import { Badge, DirectionProvider, MantineProvider, createTheme } from '@mantine/core';
import { DatesProvider } from '@mantine/dates';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import 'dayjs/locale/he';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// After a new version is deployed, a tab opened earlier still runs the old code, and the
// parts it loads on demand (the Excel reader, the PDF and OCR readers) are gone from the
// server: "Failed to fetch dynamically imported module". Vite reports it as
// vite:preloadError; reload once to get the new version, at most once a minute.
window.addEventListener('vite:preloadError', (event) => {
  let last = 0;
  try { last = Number(sessionStorage.getItem('stale-reload') ?? 0); } catch { /* storage blocked */ }
  if (Date.now() - last < 60_000) return;
  try { sessionStorage.setItem('stale-reload', String(Date.now())); } catch { /* storage blocked */ }
  event.preventDefault();
  window.location.reload();
});
import { App } from './App';

const theme = createTheme({
  fontFamily: 'Heebo, system-ui, sans-serif',
  headings: { fontFamily: 'Heebo, system-ui, sans-serif' },
  primaryColor: 'indigo',
  defaultRadius: 'md',
  components: {
    // In tight table columns a badge would otherwise be cut to "חסרים פ…".
    Badge: Badge.extend({ styles: { root: { minWidth: 'max-content' } } }),
  },
});

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DirectionProvider initialDirection="rtl">
      <MantineProvider theme={theme}>
        <DatesProvider settings={{ locale: 'he', firstDayOfWeek: 0 }}>
          <Notifications position="top-left" />
          <QueryClientProvider client={queryClient}>
            <ModalsProvider>
              <App />
            </ModalsProvider>
          </QueryClientProvider>
        </DatesProvider>
      </MantineProvider>
    </DirectionProvider>
  </StrictMode>,
);
