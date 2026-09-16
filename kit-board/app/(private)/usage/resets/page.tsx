import { redirect } from 'next/navigation';
/** The reset calendar and record moved under Allowances (USG-024); the old deep link keeps working. */
export default function Resets() { redirect('/usage/allowances#reset-calendar'); }
