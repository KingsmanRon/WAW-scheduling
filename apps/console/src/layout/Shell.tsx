import React from "react";
import { DataMode } from "../components/DataMode";
import { Icon, type IconName } from "../components/Icon";
import { label, roleLabel, shortId } from "../format";
import { clearQueueCache } from "../queueCache";
import { useSession, type Me } from "../session";

export type NavKey = "queue" | "dashboard" | "new" | "rules";
const NAV: {
  key: NavKey;
  hash: string;
  text: string;
  short: string;
  icon: IconName;
}[] = [
  {
    key: "queue",
    hash: "#/queue",
    text: "Queue",
    short: "Queue",
    icon: "queue",
  },
  {
    key: "dashboard",
    hash: "#/dashboard",
    text: "Dashboard",
    short: "Dashboard",
    icon: "dashboard",
  },
  {
    key: "new",
    hash: "#/new",
    text: "New referral",
    short: "New",
    icon: "plus",
  },
  {
    key: "rules",
    hash: "#/rules",
    text: "Rules",
    short: "Rules",
    icon: "rules",
  },
];
const visibleNav = (me: Me) =>
  NAV.filter((n) => n.key !== "new" || me.role !== "READ_ONLY");

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

const SHORT_ROLE: Record<Me["role"], string> = {
  ADMIN: "Admin",
  PRACTICE_MANAGER: "Manager",
  REFERRAL_COORDINATOR: "Coordinator",
  READ_ONLY: "Read-only",
};

function Context({ me }: { me: Me }) {
  return (
    <dl className="context">
      <div>
        <dt>Organisation</dt>
        <dd className="mono" title={me.tenant_id}>
          {shortId(me.tenant_id)}
        </dd>
      </div>
      <div>
        <dt>Role</dt>
        <dd>{roleLabel(me.role)}</dd>
      </div>
      <div>
        <dt>Environment</dt>
        <dd>
          {label(me.profile)} ·{" "}
          {me.auth_mode === "jwt" ? "Signed in" : "Synthetic sign-in"}
        </dd>
      </div>
    </dl>
  );
}

export function Shell({
  active,
  children,
}: {
  active: NavKey;
  children: React.ReactNode;
}) {
  const session = useSession();
  const me = session.me!;
  const nav = visibleNav(me);
  const signOut = () => {
    clearQueueCache();
    void session.signOut();
  };
  const skip = (e: React.MouseEvent) => {
    // The router owns the hash, so the skip link moves focus instead.
    e.preventDefault();
    document.getElementById("main")?.focus();
  };
  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={skip}>
        Skip to content
      </a>
      <aside className="rail night">
        <div className="rail__brand">
          <AccessMark />
          <span className="rail__word">ACCESS</span>
          <span className="rail__sub">Referral operations</span>
        </div>
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
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="rail__foot">
          <Context me={me} />
          <p className="rail__compact-context">
            <span>{SHORT_ROLE[me.role] ?? roleLabel(me.role)}</span>
            <span className="mono" title={me.tenant_id}>
              {shortId(me.tenant_id)}
            </span>
          </p>
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
        <a className="topbar__brand" href="#/queue">
          <AccessMark size={26} />
          <span>ACCESS</span>
        </a>
        <DataMode mode={me.data_mode} compact />
        <details className="account">
          <summary aria-label="Account and sign out">
            <Icon name="account" />
          </summary>
          <div className="account__panel">
            <Context me={me} />
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
          {nav.map((n) => (
            <li key={n.key}>
              <a
                href={n.hash}
                aria-current={n.key === active ? "page" : undefined}
              >
                <Icon name={n.icon} />
                <span>{n.short}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
