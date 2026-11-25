import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { must, supabase } from './supabase';
import type { Country } from './types';

type Level = 'viewer' | 'editor' | 'finance';
const RANK: Record<Level, number> = { viewer: 1, editor: 2, finance: 3 };

export interface Access {
  displayName: string;
  isAdmin: boolean;
  isManagement: boolean;
  isClient: boolean;
  countries: Country[];
  canRead: (c: Country) => boolean;
  canEdit: (c: Country) => boolean;
  canApprove: (c: Country) => boolean;
  // Sensitive documents and ID numbers in some country (SPEC decisions 64, 66).
  canViewSensitive: boolean;
  // Set by an admin with a new password: replace it before anything else (SPEC decision 87).
  mustChangePassword: boolean;
}

const AccessContext = createContext<Access | null>(null);

// Mirrors app.can_read_country / app.can_edit_country for showing or hiding
// buttons. The database enforces the same rules on every request.
export function useAccessQuery(userId: string) {
  return useQuery({
    queryKey: ['access', userId],
    queryFn: async (): Promise<Access | null> => {
      const profile = must(await supabase.from('profiles').select('display_name, is_admin, is_management, client_party_id, must_change_password').eq('user_id', userId).maybeSingle()) as
        { display_name: string; is_admin: boolean; is_management: boolean; client_party_id: string | null; must_change_password: boolean } | null;
      if (!profile) return null;
      const roles = must(await supabase.from('user_country_roles').select('country_code, level, can_view_sensitive').eq('user_id', userId)) as { country_code: Country; level: Level; can_view_sensitive: boolean }[];
      const level = new Map(roles.map((r) => [r.country_code, RANK[r.level]]));
      const all: Country[] = ['UA', 'RO', 'GE', 'GR'];
      const canRead = (c: Country) => profile.is_admin || profile.is_management || (level.get(c) ?? 0) >= 1;
      const canEdit = (c: Country) => profile.is_admin || (level.get(c) ?? 0) >= 2;
      const canApprove = (c: Country) => profile.is_admin || (level.get(c) ?? 0) >= 3;
      return {
        displayName: profile.display_name,
        isAdmin: profile.is_admin,
        isManagement: profile.is_management,
        isClient: !!profile.client_party_id,
        countries: all.filter(canRead),
        canRead,
        canEdit,
        canApprove,
        canViewSensitive: profile.is_admin || roles.some((r) => r.can_view_sensitive),
        mustChangePassword: profile.must_change_password,
      };
    },
  });
}

export function AccessProvider({ value, children }: { value: Access; children: ReactNode }) {
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): Access {
  const a = useContext(AccessContext);
  if (!a) throw new Error('useAccess outside AccessProvider');
  return a;
}
