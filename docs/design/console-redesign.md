# Console redesign: design plan

Frontend-only redesign of `apps/console`. API contracts, auth, roles, payloads
and data-mode handling are unchanged. Scrollcraft
(`nateherkai/scroll-craft`) was read as a design standard, not installed.

## The one idea: the Access Line

ACCESS moves every referral along one fixed pathway:

```text
Received → Identity → Information → Destination → Booking → Outcome
```

The console draws that pathway as a line of six stations and puts every case
on it. The same line appears at every scale, so the product has one
recognisable silhouette:

| Surface      | What the line does                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login        | A layered, lit scene: an anonymous referral travels the line, passes behind the destination gate and settles at Booked. No data.                  |
| Queue        | Each row carries a six-node track showing where the case sits; exceptions break the line at the station where they were raised.                   |
| Queue lenses | The stage filters are laid out in station order, so the filter bar reads as the pathway.                                                          |
| Case         | A full-width line records the path this case actually took (from its transitions), when it reached each station, and where it is held.            |
| Dashboard    | The cohort drawn on the line: counts per station, open cases under the station they wait at. A mini line in the sticky rail follows the chapters. |
| New referral | The intake sections run down a vertical line, completed sections filled.                                                                          |

Tell-someone test: _"It's the referral system where every case sits on one
line of stations, so you can see at a glance which gate it's stuck at."_

## Design language

- **Palette (existing DNA, tokenised):** deep clinical green `#174F4A` (brand,
  primary actions, progress), dark blue-green ink `#14262E`, mineral canvas
  `#EEF3F1`, warm coral `#E8623F` as the single accent. Coral means "needs a
  person now" (current position, attention lens, exceptions); it is never
  decoration. A deep green night (`#0C1D20`) is used only for the rail and the
  login stage.
- **Status colours** are reserved and always paired with text and shape:
  attention (amber), in progress (blue), booked (green), exception (red-coral),
  closed (neutral).
- **Provenance** (OBSERVED, DERIVED, ESTIMATED, UNKNOWN) is always printed as a
  word. UNKNOWN is rendered as hatched "no data", never as a zero-length bar or
  the digit 0.
- **Type:** Geist + Geist Mono, self-hosted (no third-party font requests from
  a healthcare app). Mono is used only for data: references, codes, hashes.
  Command (page titles, next action) is large and heavy; status is small caps
  on tinted ground; context is secondary ink; evidence is mono and muted.
- **Shape:** one radius scale (4 / 8 / 12 / 20px). No pill buttons, no
  gradient text, no glass as decoration, no identical metric-card grids.
- **Depth tools:** offset shadows tinted to the ink hue, 1px edge light,
  overlap, scale/blur for distance, and grain on the dark stage only.

## Navigation model

A persistent operating rail on desktop gives ACCESS its silhouette and keeps
context visible: wordmark, data mode, Queue, Dashboard, New referral (hidden
for READ_ONLY, as today), Rules, then organisation, role, profile and sign out.

