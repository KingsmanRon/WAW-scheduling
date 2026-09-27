import React from "react";

/** Page title, one line of context, and the page's own controls. */
export function PageHeader({
  title,
  context,
  actions,
  children,
  sticky = false,
}: {
  title: React.ReactNode;
  context?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  sticky?: boolean;
}) {
  return (
    <header className={`page-header${sticky ? " page-header--sticky" : ""}`}>
      <div className="page-header__row">
        <div className="page-header__titles">
          <h1 className="page-title">{title}</h1>
          {context && <p className="page-context">{context}</p>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
