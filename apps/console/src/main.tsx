import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/login.css";
import "./styles/queue.css";
import "./styles/case.css";
import "./styles/dashboard.css";
import "./styles/intake.css";
import "./styles/rules.css";
import "./styles/practice.css";
import { label, roleLabel, shortId } from "./format";
import { Shell, type NavItem } from "./layout/Shell";
import { PracticeApp } from "./practice/PracticeApp";
import {
  parsePracticeRoute,
  practiceHash,
  type PracticeRoute,
} from "./practice/route";
import { SessionProvider, useSession, type Me, type OrgRole } from "./session";
import { CaseDetail } from "./views/CaseDetail";
import { Dashboard } from "./views/Dashboard";
import { Login } from "./views/Login";
import { NewReferral } from "./views/NewReferral";
import { Practices } from "./views/Practices";
import { Queue } from "./views/Queue";
import { Rules } from "./views/Rules";

type ReferralPage = "queue" | "dashboard" | "new" | "rules";
type Route =
  | { page: ReferralPage | "practices" | "home" }
  | { page: "case"; id: string }
  | { page: "practice"; practice: PracticeRoute };

function parse(hash: string): Route {
  const practice = parsePracticeRoute(hash);
  if (practice) return { page: "practice", practice };
  const [page, id] = hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
  if (page === "case" && id) return { page: "case", id };
  if (
    page === "queue" ||
    page === "dashboard" ||
    page === "new" ||
    page === "rules" ||
    page === "practices"
  )
    return { page };
  return { page: "home" };
}

/**
 * Where a signed-in user starts: their practice's day when they work in
 * one practice, the practice picker when several, and the organisation's
 * referral queue when they only have an organisation role.
 */
function home(me: Me): string {
  if (me.practices.length === 1)
    return practiceHash(me.practices[0]!.practice_id, "today");
  if (me.practices.length > 1 || !me.role) return "#/practices";
  return "#/queue";
}
const REFERRAL_PAGES = new Set(["queue", "dashboard", "new", "rules", "case"]);
/** Where to send a route the user may not see (referral pages need an organisation role). */
function redirect(route: Route, me: Me): string | null {
  if (route.page === "home") return home(me);
  if (!me.role && REFERRAL_PAGES.has(route.page)) return home(me);
  return null;
}
/** Scroll and focus follow the page, not query changes within it. */
function pageKey(route: Route): string {
  if (route.page === "practice")
    return `p/${route.practice.practiceId}/${route.practice.view}/${route.practice.id ?? ""}`;
  return route.page === "case" ? `case/${route.id}` : route.page;
}
const TITLES: Record<ReferralPage | "case" | "practices", string> = {
  queue: "Queue",
  dashboard: "Dashboard",
  new: "New referral",
  rules: "Rules",
  case: "Case",
  practices: "Choose a practice",
};

const SHORT_ROLE: Record<OrgRole, string> = {
  ADMIN: "Admin",
  PRACTICE_MANAGER: "Manager",
  REFERRAL_COORDINATOR: "Coordinator",
  READ_ONLY: "Read-only",
};
const REFERRAL_NAV: (NavItem & { key: ReferralPage })[] = [
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

/** The organisation's referral operations workspace (organisation roles). */
function ReferralWorkspace({
  me,
  active,
  children,
}: {
  me: Me & { role: OrgRole };
  active: ReferralPage;
  children: React.ReactNode;
}) {
  const nav = REFERRAL_NAV.filter(
    (n) => n.key !== "new" || me.role !== "READ_ONLY",
  );
  return (
    <Shell
      nav={nav}
      active={active}
      subtitle="Referral operations"
      home="#/queue"
      compact={[SHORT_ROLE[me.role], shortId(me.tenant_id)]}
      context={[
        {
          label: "Organisation",
          value: shortId(me.tenant_id),
          title: me.tenant_id ?? undefined,
          mono: true,
        },
        { label: "Role", value: roleLabel(me.role) },
        {
          label: "Environment",
          value: `${label(me.profile)} · ${me.auth_mode === "jwt" ? "Signed in" : "Synthetic sign-in"}`,
        },
      ]}
      switchTo={
        me.practices.length
          ? { hash: "#/practices", label: "Switch workspace" }
          : undefined
      }
    >
      {children}
    </Shell>
  );
}

function App() {
  const session = useSession();
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const queueScroll = useRef(0);
  const routed = useRef(false);
  const lastPage = useRef("");
  useEffect(() => {
    const onHash = () =>
      setRoute((previous) => {
        if (previous.page === "queue") queueScroll.current = window.scrollY;
        return parse(location.hash);
      });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const me = session.me;
  const to = me ? redirect(route, me) : null;
  const shown = to ? parse(to) : route;
  // Replace (not push) a redirect so Back does not bounce through it.
  useEffect(() => {
    if (to) history.replaceState(null, "", to);
  }, [to]);
  // Each page starts at its top, except the queue, which returns to where the
  // operator left it. Focus moves to the page so screen readers follow.
  const key = pageKey(shown);
  useLayoutEffect(() => {
    if (!me) {
      routed.current = false;
      lastPage.current = "";
      return;
    }
    if (shown.page !== "practice" && shown.page !== "home")
      document.title = `${TITLES[shown.page]} · ACCESS`;
    if (lastPage.current === key) return;
    lastPage.current = key;
    if (!routed.current) {
      // Just signed in: start keyboard navigation in the page content.
      routed.current = true;
      document.getElementById("main")?.focus({ preventScroll: true });
      return;
    }
    window.scrollTo(0, shown.page === "queue" ? queueScroll.current : 0);
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [key, me, shown.page]);
  const go = (hash: string) => {
    location.hash = hash;
  };
  if (!me) return <Login />;
  if (shown.page === "practice") {
    const member = me.practices.some(
      (p) => p.practice_id === shown.practice.practiceId,
    );
    if (!member)
      return (
        <Practices notice="You do not have access to that practice, or it is no longer active." />
      );
    return (
      <PracticeApp
        key={shown.practice.practiceId}
        route={shown.practice}
        go={go}
      />
    );
  }
  if (shown.page === "practices" || shown.page === "home" || !me.role)
    return <Practices />;
  const orgMe = me as Me & { role: OrgRole };
  const active: ReferralPage = shown.page === "case" ? "queue" : shown.page;
  return (
    <ReferralWorkspace me={orgMe} active={active}>
      <div className="page" key={key}>
        {shown.page === "queue" && <Queue open={(id) => go(`#/case/${id}`)} />}
        {shown.page === "case" && (
          <CaseDetail
            key={shown.id}
            caseId={shown.id}
            back={() => go("#/queue")}
          />
        )}
        {shown.page === "dashboard" && <Dashboard />}
        {shown.page === "new" && (
          <NewReferral open={(id) => go(`#/case/${id}`)} />
        )}
        {shown.page === "rules" && <Rules />}
      </div>
    </ReferralWorkspace>
  );
}

createRoot(document.getElementById("root")!).render(
  <SessionProvider>
    <App />
  </SessionProvider>,
);