- **≥ 1280px:** 248px rail with labels.
- **900–1279px** (13" laptops): 84px compact rail, icon over short label.
- **< 900px:** top bar (wordmark, data mode, account menu with sign out) and a
  bottom tab bar for the four destinations.

The data mode is never hidden: SYNTHETIC shows a hatched "Synthetic data"
plate; REAL shows a solid coral "Real patient data" plate. The hash router and
routes are unchanged.

## Layer contract (immersive compositions)

### Login stage

| Plane      | Content                                                  | Movement (pointer / scroll)   | Contact / occlusion rule                                                   |
| ---------- | -------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Far        | Perspective floor grid receding to a horizon             | Smallest, opposite to pointer | Masked at the edges; never behind the headline at full strength            |
| Mid        | The Access Line: path, six stations, labels              | Moderate                      | Carries the token's contact shadow, so the token stays grounded            |
| Focal      | One anonymous referral object (no text, no data)         | Travels the line once on load | Always on the path; its shadow is drawn in the mid plane at the same point |
| Near       | The destination gate: a translucent frame at station 4   | Strongest (still ≤ 14px)      | The token passes behind it; it never covers labels or the form             |
| Atmosphere | Light from upper left, grain                             | Slow, small                   | Separates planes; never washes out text                                    |
| Type + UI  | Wordmark, headline, product boundary line, sign-in panel | Stable                        | Always above every plane; the line ends just short of the panel            |

On desktop the sign-in panel sits inside the stage rather than on the browser
edge: its centre is at 65–70% of the width on wide screens (about 74% at
1100px, where the copy needs the room), and the stage is sized from the
panel's edge so Booked lands 3.5rem short of it and the line's last segment
meets the panel's side.

Opening: line drawn, token at Received. Midpoint: token passes behind the
gate at Destination. Resolved: token rests at Booked, gate settled. On
fine-pointer devices the planes shift by different small amounts toward the
pointer. On phones the stage is a short band above the form; the form stays
visible without scrolling at 360 × 640.

### Dashboard flow stage

Same planes with real cohort numbers: far grid, mid line with station nodes,
focal station figures (semantic HTML), near frame edge, atmosphere. The line
draws once on first view; while the stage scrolls past, planes separate by a
few pixels. With motion reduced it is fully drawn and still.

## Where motion is allowed

| Level               | Surfaces                                    | Motion                                                                                                                                          |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: brand moments    | Login, dashboard story                      | Load choreography (≤ 2.4s, once), pointer depth (fine pointer only), scroll-linked plane separation, line drawing, chapter reveal once on entry |
| 2: operational work | Queue, case, new referral, rules, all forms | Hover/focus/press feedback (120–180ms), one 200ms fade when a page or result set arrives, disclosure caret. Nothing is tied to scroll.          |

**Intentionally absent:** scroll-jacking, pinning, parallax or reveal on any
table, form, action, safety warning, validation or error; row reordering
animations; perpetual loops; magnetic buttons; pointer lock. Safety holds and
errors appear instantly and never depend on animation.

Implementation uses CSS transforms and opacity driven by custom properties
(`--px`, `--py`, `--sp`). rAF runs only while a pointer is settling or a stage
is on screen; IntersectionObserver gates everything; all listeners are removed
on unmount.

## Scrollcraft engine decision

Not used. `engine/scrollcraft.js` has no teardown: `mount()` starts a `tick()`
rAF loop that reschedules itself forever, adds window `scroll`, `resize`,
`focusin`, `pointermove` and touch listeners that are never removed, and
registers instances globally. `scrollcraft.css` resets `html`, `body` and
media globally (including `scroll-behavior: smooth`). In a React SPA that
mounts and unmounts routes, that leaks a loop and listeners per visit and
restyles the operational screens; Scrollcraft's own rule forbids editing the
engine to add teardown. The needed behaviour is a few planes, two progress
variables and a reveal-once observer, implemented in `src/motion/`.

## Mobile strategy

Recomposed, not shrunk. Queue rows become compact stacked rows (reference and
age, track and state, next action, owner and destination) with the table
semantics kept. The dashboard line runs vertically. Case detail leads with the
"now" block and actions. Login puts a short stage band above the form. Tap
targets are at least 44px. Verified at 390 × 844 and 360 × 640.

## Reduced motion

`prefers-reduced-motion: reduce` disables pointer and scroll listeners, places
the login token at its resolved station, draws every line fully, and keeps
only short opacity fades. All planes still render with their depth offsets, so
the layered hierarchy survives without motion.

## Dashboard information order

1. **Flow:** received, verified, ready for booking, booked; still open and
   closed as exits; open cases under the station they wait at.
2. **Conversion:** known-outcome conversion, cohort booking rate, closure
   reasons.
3. **Delay:** median time to verified and to ready, p95 to ready, median to
   booked, where referrals wait.
4. **Exceptions:** exception rate, top exception reasons, outcomes awaiting
   review.
5. **Work:** human touch rate, touches per referral, status enquiries per
   referral, staff time per referral.

Every figure keeps its provenance and basis, and shows its sample size or
numerator/denominator when the API returns them.

## Screenshots

`docs/design/console-redesign/` holds the verification screenshots (synthetic
data only, taken against the local synthetic stack): desktop, 13" laptop,
phone, 360 × 640 and reduced motion.
