# Product assessment: patient access and AI value recovery

**Assessment date:** 19 September 2026

**Stage:** Discovery

**Recommendation:** Proceed with a tightly scoped patient-access wedge; validate
the broader value-recovery service through the same deployments before treating
it as a separate product.

## Executive assessment

The core insight is sound: reliable automation is created by redesigning a
workflow around outcomes, exceptions, and transaction boundaries—not by placing
an LLM in front of an unchanged process. The proposed architecture reflects
that insight particularly well in its separation of probabilistic language
understanding from deterministic execution.

There are two credible offers here, but they should not initially be run as two
equal product bets:

1. **DTM Access** is a vertical software product for referral intake and patient
   access. It has a defined user, workflow, transaction, and measurable outcome.
2. **AI Value Recovery** is initially a productised service for diagnosing and
   redesigning workflows around technology a health organisation already owns.
   It may later become software, but its repeatable data model and buying motion
   have not yet been demonstrated.

The recommended strategy is **one wedge, one shared measurement layer, and two
commercial motions in sequence**. Win a narrow DTM Access use case first. Use
its workflow map, event model, control framework, and benefit ledger as the
reference method for paid value-recovery engagements. Productise only the
patterns repeated across several customers.

## What is strong

### 1. The system boundary is correct

The proposed rule that an LLM must neither become the system of record nor
directly mutate appointments is the right production boundary. The model can
classify intent, extract constraints, summarise context, and propose a next
action. A typed command, policy service, workflow engine, and source system must
validate and execute that action.

This creates an auditable chain:

```text
utterance → model output → validated command → policy decision
          → workflow transition → connector response → patient confirmation
```

Each link can be tested, replayed, observed, and attributed to a version. That
is more defensible than relying on a conversation transcript alone.

### 2. The proposal understands transaction risk

Slot holds, idempotency, retries, and compensating actions are not secondary
implementation details; they are essential product behaviours. A reschedule
must preserve the original appointment until the replacement is committed.
Every externally visible mutation should be uniquely keyed and safe to replay.

### 3. Referral handling is a stronger wedge than a general receptionist

Referral intake joins document ingestion, patient matching, completeness
checks, exception routing, and scheduling. It therefore removes hand-offs
rather than merely deflecting questions. It also offers a clearer value story:
shorter referral-to-booking time, fewer abandoned referrals, less staff effort,
and higher conversion to a completed appointment.

### 4. The focus on captured capacity is commercially useful

“Minutes saved” is not a financial outcome. The benefit exists only when the
organisation converts time into throughput, lower overtime, avoided hiring,
redeployment, better slot use, or recovered revenue. Building an explicit
benefit ledger into the product would differentiate it from vendors that report
conversation counts or model accuracy without operational impact.

## What needs sharpening

### 1. Do not pursue two products simultaneously

The two offers share expertise but not necessarily buyers, sales cycles, or
delivery models. A specialist practice buying patient-access software is
different from an enterprise transformation sponsor buying workflow redesign.
Pursuing both as products now would split engineering, positioning, and sales.

Use this sequence instead:

| Phase | Offer | Goal |
| --- | --- | --- |
| 1 | DTM Access design partnership | Prove one workflow and its economics |
| 2 | Value-recovery diagnostic service | Test the method on existing AI estates |
| 3 | Shared control and telemetry components | Reuse proven software patterns |
| 4 | Standalone value-recovery platform | Build only after repeated demand |

### 2. Narrow the initial workflow

“Patient access” is still too broad for an MVP. Voice, messaging, scheduling,
referrals, authorisations, wayfinding, and records access create too many
integration and policy surfaces at once.

Start with **inbound referral completeness and status for one specialty**, using
asynchronous text channels and a staff console. Add self-scheduling only when a
referral has deterministically reached an eligible state. Defer open-ended
voice, medical-aid authorisation, record merges, and multi-specialty rule
engines.

### 3. Define the buyer and economic owner

The likely daily users are referral coordinators and access-centre staff, but
the economic buyer may be a practice owner, COO, access executive, or revenue
cycle leader. Discovery must establish who owns the budget and which P&L line
improves. A technically successful pilot without an identified economic owner
is likely to remain a pilot.

### 4. Treat claims as hypotheses until baselined

Industry benchmarks are useful for market framing, but they cannot establish a
customer business case. Volume mix, unresolved-contact rates, labour costs,
conversion, and capacity constraints must be measured at each customer. Claims
such as “71% automated” or “2.1× throughput” should be presented as target
examples until produced by a controlled deployment.

### 5. Correct and extend the ROI model

Use a time-bounded, incremental model:

```text
net benefit = captured labour capacity
            + contribution margin from incremental completed appointments
            + avoided leakage, overtime, and rework
            - incremental operating cost

ROI = (net benefit - implementation cost) / implementation cost
```

Report payback period alongside ROI. Avoid counting both saved labour and the
revenue produced by the same redeployed hours unless the values are demonstrably
incremental. Use contribution margin—not gross appointment revenue—for a
defensible economic case.

