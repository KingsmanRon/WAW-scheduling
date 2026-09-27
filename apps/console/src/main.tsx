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
import { Shell, type NavKey } from "./layout/Shell";
import { SessionProvider, useSession } from "./session";
import { CaseDetail } from "./views/CaseDetail";
import { Dashboard } from "./views/Dashboard";
import { Login } from "./views/Login";
import { NewReferral } from "./views/NewReferral";
import { Queue } from "./views/Queue";
import { Rules } from "./views/Rules";

type Route =
  | { page: "queue" | "dashboard" | "new" | "rules" }
  | { page: "case"; id: string };
function parse(hash: string): Route {
  const [page, id] = hash.replace(/^#\/?/, "").split("/");
  if (page === "case" && id) return { page: "case", id };
  if (page === "dashboard" || page === "new" || page === "rules")
    return { page };
  return { page: "queue" };
}
const TITLES: Record<Route["page"], string> = {
  queue: "Queue",
  dashboard: "Dashboard",
  new: "New referral",
  rules: "Rules",
  case: "Case",
};

function App() {
  const session = useSession();
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const queueScroll = useRef(0);
  const routed = useRef(false);
  useEffect(() => {
    const onHash = () =>
      setRoute((previous) => {
        if (previous.page === "queue") queueScroll.current = window.scrollY;
        return parse(location.hash);
      });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Each page starts at its top, except the queue, which returns to where the
  // operator left it. Focus moves to the page so screen readers follow.
  useLayoutEffect(() => {
    if (!session.me) {
      routed.current = false;
      return;
    }
    document.title = `${TITLES[route.page]} · ACCESS`;
    if (!routed.current) {
      // Just signed in: start keyboard navigation in the page content.
      routed.current = true;
      document.getElementById("main")?.focus({ preventScroll: true });
      return;
    }
    window.scrollTo(0, route.page === "queue" ? queueScroll.current : 0);
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [route, session.me]);
  const go = (hash: string) => {
    location.hash = hash;
  };
  if (!session.me) return <Login />;
  const active: NavKey = route.page === "case" ? "queue" : route.page;
  const key = route.page === "case" ? `case-${route.id}` : route.page;
  return (
    <Shell active={active}>
      <div className="page" key={key}>
        {route.page === "queue" && <Queue open={(id) => go(`#/case/${id}`)} />}
        {route.page === "case" && (
          <CaseDetail
            key={route.id}
            caseId={route.id}
            back={() => go("#/queue")}
          />
        )}
        {route.page === "dashboard" && <Dashboard />}
        {route.page === "new" && (
          <NewReferral open={(id) => go(`#/case/${id}`)} />
        )}
        {route.page === "rules" && <Rules />}
      </div>
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <SessionProvider>
    <App />
  </SessionProvider>,
);
