import React from "react";
import { DataMode } from "../components/DataMode";
import { Icon, type IconName } from "../components/Icon";
import { clearQueueCache } from "../queueCache";
import { useSession } from "../session";

/** One destination in the rail (and the phone tab bar). */
export interface NavItem {
  key: string;
  hash: string;
  text: string;
  short: string;
  icon: IconName;
  /** Items waiting for a person (shown as a count). */
  count?: number | undefined;
  /** Shown in the rail only (the phone tab bar keeps the first five). */
  railOnly?: boolean | undefined;
}
/** A line of the "who and where" block at the foot of the rail. */
export interface ContextItem {
  label: string;
  value: string;
  title?: string | undefined;
  mono?: boolean | undefined;
}

/** The Access Line reduced to a mark: a line of stations ending in a gate. */
export function AccessMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="access-mark"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden
      focusable="false"
    >
      <rect
        className="access-mark__plate"
        x="0.5"
        y="0.5"
        width="27"
        height="27"
        rx="7.5"
      />
      <path className="access-mark__line" d="M6 17.5h9.5l3-7H22" />
      <circle className="access-mark__stop" cx="6" cy="17.5" r="1.9" />
      <circle className="access-mark__stop" cx="11" cy="17.5" r="1.9" />
      <circle className="access-mark__end" cx="21.5" cy="10.5" r="3.1" />
    </svg>
  );
}

function Context({ items }: { items: ContextItem[] }) {
  return (
    <dl className="context">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? "mono" : undefined} title={item.title}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Count({ n }: { n: number | undefined }) {
  if (!n) return null;
  return (
    <span className="nav-count" aria-label={`${n} waiting`}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

/**
 * The operating shell: a night rail with the workspace's destinations and
 * who/where the operator is, a top bar and tab bar on phones.
 */
export function Shell({
  nav,
  active,
  subtitle,
  context,
  compact,
  home,
  switchTo,
  children,
}: {
  nav: NavItem[];
  active: string;
  subtitle: string;
  context: ContextItem[];
  /** The rail's compact form: two short lines. */
  compact: [string, string];
  /** Where the brand mark leads. */
  home: string;
  /** Another workspace or practice the operator may switch to. */
  switchTo?: { hash: string; label: string } | undefined;
  children: React.ReactNode;
}) {
  const session = useSession();
  const me = session.me!;
  const signOut = () => {
    clearQueueCache();
    // Signing out starts over: the next sign-in does not return to this page.
    history.replaceState(null, "", location.pathname);
    void session.signOut();
  };
  const skip = (e: React.MouseEvent) => {
    // The router owns the hash, so the skip link moves focus instead.
    e.preventDefault();
    document.getElementById("main")?.focus();
  };
  const tabs = nav.filter((n) => !n.railOnly).slice(0, 5);
  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={skip}>
        Skip to content
      </a>
      <aside className="rail night">
        <a className="rail__brand" href={home}>
          <AccessMark />
          <span className="rail__word">ACCESS</span>
          <span className="rail__sub">{subtitle}</span>
        </a>
        <DataMode mode={me.data_mode} />
        <nav className="rail__nav" aria-label="Primary">
          <ul>
            {nav.map((n) => (
              <li key={n.key}>
                <a
                  href={n.hash}
                  aria-current={n.key === active ? "page" : undefined}
                >
                  <Icon name={n.icon} />
                  <span className="rail__text">{n.text}</span>
                  <span className="rail__short">{n.short}</span>
                  <Count n={n.count} />
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="rail__foot">
          <Context items={context} />
          <p className="rail__compact-context">
            <span>{compact[0]}</span>
            <span>{compact[1]}</span>
          </p>
          {switchTo && (
            <a className="rail__switch" href={switchTo.hash}>
              <Icon name="swap" />
              <span>{switchTo.label}</span>
            </a>
          )}
          <button
            type="button"
            className="rail__signout"
            onClick={signOut}
            title="Sign out"
          >
            <Icon name="signOut" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <header className="topbar night">
        <a className="topbar__brand" href={home}>
          <AccessMark size={26} />
          <span>ACCESS</span>
        </a>
        <DataMode mode={me.data_mode} compact />
        <details className="account">
          <summary aria-label="Account and sign out">
            <Icon name="account" />
          </summary>
          <div className="account__panel">
            <Context items={context} />
            {nav
              .filter((n) => !tabs.includes(n))
              .map((n) => (
                <a key={n.key} className="account__link" href={n.hash}>
                  <Icon name={n.icon} />
                  {n.text}
                  <Count n={n.count} />
                </a>
              ))}
            {switchTo && (
              <a className="account__link" href={switchTo.hash}>
                <Icon name="swap" />
                {switchTo.label}
              </a>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={signOut}
            >
              <Icon name="signOut" />
              Sign out
            </button>
          </div>
        </details>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>

      <nav className="tabbar" aria-label="Primary">
        <ul>
          {tabs.map((n) => (
            <li key={n.key}>
              <a
                href={n.hash}
                aria-current={n.key === active ? "page" : undefined}
              >
                <Icon name={n.icon} />
                <span>{n.short}</span>
                <Count n={n.count} />
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
