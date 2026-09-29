# ACCESS front page: brief

**Self-authored under explicit creative delegation.** The owner asked for the
front end to use scroll-craft "for good reference and implement accordingly",
and their standing instruction is to state assumptions and start work rather
than open with questions. Nothing below is a quotation from them; every answer
is an authored decision, marked as such, and grounded in the repository (the
product, its brand tokens, its tests).

## What the page is

ACCESS runs a medical practice's appointment book across reception, WhatsApp,
referrals and the waitlist, with one Scheduling Core and a database that
refuses a double booking. The page is what a signed-out visitor sees at the
console's address (`/welcome/`): practice staff on their way to sign in, and
practice owners deciding whether to use it. It ends in the real sign-in.

## The eight topics (authored)

1. **Vibe:** calm, exact, clinical, unhurried. References: a hospital
   theatre's day board (one list everyone trusts), a paper appointment book
   with ruled quarter hours, a railway interlocking (two trains can never be
   given the same block).
2. **Journey, in order:** a morning that is already running; requests arriving
   from every channel; one patient on WhatsApp choosing one time; many people
   reaching for that same time at once; the record of what happened; sign in.
3. **Energy:** quiet open, rising pressure, one intimate beat, the loudest
   moment, then calm and a quiet close.
4. **Feeling stage by stage, and the one moment:** see the curve below. The
   moment to remember is twenty-five requests landing on one time and the book
   staying clean.
5. **What no other site does:** the visitor picks a time for a patient, then
   watches twenty-five simultaneous requests race for it, computed live by the
   product's own scheduling rules.
6. **Aesthetic range:** dense and information-forward, in the product's own
   idiom (the console's tokens, Geist and Geist Mono, clinical green, coral
   only where a person is needed). Not premium-minimal marketing.
7. **One world or distinct scenes:** distinct scenes on one working surface.
   No continuous flight.
8. **Assets:** none photographic, and none generated. The product itself is
   the asset: the page runs the real availability engine
   (`@access/scheduling/domain`) on labelled sample data in the browser.

## The one sentence and the one action

- The visitor must believe: **whoever asks, however they ask, one book holds
  and a time is never given twice.**
- The one action, one label everywhere: **Sign in.**

## Grammar: live surface

The honest pitch is "watch what it does", which is what this grammar is for.
The other seven lost:

- _Filmic one-shot:_ needs film or photography; a stock-looking clinic would
  be decoration, and the argument is behaviour, not atmosphere.
- _Chaptered editorial:_ staff arrive to sign in, not to read a feature.
- _Continuous world:_ there is no geography to travel through.
- _Typographic poster:_ the proof is a behaviour, not a sentence.
- _Gallery / catalog:_ there is no range of objects to walk.
- _Split stage:_ a before/after would have to invent a strawman "before".
- _Rhythmic cutlist:_ the wrong register for a healthcare tool.

Consequences held throughout: app chrome instead of marketing chrome (the
console's own rail, and its bottom tab bar on phones); copy in the surface's
idiom (page headers, status lines, a first-run help card, labels); no display
type stacks, no scrims, no photography; the close is an actual input.

## Honesty rule

Every panel is markup computing its state from data arrays in the page:
availability and refusals come from the Scheduling Core's own
`findAvailableSlots` and `checkSlot`, visit steps from its state machine. The
page says on its face that the practice, patients and morning are sample
data. The one external figure is real: the repository's concurrency test runs
25 simultaneous bookings of one time against PostgreSQL and asserts exactly
one booking and 24 `SLOT_UNAVAILABLE`. The page says where the real guarantee
lives (the database's exclusion constraint), not that the browser provides it.

## Signature move

**The race for your time.** In the WhatsApp act the visitor chooses the time
the patient taps. In the next act the tap and 24 other requests from reception,
the desk, WhatsApp and the waitlist arrive in the same 20 milliseconds. They
converge on that one cell; the first holds it; the other 24 are refused and
each settles into the next time the engine can still give, so the book fills
in a second with 25 bookings and not one overlap. A ledger totals it. Driven
by the page's own code off the act's `--sc-p`; the engine is untouched.

## Tell-someone sentence

It's the site where **you pick a time for a patient, and then twenty-five
people try to take that exact time at once and only one of them gets it.**

## Feeling curve

| Act             | Feeling                     | What causes it                                                                                                                                |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Today         | Recognition                 | The console already in a morning: arrivals, a doctor in consultation, a WhatsApp badge. Rows can be checked in.                               |
| 2 Every channel | Pressure                    | Requests arrive from phone, desk, WhatsApp, a referral letter and the waitlist, and each is placed on the book while the surface holds still. |
| 3 WhatsApp      | Intimacy                    | One patient, one conversation; the next day passes sideways, quarter hour by quarter hour, and the visitor chooses her time.                  |
| 4 Your time     | Awe, then relief (**peak**) | The ground goes dark, one cell is lit, silence; then 25 requests hit it at once and only one lands.                                           |
| 5 The record    | Trust                       | The appointment's history writes itself: held, confirmed, message sent with consent, reminder planned, 24 refusals logged.                    |
| 6 Sign in       | Readiness                   | A real input with a cursor in it, and the time the visitor chose, carried to the end.                                                         |

**The peak:** "Twenty-five requests hit the time I picked at the same moment,
one got it, and the other twenty-four just moved to the next free times."
It lives in act 4 and gets the largest span on the page.

**Authored silence:** the first fifth of act 4 is one lit cell on a dark ground
and nothing else. It is deliberate, not dead scroll; the harness reads the
stage's published state to tell the difference.

## Score

| Beat        | Act                               | Device                                  | Why this one                                                                     |
| ----------- | --------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Recognition | 1 Today (flow, natural height)    | `parallax` planes + fine-pointer `tilt` | Depth from overlap and differential rates on a working surface; nothing to scrub |
| Pressure    | 2 Every channel (`pin`, span 2.0) | `pin`                                   | The surface holds while its state advances                                       |
| Intimacy    | 3 WhatsApp (`pan`, span 2.6)      | `pan`                                   | Lateral travel through a day reads as a range of times                           |
| Peak        | 4 Your time (`pin`, span 3.2)     | `pin` + `count` + the signature move    | The largest span; the ledger counts real outcomes                                |
| Trust       | 5 The record (flow)               | `reveal`                                | Each history line is a change of state                                           |
| Readiness   | 6 Sign in (flow)                  | `flow` + `in`                           | An ordinary, reachable form; nothing pinned around an input                      |

Checks: six device families (parallax, pin, pan, count, reveal, flow);
no family twice in a row; zero `scrub`, zero `kinetic`, zero `spotlight`,
zero `drift` (grounds are painted per act); the peak's 3.2 is the largest span
by a visible margin over 2.6; about 10.9 viewport-heights in total, short
because a working surface should be.

## Fingerprint gate

The registry (`docs/front-page/FINGERPRINTS.md`) was empty: this is the first
build, so there was nothing to clear. Its row is appended after shipping.
