import { SettingsNavigation } from '@/components/settings-navigation';
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="mx-auto w-full max-w-[1200px] px-6 pt-6">
        <SettingsNavigation />
      </div>
      {children}
    </>
  );
}
