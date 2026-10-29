import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import { Badge, DirectionProvider, MantineProvider, createTheme } from '@mantine/core';
import { DatesProvider } from '@mantine/dates';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import 'dayjs/locale/he';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
            <App />
          </QueryClientProvider>
        </DatesProvider>
      </MantineProvider>
    </DirectionProvider>
  </StrictMode>,
);
