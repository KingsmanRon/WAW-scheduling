import React from "react";
import { Icon } from "../components/Icon";
import { label, roleLabel, shortId } from "../format";
import { PageHeader } from "../layout/PageHeader";
import { Shell, type NavItem } from "../layout/Shell";
import { practiceHash } from "../practice/route";
import { useSession } from "../session";

/**
 * The workspaces a signed-in user may enter: each practice they are a
 * member of (with their role there) and, for organisation roles, the
 * referral operations workspace.
 */
export function Practices({ notice }: { notice?: string }) {
  const session = useSession();
  const me = session.me!;
  const nav: NavItem[] = [
    {
      key: "practices",
      hash: "#/practices",
      text: "Practices",
      short: "Practices",
      icon: "practice",
    },
    ...(me.role
      ? [
          {
            key: "queue",
            hash: "#/queue",
            text: "Referral operations",
            short: "Referrals",
            icon: "queue",
          } as NavItem,
        ]
      : []),
  ];
  const environment = `${label(me.profile)} · ${me.auth_mode === "jwt" ? "Signed in" : "Synthetic sign-in"}`;
  return (
    <Shell
      nav={nav}
      active="practices"
      subtitle="Workspaces"
      home="#/practices"
      compact={[
        me.role ? roleLabel(me.role) : "Staff",
        `${me.practices.length} practice${me.practices.length === 1 ? "" : "s"}`,
      ]}
      context={[
        ...(me.tenant_id
          ? [
              {
                label: "Organisation",
                value: shortId(me.tenant_id),
                title: me.tenant_id,
                mono: true,
              },
            ]
          : []),
        { label: "Environment", value: environment },
      ]}
    >
      <div className="page">
        <PageHeader
          title="Choose a workspace"
          context="Your role can differ between practices."
        />
        {notice && (
          <p className="alert" role="alert">
            {notice}
          </p>
        )}
        {!me.practices.length && !me.role && (
          <p className="note">
            You are not a member of any practice yet. Ask your practice
            administrator for access.
          </p>
        )}
        <ul className="workspaces">
          {me.practices.map((p) => (
            <li key={p.practice_id}>
              <a
                className="workspace-card panel"
                href={practiceHash(p.practice_id, "today")}
              >
                <Icon name="practice" />
                <span className="workspace-card__name">{p.name}</span>
                <span className="muted small">
                  {roleLabel(p.role)} · {p.display_name} · {p.timezone}
                </span>
              </a>
            </li>
          ))}
          {me.role && (
            <li>
              <a className="workspace-card panel" href="#/queue">
                <Icon name="queue" />
                <span className="workspace-card__name">
                  Referral operations
                </span>
                <span className="muted small">
                  Organisation · {roleLabel(me.role)}
                </span>
              </a>
            </li>
          )}
        </ul>
      </div>
    </Shell>
  );
}
