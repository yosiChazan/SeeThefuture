import { Anchor, Badge, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { sourceInfo } from '../lib/source';

const COLOR = { report: 'blue', airtable: 'orange', excel: 'green', manual: 'gray', unknown: 'red' } as const;

// A small mark on a ledger row: where the transaction came from (SPEC decision 136). A report
// opens at intake; a row in Airtable opens there; a spreadsheet and "by hand" show in words.
export function SourceBadge({ source, importBatchId }: { source?: string | null; importBatchId?: string | null }) {
  const s = sourceInfo(source, importBatchId);
  const badge = <Badge size="xs" variant="light" color={COLOR[s.kind]} style={s.href ? { cursor: 'pointer' } : undefined}>{s.label}</Badge>;
  const inner = !s.href ? badge : s.href.startsWith('/')
    ? <Anchor component={Link} to={s.href} underline="never">{badge}</Anchor>
    : <Anchor href={s.href} target="_blank" rel="noopener noreferrer" underline="never">{badge}</Anchor>;
  return <Tooltip label={s.detail ?? s.label} withinPortal>{inner}</Tooltip>;
}
