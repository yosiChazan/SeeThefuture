import { Alert, Center, Loader, Stack } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { finishConnect } from '../lib/dropbox';
import { supabase } from '../lib/supabase';

// Dropbox sends the admin back here with ?code=… after they allow access.
export function DropboxCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(params.get('error_description') ?? params.get('error'));
  const once = useRef(false);
  useEffect(() => {
    const code = params.get('code');
    if (!code || once.current) return;
    once.current = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        await finishConnect(code, data.user!.id);
        navigate('/settings', { replace: true });
      } catch (e) { setError((e as Error).message); }
    })();
  }, [params, navigate]);
  if (error) return <Stack><Alert color="red" title="החיבור לדרופבוקס לא הצליח">{error}</Alert><Link to="/settings">חזרה להגדרות</Link></Stack>;
  return <Center p="xl"><Loader /></Center>;
}
