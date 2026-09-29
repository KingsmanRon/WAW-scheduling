import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "./welcome.css";
import React from "react";
import { createRoot } from "react-dom/client";
import type { IconName } from "../components/Icon";
import { SessionProvider } from "../session";
import { Book, clock, placeRequests, race, type RaceResult } from "./book";
import { icon, mark } from "./dom";
import {
  DEFLECT_FOR,
  buildRace,
  deflectAt,
  measureRace,
  renderCarry,
  renderChannels,
  renderRace,
  renderRecord,
  renderToday,
  renderWhatsApp,
} from "./render";
import { SignIn } from "./SignIn";

declare global {
  interface Window {
    ScrollCraft?: {
      mount(root: Element): unknown;
      reduce: boolean;
    };
  }
}

/* Chrome: icons and the mark, drawn from the console's own set. */
for (const el of document.querySelectorAll<HTMLElement>("[data-icon]"))
  el.replaceWith(icon(el.dataset.icon as IconName, 18));
for (const el of document.querySelectorAll<HTMLElement>("[data-mark]"))
  el.replaceWith(mark(28));

/* The sample practice and its morning, decided by the Scheduling Core. */
const base = Book.sample();
const afterRequests = base.clone();
const placed = placeRequests(afterRequests);
let chosen: Date;
let result: RaceResult;
let finished = false;

const renderAll = () => renderToday(base, renderAll);
renderAll();
renderChannels(base, placed);
buildRace();

function choose(start: Date): void {
  chosen = start;
  renderWhatsApp(afterRequests, chosen, choose);
  result = race(afterRequests, chosen);
  renderRace(result, afterRequests);
  renderRecord(result, afterRequests);
  renderCarry(result, finished);
  measureRace();
}
{
  // The patient's own pick: the first free morning time from ten o'clock.
  const first = renderWhatsApp(afterRequests, new Date(0), () => {});
  const pick =
    first.find((c) => c.free && clock(c.start) >= "10:00") ??
    first.find((c) => c.free)!;
  choose(pick.start);
}

/* The close: the console's real sign-in. */
createRoot(document.getElementById("sign-in-panel")!).render(
  <SessionProvider>
    <SignIn focusOnOpen={() => location.hash === "#sign-in"} />
  </SessionProvider>,
);

/* The engine reads the finished markup; it never builds any. */
window.ScrollCraft?.mount(document.body);
measureRace();
void document.fonts?.ready.then(measureRace);
addEventListener("resize", () => requestAnimationFrame(measureRace), {
  passive: true,
});

/* In-page links jump (a smooth glide would run every act at speed). */
document.addEventListener("click", (e) => {
  const a = (e.target as Element | null)?.closest?.('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute("href")!.slice(1);
  const target = document.getElementById(id);
  if (!target) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: "instant", block: "start" });
  history.replaceState(null, "", `#${id}`);
  if (id === "sign-in")
    document
      .querySelector<HTMLElement>("#sign-in-panel input, #sign-in-panel select")
      ?.focus({ preventScroll: true });
  else target.querySelector<HTMLElement>("h1, h2")?.focus?.();
});
for (const heading of document.querySelectorAll<HTMLElement>(".wp-act h2"))
  heading.tabIndex = -1;

/* The chrome follows the act in the middle of the screen. */
const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-spy]")];
const spy = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.id;
      for (const link of links)
        if (link.dataset.spy === id) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
    }
  },
  { rootMargin: "-50% 0px -50% 0px" },
);
for (const act of document.querySelectorAll(".wp-act")) spy.observe(act);

/*
 * The race's visible state, for the reader (the carried choice at the end)
 * and for the verification harness, which cannot see page-local
 * choreography: it reads the rendered phase and counts published here.
 */
const raceAct = document.getElementById("race")!;
const raceStage = raceAct.querySelector<HTMLElement>("[data-sc-stage]")!;
let last = "";
function publish(): void {
  const p = parseFloat(raceAct.style.getPropertyValue("--sc-p")) || 0;
  const landed = Array.from({ length: 24 }, (_, i) => deflectAt(i)).filter(
    (d) => p >= d + DEFLECT_FOR,
  ).length;
  const phase =
    p < 0.16
      ? "silence"
      : p < 0.4
        ? "converging"
        : p < 0.46
          ? "held"
          : landed < 24
            ? "refusing"
            : "resolved";
  const arrived = Math.min(25, Math.round(Math.max(0, (p - 0.16) / 0.24) * 25));
  const state = `${phase}|${arrived}|${landed}`;
  if (state !== last) {
    last = state;
    raceStage.dataset.scVerifyState = state;
    if (phase === "resolved") raceStage.dataset.scVerifyHold = "true";
    else delete raceStage.dataset.scVerifyHold;
  }
  if (!finished && phase === "resolved") {
    finished = true;
    renderCarry(result, true);
  }
}
let ticking = false;
addEventListener(
  "scroll",
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      publish();
    });
  },
  { passive: true },
);
publish();

/*
 * Keyboard focus on a time in the sideways day: park the act at the progress
 * where that time sits mid-screen, since the rail's position is scroll.
 */
const whatsapp = document.getElementById("whatsapp")!;
const rail = whatsapp.querySelector<HTMLElement>("[data-sc-pan]")!;
rail.addEventListener("focusin", (e) => {
  if (window.ScrollCraft?.reduce) return;
  const item = (e.target as HTMLElement).closest("li");
  if (!item) return;
  const travel = rail.scrollWidth - innerWidth;
  if (travel <= 0) return;
  const extra = travel * (parseFloat(rail.dataset.scPan ?? "0") || 0);
  const centre = item.offsetLeft + item.offsetWidth / 2 - innerWidth / 2;
  const p = Math.min(1, Math.max(0, centre / (travel + extra)));
  const top = whatsapp.getBoundingClientRect().top + scrollY;
  scrollTo({
    top: top + p * (whatsapp.offsetHeight - innerHeight),
    behavior: "instant",
  });
});
