import { redirect } from 'next/navigation';
/** Usage & pace moved: allowances live under Usage, hourly activity under Tokens. */
export default function LiveUsage() { redirect('/usage/allowances'); }