### 6. Add clinical-safety and operational-failure boundaries

Although the first workflows are administrative, patient messages can contain
symptoms, safeguarding concerns, or emergencies. The product needs a clearly
defined safety envelope: it must not diagnose or triage clinically unless a
separately governed clinical pathway is introduced. It should recognise likely
out-of-scope or urgent content, present approved emergency guidance, and route
to a human pathway without claiming clinical interpretation.

## Recommended MVP

### Target customer

A multi-provider specialist practice or focused specialty service with:

- material inbound referral volume;
- a visible backlog or repeated status calls;
- referrals arriving through a small number of channels;
- a cooperative practice-management-system owner;
- enough appointment demand that recovered capacity has value; and
- willingness to share an eight-to-twelve-week baseline.

### Job to be done

> When a referral arrives, determine whether it belongs to an existing patient,
> identify missing administrative information, obtain it, route exceptions, and
> keep the patient informed so that eligible referrals reach booking with the
> fewest staff touches.

### In scope

- referral ingestion from one or two controlled channels;
- document classification and structured extraction;
- patient-match suggestions with confidence bands;
- deterministic completeness rules by referral type;
- automated requests and reminders for missing administrative documents;
- patient-visible referral status;
- staff exception queue with reason codes and evidence;
- approved transition to scheduling or a scheduling hand-off;
- immutable audit events and operational/economic telemetry.

### Explicitly out of scope

- diagnosis, clinical prioritisation, or autonomous clinical triage;
- general-purpose voice receptionist;
- autonomous merges of patient records;
- cancellation of an existing appointment before replacement is committed;
- unsupervised changes to eligibility or specialty rules;
- broad EHR replacement; and
- a universal connector framework before the first connector proves demand.

### MVP success gates

Set exact thresholds with the design partner after baseline collection. At a
minimum, proceed beyond pilot only if all of these are demonstrated:

1. **Safety:** no uncontained high-severity patient-safety event and all urgent
   content follows the approved escalation path.
2. **Integrity:** no duplicate consequential write caused by a retry, and no
   original appointment lost during a failed reschedule.
3. **Quality:** patient matching and extracted fields meet agreed, field-level
   precision thresholds; uncertain cases abstain into review.
4. **Operations:** meaningful reduction in staff touches and referral cycle
   time without increasing downstream rework.
5. **Economics:** a signed benefit ledger shows captured capacity or incremental
   contribution margin, with an agreed payback period.
6. **Adoption:** staff use the exception queue and patients can complete the
   supported journey without creating compensating work on another channel.

## Product architecture recommendations

### Keep the architecture logical before making it physical

The proposed layers are good responsibility boundaries, but they should not all
become independent services at launch. Start with a modular application plus a
durable workflow engine and event store. Split services only for demonstrated
scaling, security, ownership, or deployment reasons. Premature microservices
would increase operational cost without improving the first customer outcome.

### Use typed contracts at the AI boundary

Every model output should be constrained to a versioned schema. Validation must
include semantic rules, not just valid JSON. For example, a requested date may
be syntactically valid but conflict with the selected slot, referral eligibility,
or local timezone. Low confidence, conflicting evidence, or missing identifiers
must produce an explicit abstention—not a guessed command.

### Model workflows as state machines

A referral might have states such as:

```text
received → identity_pending → documents_pending → admin_review
         → eligible_for_booking → booked

any state → exception | withdrawn | expired
```

Transitions need actor, timestamp, reason, policy version, input evidence, and
correlation ID. Business state should not be inferred later from chat history.

### Separate decisions from effects

Policy evaluation should yield an allow, deny, require-approval, or require-more-
evidence result before a connector runs. Connectors should be thin adapters that
accept typed commands, pass idempotency keys, preserve source-system identifiers,
and return normalised outcomes. A connector timeout is an unknown outcome until
the source system is reconciled; it is not automatically a failure safe to retry.

### Design for human recovery, not merely escalation

A human queue should include the reason for escalation, source evidence, actions
already attempted, current workflow state, next recommended action, and the
authority available to that user. Staff must be able to correct structured data,
resume the workflow, and label the root cause. Those labels become the roadmap
for expanding safe automation.

### Apply authority controls proportionately

Read-only appointment information and low-risk reminders should not carry the
same control burden as cancellations, record releases, identity merges, or
privilege changes. Define an action catalogue with risk tier, required identity
assurance, consent basis, approval rule, audit evidence, and rollback strategy.
Inntris should be evaluated against those requirements rather than inserted into
every request path by default.

## Measurement design

### Operational funnel

Measure an end-to-end funnel rather than isolated AI usage:

```text
referral received
→ patient confidently matched
→ administratively complete
→ eligible for booking
→ appointment offered
→ appointment booked
→ appointment completed
```

For every stage, capture elapsed time, staff touches, exceptions, abandonment,
and channel switching. Segment results by specialty, referral source, workflow
version, and automation path so aggregate improvement does not conceal a weak or
unsafe subgroup.

### Benefit ledger

Each claimed benefit needs:

