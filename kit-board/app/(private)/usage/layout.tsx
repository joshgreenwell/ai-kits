import { UsageNavigation } from '@/components/usage-navigation';
import '../../telemetry.css';
export default function Layout({ children }: { children: React.ReactNode }) {
  return <><UsageNavigation />{children}</>;
}
