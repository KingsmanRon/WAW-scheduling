import { PATHS, type IconName } from "../components/Icon";

type Child = Node | string | number | null | undefined | false;

/** A small element builder: text is always text, never parsed markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}
export function append(el: Element, children: Child[]): void {
  for (const c of children)
    if (c !== null && c !== undefined && c !== false)
      el.append(c instanceof Node ? c : String(c));
}

const SVG = "http://www.w3.org/2000/svg";
export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    class: "icon",
    width: size,
    height: size,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.6,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

/** The ACCESS mark, as the console draws it. */
export function mark(size = 28): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    class: "access-mark",
    width: size,
    height: size,
    viewBox: "0 0 28 28",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(k, String(v));
  const parts: [string, Record<string, string>][] = [
    [
      "rect",
      {
        class: "access-mark__plate",
        x: "0.5",
        y: "0.5",
        width: "27",
        height: "27",
        rx: "7.5",
      },
    ],
    ["path", { class: "access-mark__line", d: "M6 17.5h9.5l3-7H22" }],
    ["circle", { class: "access-mark__stop", cx: "6", cy: "17.5", r: "1.9" }],
    ["circle", { class: "access-mark__stop", cx: "11", cy: "17.5", r: "1.9" }],
    ["circle", { class: "access-mark__end", cx: "21.5", cy: "10.5", r: "3.1" }],
  ];
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/** Every element bound to a name in the page's markup. */
export function bound<T extends Element = HTMLElement>(name: string): T[] {
  return [...document.querySelectorAll<T>(`[data-bind="${name}"]`)];
}
export function fill(name: string, ...children: Child[]): void {
  for (const el of bound(name)) {
    el.replaceChildren();
    append(el, children);
  }
}