- a named metric owner;
- baseline period and source;
- counterfactual or comparison method;
- calculation and assumptions;
- capture mechanism (for example, avoided overtime or added completed visits);
- finance approval; and
- confidence level.

Track model costs, messaging, integration support, exception labour, monitoring,
and change-management time as operating costs. The product should expose both
gross automation benefit and net realised benefit.

### Evaluation method

Use a staged rollout where operationally safe:

1. establish a representative baseline;
2. run in shadow mode and compare proposed decisions with staff decisions;
3. enable assisted processing for a limited cohort;
4. use a concurrent comparison group or interrupted time-series analysis;
5. reconcile downstream rework and completed appointments; and
6. obtain finance sign-off before publishing ROI.

## Commercial recommendation

### DTM Access

Price initially as implementation plus recurring platform usage, with volume
bands based on completed workflows rather than raw conversations. Avoid pure
outcome pricing until attribution, customer capacity, and data access are
reliable. An optional performance component can align incentives after the
baseline has been signed.

### AI Value Recovery

Offer a fixed-scope diagnostic rather than an open-ended transformation project:

1. baseline one workflow and its economics;
2. map work, systems, controls, and exceptions;
3. identify where existing AI does and does not remove work;
4. produce a redesigned target workflow and benefit ledger;
5. implement one measurable change; and
6. verify the result after a fixed observation period.

The deliverable should be a decision-ready investment case plus an executable
workflow specification—not another AI strategy presentation. Software should
support evidence collection and monitoring, but consulting remains the honest
delivery model until repeated engagements reveal a stable product surface.

## Key risks and mitigations

| Risk | Why it matters | First mitigation |
| --- | --- | --- |
| Source-system integration | Can dominate time and erase ROI | Qualify APIs and write semantics before sale |
| Identity mismatch | Can expose or alter the wrong record | Confidence tiers, step-up verification, human review |
| Hallucinated status | Creates patient harm and distrust | Status only from workflow/source-system state |
| Automation bias | Staff may accept plausible wrong output | Show evidence, uncertainty, and require review by risk |
| Hidden downstream work | Apparent savings shift burden | Measure the full funnel and rework for 30–90 days |
| Uncaptured time savings | Efficiency never reaches the P&L | Agree capacity-capture action with the buyer upfront |
| Channel duplication | Patients contact staff after automation | Correlate contacts and measure repeat demand |
| Rule drift | Referral and scheduling rules change | Versioned rules with owners and review dates |
| Vendor/model dependency | Cost or behaviour can change | Model abstraction, evaluations, and fallbacks |
| Scope creep into clinical care | Changes regulatory and safety obligations | Explicit safety envelope and governed escalation |

## Ninety-day validation plan

### Days 1–30: evidence before build

- Interview the economic buyer, workflow owner, frontline staff, integration
  owner, privacy/security owner, and finance partner at three candidate sites.
- Observe at least 30 referrals end-to-end; do not rely only on workshops.
- Collect baseline volume, stage times, staff touches, failure demand, conversion,
  downstream rework, and staffing cost.
- Select one specialty and document its administrative completeness rules.
- Verify source-system read/write APIs and reconciliation behaviour.
- Obtain agreement on the benefit ledger and capacity-capture mechanism.

### Days 31–60: shadow and assisted mode

- Implement ingestion, typed extraction, patient-match suggestions, rules, and
  an exception console.
- Run prospective shadow evaluations on representative traffic.
- Test ambiguous identity, duplicate messages, connector timeout, concurrent
  booking, stale availability, missing documents, consent withdrawal, and urgent
  content scenarios.
- Begin assisted processing only after the safety and data-quality gates pass.

### Days 61–90: limited live workflow

- Enable automation for a bounded cohort and retain a valid comparison.
- Review exceptions and near misses daily at first.
- Reconcile every consequential action against the source system.
- Measure the complete referral-to-completed-appointment funnel.
- Ask finance and operations to sign off realised—not theoretical—benefits.
- Decide to expand, revise, or stop using the predefined success gates.

## Evidence still required

The market statistics and external claims supplied with the concept should be
retained as supporting context only after their publication dates, samples,
definitions, denominators, and exact wording have been checked against primary
sources. In particular, validate whether percentages refer to all surveyed
organisations or only those measuring ROI, and distinguish association between
workflow redesign and EBIT impact from causation.

Before an investor deck, customer proposal, or public website uses any benchmark,
maintain a claim register containing the primary URL, publication date, access
date, exact claim, population, geography, and approved paraphrase. This protects
the otherwise strong thesis from being weakened by an imprecise headline.

## Decision

Proceed, subject to three constraints:

1. make referral completeness-to-booking the initial wedge;
2. sell AI Value Recovery as a bounded service until repeatability is proven;
3. require measured capacity capture and transaction integrity—not interaction
   volume—as the conditions for success.

The moat is unlikely to be the conversational interface or model. It can emerge
from the combination of healthcare workflow definitions, safe execution,
identity integrity, integration reliability, exception data, and a finance-
credible record of realised outcomes.
