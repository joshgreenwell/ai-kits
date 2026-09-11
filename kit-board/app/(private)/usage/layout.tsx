import { UsageNavigation } from '@/components/usage-navigation';
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="mx-auto w-full max-w-[1200px] px-6 pt-6">
        <UsageNavigation />
      </div>
      {children}
    </>
  );
}
