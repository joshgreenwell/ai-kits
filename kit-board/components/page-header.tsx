import type { ReactNode } from "react";

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** A shared title row for each private observatory section. */
export function PageHeader({ eyebrow, title, actions, className = "" }: PageHeaderProps) {
  return (
    <header className={`report-toolbar ${className}`.trim()}>
      <div>
        {eyebrow ? <p className="portal-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
