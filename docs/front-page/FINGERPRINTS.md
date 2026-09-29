# Fingerprints

Every site you build with **scroll-craft** gets one row here, appended after it
ships. The registry exists so your next build can prove it is a different page
rather than a re-skin of one you already made.

This file is **yours**. It starts empty on purpose: the gate is about not
repeating _yourself_, so it has nothing to say until you have built something.

The rules and the gate live in the skill's
`references/uniqueness.md`. Short version:

**A new build must differ from EVERY row below on at least 4 of the 6
dimensions.** Four against each row individually, not four on average across the
table. If a planned build fails, change the plan. Never edit a row to make room
for it.

The six dimensions are: **grammar**, **nav treatment**, **hero device**,
**act-sequence shape**, **close pattern**, **signature move**.

Dimension 6 is free, because a signature move is unique by definition. So the
gate really asks for three more out of the remaining five, and a build that
changes only grammar and world will fail it.

---

## The registry

| Build    | Grammar                                                                                                                    | Nav treatment                                                                                                                   | Hero device                                                                                                                                                                                                                | Act-sequence shape                                                                                     | Close pattern                                                                     | Signature move                                                                                                                                                                                                    | World                                                                                                                                  | Port                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `access` | Live surface: the page behaves like the ACCESS console and runs its Scheduling Core in the browser on labelled sample data | The console's own rail (tab bar and top bar on phones), items are the acts; a "Sign in" button where the console has "Sign out" | The Today view already mid-morning, operable (visit steps go through the state machine); a first-run help card holds the `h1`; depth from a blurred next-day sheet behind a WhatsApp phone, parallax and fine-pointer tilt | `flow > pin > pan > pin > flow > flow`, 6 acts, ~11.2vh; zero `scrub`, `kinetic`, `spotlight`, `drift` | The real sign-in form, carrying the time the visitor chose; footer inside the act | **The race for your time**: the visitor picks the time a WhatsApp patient taps, then 25 simultaneous requests converge on that cell; one holds, 24 are refused and settle into the next free times, computed live | Clinical night rail on a pale console surface; night stage for the peak; Geist and Geist Mono; coral reserved for "a person is needed" | `/welcome/` in the console build |

---

## What is taken

Add a bullet here whenever a build claims something a later build should avoid
reusing: a grammar, a nav treatment, a close pattern, a signature move, an
act-count-and-length band. The shared columns are what the next build inherits
as a constraint, so writing them down is the whole point.

- Live surface as a product's own console (app chrome as navigation, an
  operable working surface as the hero, the real sign-in as the close).
- A scroll-driven race of simultaneous requests on one cell.
- The 6-act, ~11vh band with no scrub.

---

## Appending a row

After shipping, add one line to the table and one bullet to **What is taken** if
the build claimed something new. Fill every column. Say what the build shares
with existing rows.

Rows are append-only. A build that has been superseded stays in the table,
because the space it occupies is still occupied.

---

## Worked example

The skill's author kept a registry of twelve builds across eight page grammars.
If you want to see what a filled-in table looks like, and which shapes tend to
collide, read `EXAMPLES.md` in the scroll-craft repository. Treat it as
illustration only: those rows are somebody else's builds and they do **not**
constrain yours.
