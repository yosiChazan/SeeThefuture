import { useQuery } from '@tanstack/react-query';
import { buildGroups, type FileCategory } from './fileGroups';
import { must, supabase } from './supabase';

// The file groups with the categories added in Settings (SPEC decision 107).
export function useFileCategories() {
  return useQuery({
    queryKey: ['file-categories'],
    queryFn: async () => must(await supabase.from('file_categories').select('id, label, sensitive, position').order('position')) as FileCategory[],
    staleTime: 5 * 60 * 1000,
  });
}
export function useFileGroups() {
  const q = useFileCategories();
  return buildGroups(q.data ?? []);
}
