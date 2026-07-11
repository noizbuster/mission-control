# Async Behavior Graph Theory Design Document

**Document purpose:** Define the theory, vocabulary, and normative execution semantics of Async Behavior Graphs for observable, controllable LLM-agent workflows.

**Scope:** This document is a standalone design reference. It describes what an ABG runtime means, how its graph elements relate, and which guarantees are needed for reliable operation. It does not prescribe a programming language, interface, storage format, provider, or deployment architecture.

**Normative language:** **MUST**, **SHOULD**, and **MAY** are the only normative keywords in this document. **MUST** denotes a mandatory conformance requirement. **SHOULD** denotes a strongly recommended default that may be omitted only with a documented, safe justification. **MAY** denotes an optional extension that cannot weaken a MUST requirement. Lowercase modal words are explanatory and non-normative.

---

## 1. Executive Summary

**Async Behavior Graph**, abbreviated as **ABG**, is a graph-based orchestration model for LLM agents. It combines behavior selection, long-running procedures, isolated asynchronous work, streaming observations, human intervention, policy enforcement, and recovery into one operational model.

ABG does not discard Behavior Trees. A Behavior Tree is a useful subset of a broader model. Behavior Trees answer this question:

```text
Given the current situation, what should the agent do next?
```

ABG expands the question:

```text
Given events, changing context, active procedures, running actors,
policy constraints, human intervention, and partial results,
what should start, continue, stop, wait, recover, or be recorded?
```

ABG combines ideas from several established models:

- **Behavior Trees** for conditions, priority, selection, and fallback.
- **Statecharts** for explicit state transitions in long-running procedures.
- **Actor systems** for isolated work, messaging, supervision, cancellation, and restart.
- **Reactive streams and dataflow** for asynchronous events, partial results, and backpressure.
- **Event sourcing** for audit, reconstruction, and replay.
- **Policy systems** for behavioral guidance, resource authorization, approval, cost, time, and quality constraints.

A concise definition follows:

> An Async Behavior Graph is an event-driven decision and execution model that uses stateful workflows, actors, streams, and policy to select, run, observe, revise, and recover agent behavior.

An ABG control plane lets operators author, run, inspect, replay, and steer those graphs. Its value comes from making the process visible and governable, not merely from producing a final answer.

---

## 2. Why a New Concept Is Needed

A conventional function often has this shape:

```text
input -> function -> output
```

An LLM-agent workflow is usually closer to this:

```text
user request
  -> assess intent
  -> gather context
  -> plan
  -> perform actions
  -> observe partial results
  -> revise or ask a human
  -> validate
  -> stream a response
```

Several problems arise at once.

### 2.1 Situation-dependent behavior selection

The agent must repeatedly decide what to do next:

```text
Answer now?
Gather more evidence?
Perform an external action?
Ask a human?
Wait for approval?
Stop because the result is sufficient?
```

Behavior Trees help with this question, but they are only part of the answer.

### 2.2 Long-running workflows

One request may involve many steps:

```text
inspect -> plan -> act -> validate -> repair -> summarize
```

These steps can pause, await a human decision, retry, fail, checkpoint, and resume. A useful model MUST represent those states explicitly.

### 2.3 Asynchrony and parallelism

Independent observations and actions can run concurrently. Some finish early, some stream for a long time, and some become irrelevant after new evidence arrives. Concurrency, early stop, aggregation, and cancellation therefore need graph semantics rather than incidental control flow.

### 2.4 Streaming results

Model output, external-action progress, observations, and human input often arrive incrementally. Treating all work as a single final result hides the process that operators need to inspect and control.

### 2.5 Mid-run human intervention

Humans may correct scope, provide missing information, grant or deny approval, redirect the effort, or cancel it. ABG treats intervention as an ordinary event with defined delivery semantics, not as an exceptional escape hatch.

### 2.6 Failure recovery

Agent systems encounter faults such as unavailable resources, invalid proposals, time limits, conflicting evidence, stale context, and weak results. A graph that only expresses the happy path is incomplete. A **failure** is the authoritative, typed account of a failed admission, execution, settlement, compensation, or recovery operation. A **cancellation** is ordinary control flow, not a failure. A valid policy or authorization **denial** is a committed pre-start admission result, not a failure and not a Node terminal outcome. Section 13 defines these distinctions and their recovery rules.

### 2.7 Operational visibility

An operator should be able to ask:

```text
Why did this action occur?
What caused this actor to start?
Why did the path change?
Why is the run blocked?
What evidence supports the result?
Can state be reconstructed?
Can a controlled replay be performed safely?
```

ABG supplies the structure needed to answer those questions.

---

## 3. Relationship to Existing Methodologies

### 3.1 Relationship to Behavior Trees

A Behavior Tree commonly returns one of three statuses:

```text
SUCCESS | FAILURE | RUNNING
```

It is strong at priority selection, readable branching, conditions, and fallback. For LLM agents, however, `RUNNING` is too coarse. Ongoing work may emit many meaningful facts:

```text
action started
progress observed
partial result available
authority denied
retry scheduled
action completed
action failed
```

ABG retains Behavior Tree selection semantics while expanding node output into a Signal stream:

```text
RUNNING -> started plus zero or more progress Signals
SUCCESS -> `succeeded` terminal Signal candidate
FAILURE -> `failed` terminal Signal candidate
```

### 3.2 Relationship to Statecharts

A Statechart models states and transitions explicitly:

```text
idle -> planning -> executing -> observing -> responding
```

ABG may use a Statechart as a composite node for a long-running procedure. Statecharts provide procedural structure without forcing all agent behavior into one fixed state machine.

### 3.3 Relationship to the Actor Model

Actors are isolated execution entities that communicate by messages. They fit LLM agents because many activities are independent, cancellable, and failure-prone: model turns, external actions, retrieval, validation, monitoring, and delegated work.

ABG uses actors as the execution layer beneath decision and workflow structure. Actor isolation does not remove accountability. Each actor MUST have an identity, lifecycle, authority boundary, and result contract.

### 3.4 Relationship to Reactive Streams and Dataflow

LLM-agent systems are streaming systems. Their streams may carry user input, model deltas, partial observations, action progress, timers, policy decisions, and completion facts.

```text
Event streams
  -> decision graph
  -> action and observation streams
  -> runtime-applied state changes
  -> new Event streams
```

The key question is not only whether work completed. It is also what is flowing now, how much of it can be accepted, and how that flow should change behavior.

### 3.5 Relationship to Workflow Engines

Workflow engines emphasize reliable execution of a known procedure. ABG overlaps with that concern but centers on a different problem:

```text
Observe a changing situation and dynamically select or revise the procedure.
```

ABG includes durable workflow ideas while keeping behavior selection, intervention, and partial observation central.

---

## 4. Core Philosophy

### 4.1 An agent is a running system

An LLM agent is better understood as a running system with state, memory, events, policies, actors, and an event loop than as a single function call.

```text
Agent = graph + policy + memory + actors + event loop
```

### 4.2 Behavior is a process, not only a result

A behavior includes start, progress, partial output, retry, cancellation, failure, recovery, and completion. These are semantic parts of behavior, not incidental diagnostics.

### 4.3 Decision and execution are separated by layers

ABG uses five cooperating layers. Policy is cross-cutting rather than a competing sixth layer.

```text
Mission layer       : durable productive intent and Run catalog
Decision layer      : selection, guards, priority, and routing
Workflow layer      : procedures, state transitions, recovery, and coordination
Actor layer         : isolated model, human, memory, and external-action work
Event and record layer: Signals, Events, Streams, Log Records, and projections

Cross-cutting policy: guidance, authority, budgets, quality gates, and approval
```

Each layer has a distinct role. Decision chooses behavior. Workflow organizes it. Actors perform it. The event and record layer makes it observable. Policy constrains every layer without replacing their responsibilities.

### 4.4 Important changes become facts

The Event Log is the operational ledger, not debug output. Its durable Log Records capture important admissions, decisions, state transitions, actor lifecycle changes, authority outcomes, intervention, and terminal outcomes. A Timeline is a human and operational projection of that ledger.

### 4.5 The LLM is a participant, not the runtime

An LLM may plan, classify, propose actions, critique, summarize, or respond. It MUST NOT be treated as the entire orchestration system. Explicit graph structure, policy, and recorded facts make its behavior inspectable and governable.

---

## 5. Core Concepts

### 5.1 Authored Graph and Effective Graph

An **Authored Graph** is the immutable declarative input: nodes, edges, declared bindings, baseline policy, and metadata. It describes intended behavior before runtime preparation.

An **Effective Graph** is the graph that execution uses after materialization. Materialization is a pure, deterministic transformation:

```text
Effective Graph = materialize(Authored Graph, declared overlays)
```

Materialization MUST NOT mutate the Authored Graph. Overlays compose in their declared order, so an author can reason about the result. An ABG runtime SHOULD record the identity or content address of the Effective Graph used by each Run.

### 5.2 Node

A Node is a unit of behavior that consumes declared inputs and emits a stream of Signals. A node does not directly mutate shared runtime state.

```text
Node(Context view, input Event streams) -> Signal stream
```

ABG has a small set of primitives and specializations:

- **Condition Node** evaluates a predicate.
- **Action Node** performs work. Memory access, model turns, and external actions are Action specializations.
- **Selector Node** chooses a candidate path.
- **Sequence Node** coordinates ordered children.
- **Parallel Node** coordinates concurrent children or collection fan-out.
- **Race Node** chooses the earliest valid committed success under a declared validity rule.
- **Join Node** combines declared inputs with an explicit merge contract.
- **Watch Node** monitors declared Event patterns and applies a declared response.
- **Statechart Node** is a composite workflow node with explicit states and transitions.
- **Actor Node** creates, addresses, awaits, parks, revives, or cancels an actor.
- **Human Node** awaits a human response, approval, or selection.
- **Policy Gate** evaluates a declared policy decision before a protected transition or action.

A Decision Node is a Selector specialization. A Workflow Node is a Statechart Node or another composite node. A Critic and a Quality Gate are patterns built from Action, Condition, Selector, Join, and Policy Gate nodes, not unrelated primitives.

Each requested use of a Node has a stable `nodeInvocationId` derived from a committed `activationIdentity`. An activation identity binds the causal Event, transition, or Edge; target Node; coordination generation; declared occurrence or item identity; and security scope. Duplicate delivery of the same activation MUST reuse its one invocation and MUST NOT mint a new invocation or effect identity. A committed admission decision has an `admissionDecisionId`; an admitted start creates a unique `nodeExecutionId` and an `attemptOrdinal`. The invocation identifies the requested work across retries. The execution identifies one admitted attempt. A Node result is governed by its declared result contract. At-most-one settlement is unconditional; eventual settlement with terminal outcome `succeeded`, `failed`, or `cancelled` is conditional on the Section 13.3 requirements.

### 5.3 Edge

An Edge connects nodes and declares control flow, data flow, Event routing, guards, mapping, priority, or cancellation scope. Every edge SHOULD state what activates it and how it handles the payload it carries.

### 5.4 Event, Signal, Stream, and Log Record

These terms have different meanings.

- A **Signal** is an execution emission from a Node to the runtime. It may request a transition, report progress, propose actor work, submit a result, or report a terminal outcome.
- An **Event**, also called an **admitted Event**, is an immutable fact admitted by runtime interpretation together with a durable Log Record. Examples include a received request, an admitted decision, an actor completion, or a granted approval.
- A **Stream** is an ordered flow of Signals or Events. It may carry transient Signals, but every Event it carries has a Log Record.
- A **Log Record** is the durable envelope for an Event. It includes identity, ordering, time, source, correlation, causation, and payload or payload reference.

The **Event Log** is the immutable sequence of durable Log Records and the sole authoritative source of execution facts. Signals and observations may remain transient. An item without a Log Record is a Signal or observation, not an Event. Runtime Event admission MUST append the Event's Log Record before the Event becomes visible, or commit both atomically. If that append fails, no Event is admitted. Node-start admission results are Events with Log Records and follow the distinct pre-start semantics in Section 13.2; they are not inferred from a Node lifecycle projection.

Log Record scope is explicit. Run-scoped records describe one execution attempt. Mission-scoped records describe Mission catalog changes and causal links among Runs. Cross-Run timelines and other views are projections over those Run-scoped and Mission-scoped records; they are never an independent authority.

Correlation groups facts that belong to the same larger intent. Causation identifies the prior fact or decision that directly caused a fact. Correlation is not a substitute for causation.

### 5.5 Context, Blackboard, State, Memory, and Log

**Context** is the read-oriented view supplied to a node. It may contain Mission intent, current Run state, selected memory, declared authority, and relevant observations.

**Blackboard** is runtime-managed structured working memory for the current coordination scope. It is not a free-form shared object and it is not the same as a model prompt.

**State** is the current runtime snapshot: active nodes, workflow state, actor lifecycle, pending authority decisions, counters, and declared Blackboard values.

**Memory** is reusable knowledge such as preferences, prior facts, summaries, retrieved material, or validated artifacts. A context packer selects memory for a particular decision or model turn.

**Event Log (Log)** is the immutable sequence of durable Log Records and the sole authoritative source of execution facts. State can be reconstructed from the Event Log plus declared deterministic rules. Memory may be derived, referenced, or independently retained, but its provenance should be visible when it affects a decision.

### 5.6 Structured Blackboard Bindings

An Authored Graph may declare structured output bindings. A binding names a Blackboard key, identifies the producing node or transition, and declares an expected shape.

```text
producer output
  -> boundary parser
  -> shape validation
  -> admit Blackboard-update Event with its Log Record
  -> apply Blackboard projection atomically with admission,
     or only after the append succeeds
```

The boundary parser MUST accept only the declared representation. If parsing or shape validation fails, the update fails closed. The runtime records the failure and follows the graph's failure path. It MUST NOT silently write unstructured text, guessed values, or partial data to the Blackboard.

If the required Log Record append fails, no Event or Blackboard update is committed or made visible. A runtime MAY use an atomic record-plus-projection transaction. This rule reconciles structured working memory with the prohibition on arbitrary node mutation: Nodes propose declared updates through Signals; the runtime validates, admits an Event with its Log Record, and then applies those updates.

### 5.7 Mode and Overlay

A **Mode** is a named, declared overlay applied during materialization. It can contain three distinct elements:

- Behavioral guidance that shapes how applicable actor or Action Nodes reason.
- Enforceable policy additions that add constraints or gates.
- Resource authorization attenuation that removes or narrows authority for applicable nodes or actors.

Guidance is not authorization. A prompt or instruction can influence behavior but cannot grant access. Policy additions and authorization attenuation are runtime-enforced.

Behavioral guidance MAY use deterministic declared precedence. Guidance and behavioral policy rules MUST declare how they compose; when their ordered rules conflict without a declared resolution, materialization MUST fail closed.

Resource authorization is monotone decreasing, not precedence-based. Let `A0` be the baseline authorization constraint from the Authored Graph and `Ai` be the restriction imposed by overlay `oi`. Each authorization constraint governs capability, resource, scope, time, purpose, and approval requirements. Effective authorization is their meet:

```text
Aeff = A0 meet A1 meet ... meet An
```

An operation is allowed only when every applicable constraint permits it. Baseline and parent denies are deny-preserving and MUST NOT be relaxed by a later overlay. Approval requirements MUST be preserved or strengthened. Ambiguous authorization composition MUST fail closed. Authority expansion MUST require a changed baseline authorization in a revised Authored Graph and a new materialization, not a Mode.

### 5.8 Policy

Policy has two separate jobs:

- **Behavioral policy** guides selection, quality, budgets, confidence, retry, and escalation.
- **Resource authorization** decides whether an actor may use a capability or perform a protected effect under the applicable resource, scope, time, purpose, and approval constraints.

They can cooperate at a Policy Gate, but neither should be confused with the other. A quality preference does not grant authority, and a resource grant does not prove an action is wise.

---

## 6. Layered Architecture

An ABG runtime may expose many operational surfaces, but its theory is organized around the five layers in Section 4.3:

```text
┌──────────────────────────────────────────────┐
│ Operator interface and control plane          │
├──────────────────────────────────────────────┤
│ Mission layer                                 │
├──────────────────────────────────────────────┤
│ Decision layer                                │
├──────────────────────────────────────────────┤
│ Workflow layer                                │
├──────────────────────────────────────────────┤
│ Actor layer                                   │
├──────────────────────────────────────────────┤
│ Event and record layer                        │
└──────────────────────────────────────────────┘

Policy crosses every layer.
```

### 6.1 Operator interface and control plane

An operator interface presents the Timeline, active graph state, actor state, authority decisions, artifacts, and controls for steer, queue, interrupt, resume, and replay. It is an operational surface, not merely a display.

### 6.2 Mission layer

A Mission is durable productive intent: a goal, constraints, selected graph, authority context, artifacts, and a catalog of Runs. A Mission is not a transient execution status.

### 6.3 Decision layer

The Decision Layer selects a next behavior using Events, Context, policy, and declared selection rules. It answers why a path was chosen and why alternatives were rejected.

### 6.4 Workflow layer

The Workflow Layer organizes selected behavior through sequences, state transitions, branches, joins, retries, compensation, checkpoints, and coordination rules.

### 6.5 Actor layer

The Actor Layer performs isolated work. Model turns, human interaction, memory retrieval, and external action are actor or Action specializations with explicit identity and authority.

### 6.6 Event and record layer

The Event and Record Layer routes Streams, handles backpressure, creates durable Log Records, supplies reconstruction inputs, and projects facts into human-readable views.

---

## 7. Execution Semantics

### 7.1 ABG is event-driven

ABG is primarily event-driven. When a relevant Event arrives, declared edges and subscriptions determine which nodes may react. A runtime MAY use periodic maintenance internally, but ticks MUST NOT replace declared Event semantics.

### 7.2 Node execution is a Signal stream

Node execution has this conceptual shape:

```text
start
  -> zero or more progress or proposal Signals
  -> zero or more terminal Signal candidates: succeeded, failed, or cancelled
  -> exactly one committed settlement when Section 13.3 liveness conditions hold:
     succeeded, failed, or cancelled
```

Terminal Signals are candidates, not settlements. Some Nodes may remain active until a cancellation, timeout, or other declared Event arrives. Such Nodes still need an explicit terminal outcome through committed settlement.

### 7.3 The runtime interprets Signals

Nodes propose effects through Signals. The runtime interprets them against the Effective Graph and Policy:

```text
Node Signal -> runtime interpretation -> admit Event with Log Record -> visible state transition or action
```

The runtime, not an arbitrary node, owns shared state mutation, actor registration, durable recording, and protected effects. The terminal path is `candidate -> AcceptCandidate -> SelectOutcome -> Settle`. An accepted candidate is not ready to settle by itself; `SelectOutcome` must commit the immutable outcome, and `Settle` must complete required draining, ownership, effect, and release or transfer accounting. An audit-critical state change becomes visible only after its Event Log append succeeds, or as part of an atomic append-plus-projection commit. If the append fails, the runtime MUST expose no admitted Event or committed state change and MUST follow the declared failure path.

### 7.4 Causality and correlation

Every audit-critical Event MUST carry enough information to establish its causal predecessor or declared root cause. A root Event MAY have no prior cause. Derived Events SHOULD identify the Event, decision, or transition that caused them.

Correlation links all Events associated with a Mission, Run, request, or workflow scope. Causation answers why one fact followed another. Both are needed for a defensible Timeline.

### 7.5 Deterministic core and observed boundary

Graph traversal, policy evaluation, materialization, state transition rules, and bounded counters SHOULD be deterministic for the same Effective Graph and recorded inputs. External observations, human choices, and model output may be nondeterministic. The runtime records those observations as facts so reconstruction does not pretend they can be recomputed.

### 7.6 Admission-before-start and settlement axioms

Node-start admission is outside the Node lifecycle. Under a composite admission key or atomically ordered multi-key operation, an admitted operation MUST atomically validate current authority and approval; consume any bound one-use approval; create the unique Node execution and initial ownership epoch; reserve bounded resources and applicable permits; append the final `admitted` Event containing its execution identity and attempt ordinal; and make the whole operation visible together. No component becomes visible before that atomic operation commits. A committed admitted decision is final for its invocation and pending attempt ordinal; later duplicate wakeups cannot create another admission result. `deferred`, `denied`, and `rejected` create no execution and MUST NOT fabricate a Node terminal outcome.

Every started execution MUST follow the exactly-one settlement rule: it has at most one committed settlement Event with terminal outcome `succeeded`, `failed`, or `cancelled`, and it settles when the conditional liveness requirements are met. Candidate Signals, duplicate deliveries, and conflicting reports do not alter that invariant. Eventual settlement is conditional on continued runtime operation, Event Log availability, committed outcome selection, completion of required draining, ownership transfer or orphan accounting, and effect accounting, plus readiness for reservation release or transfer to commit atomically with settlement. Section 13 is authoritative for admission, settlement, retries, timing, and fault recovery.

---

## 8. Core Node Types

### 8.1 Condition Node

A Condition Node evaluates a declared predicate against its Context view. A valid evaluation, including `matched = false`, settles `succeeded` with the declared predicate result. Only evaluation malfunction settles `failed` with a FailureEnvelope. A false predicate is ordinary routing and MUST NOT trigger retry, breaker counting, poison detection, or failure propagation. A Condition Node SHOULD NOT perform unbounded work or hidden side effects.

### 8.2 Action Node and specializations

An Action Node performs work and commonly emits progress before its terminal Signal. A memory action retrieves or writes knowledge under policy. A model action produces a model turn. An external-action node proposes or performs a protected effect. These are Action specializations, not separate primitive kinds.

### 8.3 Selector Node

A Selector Node MUST choose one or more candidate paths according to a declared strategy such as priority, first valid result, score, policy-filtered selection, or bounded model-assisted selection. A valid no-match settles `succeeded` with declared `selection = none` routing data. Evaluator or model-assisted selection malfunction settles `failed` with a FailureEnvelope. Ordinary no-match MUST NOT trigger retry, breaker counting, poison detection, or failure propagation. A Selector MUST record the selected path or `none` and a reason when the choice is audit-relevant.

### 8.4 Sequence Node

A Sequence Node MUST start children in declared order. For each child it MUST declare handling for every admission result, every terminal outcome, missing input, and permitted partial or degraded result: wait, fail, skip, retry, compensate, branch, or continue. It MUST declare whether and how an active sibling or predecessor is drained when the sequence changes route.

### 8.5 Parallel Node

A Parallel Node has two distinct forms.

**Static parallel branches** MUST start the declared independent branches concurrently. A runtime MUST NOT call sequential execution a Parallel Node. The node MUST declare handling for every admission result, terminal outcome, missing input, partial or degraded result, sibling cancellation or draining, completion rule, and deterministic result aggregation.

**Collection-driven template fan-out** MUST read a declared collection, instantiate one template child per item, and run those children under an explicit bounded concurrency limit. It MUST declare:

- The collection source and item binding.
- The maximum active children.
- The per-child result and failure representation.
- The handling of every admission result, terminal outcome, missing input, and partial or degraded result.
- Whether failure is isolated or fails the parent.
- The aggregate result shape and aggregation rule.
- The completion rule.
- The sibling cancellation and draining rule.
- An optional completion marker written only after the declared completion rule is satisfied.

Fan-out MUST preserve enough item identity and ordering information for an operator to associate each result or failure with its input item.

### 8.6 Race Node

A Race Node MUST start declared competitors concurrently and select the earliest valid committed success under an explicit validity rule. The first terminal result is not automatically the winner. It MUST declare handling for every admission result, terminal outcome, missing input, partial or degraded result, and loser cancellation or draining. Its winner and aggregate are determined by committed ordering, not nondeterministic arrival.

### 8.7 Join Node

A Join Node MUST combine declared results or streams after a declared readiness condition. Its merge contract MAY append, deduplicate, reconcile, vote, summarize, or apply another named operation. A Join MUST specify handling for every admission result, terminal outcome, missing input, partial or degraded result, sibling cancellation or draining, and deterministic aggregation order. Ranking is a merge strategy, not a separate primitive Node type.

### 8.8 Watch Node

A Watch Node MUST monitor declared Event patterns while a scope is active. Its response MAY redirect, cancel, pause, request authority, or update a declared coordination state. A Watch Node MUST state its subscription scope, priority, and termination condition.

### 8.9 Policy Gate

A Policy Gate MUST evaluate behavioral policy and resource authorization before a protected transition or action. A successful gate result MAY carry `allow`, `deny`, or `request-human-decision` as its declared decision value. Evaluation malfunction is a failure, not a valid denial. It MUST NOT replace Selector, Condition, or Action semantics.

The protected invocation then enters Node-start admission with exactly `admitted`, `deferred`, `denied`, or `rejected` semantics. Missing requestable approval is `deferred`; an explicit refusal is `denied`; malformed evidence is `rejected`. The gate and protected invocation MUST declare their result, wait, and routing behavior independently.

### 8.10 Statechart Node

A Statechart Node MUST encapsulate a long-running composite procedure with declared states, entry and exit behavior, transitions, Event guards, terminal states, and recovery paths. It MUST declare handling for every child admission result, terminal outcome, missing input, partial or degraded result, sibling cancellation or draining, and deterministic state aggregation.

### 8.11 Actor Node

An Actor Node manages an actor through declared operations such as spawn, send, await result, park, revive, cancel, or stop. It MUST NOT hide the actor's identity or authority boundary.

### 8.12 Human Node

A Human Node MUST await a human response, approval, selection, correction, or supplied information. Approval is one use of a Human Node. The response is a Signal or observation until runtime admission creates an Event with a Log Record, which MUST be correlated with the request that elicited it.

---

## 9. Graph Control Patterns

### 9.1 Observe -> Decide -> Act -> Observe

The basic ABG loop is explicit:

```text
observe Event
  -> update runtime-owned state
  -> select behavior
  -> perform or coordinate work
  -> observe resulting Events
```

### 9.2 Plan -> Execute -> Monitor -> Replan

A plan is a versioned working artifact, not an irrevocable script. Execution observes actual results, verifies assumptions, and replans when a declared condition requires it.

### 9.3 Speculative parallelism

An agent may pursue several useful evidence paths concurrently and then Join their outputs. This is valid only when the graph supplies a real Parallel or Race contract, bounded resource use, and a defined result-selection rule.

### 9.4 Early stop

When a declared sufficiency condition is met, a Watch, Selector, or completion rule can cancel remaining work and proceed. Early stop MUST account for active work rather than silently abandoning it.

### 9.5 Human-in-the-loop

Human intervention enters as Events and follows the same causal, correlation, policy, and Timeline rules as other operational facts.

### 9.6 Supervisor pattern

A supervisor observes child outcomes and applies a declared response: retry with a changed condition, restart, use a fallback, request human input, salvage partial results, or fail the parent scope. Blind repetition is not supervision. Supervisor authority, restart, escalation, and draining semantics MUST conform to Section 13.9.

---

## 10. LLM-Agent-Specific Design

### 10.1 A model turn is an Action or Actor specialization

A model turn can stream output, propose actions, consume budget, fail, or be cancelled. Treating it as a managed Action or actor gives the graph a place to record its inputs, outputs, policy decisions, and terminal outcome.

### 10.2 Decompose roles when useful

An LLM may fill roles such as planner, classifier, critic, summarizer, responder, or argument generator. A graph may separate these roles to improve failure localization, policy control, and evaluation. Separation is a design choice, not a requirement to multiply agents.

### 10.3 Proposed actions require admission

A model-proposed action is not automatic execution:

```text
proposal Signal
  -> runtime admits and records proposal Event when it becomes execution-relevant
  -> validate declared arguments
  -> evaluate authority and behavioral policy
  -> submit the protected invocation for node-start admission
  -> start only after admitted, or route deferred, denied, or rejected
```

Proposal, validation, policy evaluation, and protected start are separate facts. A proposal or valid gate result cannot itself create a protected execution.

### 10.4 Prompt context is not runtime memory

Runtime memory includes facts, summaries, artifacts, prior decisions, and validated observations. A context packer selects relevant material for a particular model turn. The packer SHOULD record what sources influenced audit-critical decisions.

### 10.5 The final response can stream

A response may have a start, incremental content, cited evidence, produced artifacts, and completion. Each item emitted by the responding Node is a Signal. Runtime interpretation MAY admit a Signal as an immutable Event with a Log Record. The stream's durability class determines which Signals or observations are admitted; it never changes whether an item is a Signal or an Event.

### 10.6 Critic and Quality Gate patterns

A Critic is an evaluation Action that produces structured findings. A Quality Gate decides whether the declared acceptance criteria were met. For high-assurance work, an all-must-approve aggregation is a valid fail-closed pattern: the result passes only when every required independent approval is positive. A graph MUST define the required evaluators, evidence, and rejection route.

---

## 11. Operational Concepts

### 11.1 Mission

A Mission is durable productive intent. It contains a goal, constraints, selected graph, authority context, artifacts, and Run catalog. Its catalog lifecycle is separate from execution state:

```text
draft -> ready -> active -> archived
```

`active` means the Mission may accept or retain Runs. It does not mean a particular Run is executing.

### 11.2 Run

A Run is one execution attempt for a Mission and one Effective Graph. Its lifecycle is distinct:

```text
pending -> running -> blocked -> running
running -> completed | failed | cancelled
blocked -> cancelled
```

A committed resume Event labels the `blocked -> running` transition; `resumed` is not a Run state. A Run MAY enter `blocked` for a human decision or another declared admissible wait. Terminal Run states are `completed`, `failed`, and `cancelled`. Terminal Signals map to those terminal facts only through committed Events and declared aggregation rules.

A deferred Node-start admission may establish a declared Run wait, but it creates no Node execution and no Node lifecycle state. Denied and rejected admissions are recorded facts that route by the graph contract. They do not add a Run terminal state. Node settlement, retry, and timeout rules are defined by Section 13.

### 11.3 Event Timeline

The Event Timeline is a human and operational projection of the authoritative Event Log for a Run. It is never an independent source of truth. Run-scoped records cover that attempt; Mission-scoped records cover catalog changes and causal links among Runs. A cross-Run Timeline is a projection over both scopes and SHOULD make causal chains and state transitions inspectable.

### 11.4 Input delivery and drain lanes

Every conforming ABG runtime MUST provide steer and queue delivery semantics for mid-run input.

A **coordination key** identifies the mutually exclusive scope for demands that could otherwise race to change the same Run state. A **drain lane** owns ordered admission for one coordination key. A **generation** is one uniquely identified active admission cycle in that lane.

- **Steer** adds a correction or instruction to the active generation at its next safe admission boundary.
- **Queue** holds a later demand until the active generation reaches a declared handoff point or terminal outcome.
- A **safe admission boundary** is a declared point at which active state is coherent, no required record-plus-projection commit is incomplete, and accepting input cannot violate a graph invariant.
- A **compatible demand** has the same coordination key, passes current authority and policy, and can be combined without contradicting the active generation's declared invariants or accepted intent.
- **Coalescing** combines compatible demands into the active generation while preserving their causal identities.
- **Queue promotion** admits the next valid queued demand after the current generation settles or reaches its declared handoff point.
- **Interrupt** begins cooperative cancellation of the active generation. The lane suppresses admission of its stale inputs and results once the interrupt is committed.
- A **successor generation** is a later generation created only after the prior generation settles. It receives later valid demand and cannot accept stale results from the prior generation.

For a coordination key, a drain lane MUST permit at most one active generation:

```text
idle
  -> active(g) on admitted demand
active(g)
  -> active(g) on compatible steer at a safe admission boundary
  -> active(g) with queued demand on later incompatible demand
  -> draining(g) on committed interrupt
  -> idle on terminal outcome or declared handoff with no promoted demand
draining(g)
  -> idle after cooperative cancellation settles and stale admission is suppressed
idle
  -> active(g + 1) when a queued demand is promoted or later valid demand is admitted
```

The lane MUST coalesce compatible demand, preserve queued order unless a declared policy safely reprioritizes it, and suppress stale admissions and results from a retired generation. It MUST create a successor generation for later valid demand rather than allowing a retired generation to resume implicitly.

Deferred admission waits, timer expiry, and queue promotion MUST be recorded and re-evaluated at declared safe admission boundaries under the admission coordination key. Each re-evaluation uses a fresh causally chained admission decision and revision without incrementing the pending attempt ordinal. Deferred queue count, bytes, re-evaluation count and rate, and elapsed wait are bounded as specified in Section 13.2. Generation fences apply to admission requests, candidate terminal Signals, results, and possible-effect observations. Timing facts are replayed from their committed records as specified in Section 13.7 and never resampled during reconstruction or recorded-edge re-drive.

### 11.5 Continuation

Continuation is distinct from an in-graph loop. An in-graph loop repeats nodes within one Run under graph-local bounds. Continuation either resumes the same Run across a session boundary without changing its attempt identity, or creates a causally linked successor Run as a new attempt, according to declared policy. A Run never spans execution attempts.

A continuation policy declares a done Signal, a maximum continuation count, and a durable stop rule. The runtime MUST commit a done Event before that signal can control restart-safe continuation. Durable stop and explicit resume are also committed Events with Log Records. A durable stop survives restart and prevents automatic continuation; only a committed explicit resume Event may clear it.

### 11.6 Replay

Replay has three distinct forms:

- **Reconstruction and projection** rebuild state, timelines, and views from Log Records. This is the minimum replay capability.
- **Recorded-edge re-drive** re-applies recorded decisions and observed outputs through deterministic graph transitions without redoing external effects.
- **Controlled re-execution** performs selected work again under explicit side-effect policy, authority, idempotency, and compensation rules.

These forms are not interchangeable. A projection is not controlled re-execution, and controlled re-execution requires stronger safety guarantees.

Reconstruction and recorded-edge re-drive reuse committed waits, deadlines, `notBefore` values, and jitter facts. They MUST NOT sample new timing values or repeat external effects. Controlled re-execution creates new execution and timing facts and remains subject to current authorization, effect safety, and reconciliation rules.

### 11.7 Child actors and delegated work

A child actor has an independent identity, declared assignment, authority boundary, lifecycle, and typed completion or result submission contract. The contract identifies the result contract, value or reference, completeness, assurance, evidence, and provenance. The parent MUST NOT infer completion only from incidental text or progress.

An optional fallback result policy MAY salvage a last valid partial result when the explicit result contract is absent or the actor terminates unexpectedly. The fallback MUST be declared, marked as degraded, and never masquerade as a typed completion. A parent consumes partial or degraded output only when its aggregate contract explicitly permits it.

Child authority follows attenuation rules:

- Structural omissions remove capabilities from the child surface entirely.
- Policy MAY further attenuate remaining authorization.
- Parent denies are inherited by children.
- Child allows are the intersection of parent allows and child grants.
- Delegation depth, active child count, and retry scope are bounded.

Cancellation is cooperative and MUST propagate according to the declared scope. A parent MAY retain valid partial results only when the aggregate contract allows them. Parking and revival are valid lifecycle operations for an idle actor. They are distinct from terminal stop and MUST preserve identity and authority semantics.

---

## 12. State, Memory, and Log

ABG distinguishes five related concepts:

```text
Context     : selected read view supplied to a node
Blackboard  : structured working memory for a coordination scope
State       : current runtime snapshot
Memory      : reusable knowledge and artifacts
Log         : immutable durable record of facts
```

### 12.1 State

State includes the active graph position, node and actor lifecycle, pending authority decisions, counters, open coordination scopes, and validated Blackboard values. It is runtime-owned.

### 12.2 Blackboard

The Blackboard stores only declared, validated values. Nodes request changes through Signals. After boundary parsing, shape validation, and applicable policy checks, the runtime admits a Blackboard-update Event with its Log Record before making the projection visible, or commits both atomically. Append failure means no admitted Event and no committed Blackboard update.

### 12.3 Memory

Memory supplies knowledge used to perform work. It can include user preferences, retrieved material, summaries, validated facts, prior decisions, and artifacts. Memory selection should be attributable when it materially affects a decision.

### 12.4 Log

The Event Log records immutable execution facts in durable envelopes and is their sole authoritative source. It provides the source for reconstruction, audit, and replay. A Timeline is a projection from the Event Log, not a replacement for it.

### 12.5 Principle

```text
State is reconstructable from the Event Log and declared deterministic rules.
Blackboard updates are runtime-applied and observable only after their Log Record append or atomic commit succeeds.
Memory is selectively supplied through Context.
The Event Log remains readable by humans and usable by machines.
```

---

## 13. Workflow-Node Fault Tolerance

### 13.1 Scope and authority

This section is the single authoritative specification for workflow-node fault tolerance. It governs Node-start admission, execution identity, settlement, failure facts, cancellation, timing, retry, recovery, resilience controls, effects, checkpoints, stale suppression, and fault replay. It applies to primitive Nodes, composites, actors managed by Nodes, and their declared child work. A graph declaration that conflicts with this section MUST fail closed.

Node terminal outcomes are exactly:

```text
succeeded | failed | cancelled
```

Admission results are not Node lifecycle states or Node terminal outcomes. This section does not change the Run terminal states defined in Section 11.2. All protected admission paths, including initial start, retry, readmission, fallback, restart, compensation, recovery, and reattachment, MUST use the same current-authority and approval rules. Recovery MUST NOT widen authority.

### 13.2 Node-start admission and execution identities

Before work starts, the runtime MUST perform a linearizable admission evaluation under the declared admission coordination key. Each completed evaluation has exactly one committed admission result:

```text
NodeStartAdmissionResult = admitted | deferred | denied | rejected
```

Every result is an Event with a Log Record. A committed `activationIdentity` binds the causal Event, transition or Edge, target Node, coordination generation, declared occurrence or item identity, and security scope. The runtime MUST enforce `|Invocations(activationIdentity)| <= 1`; duplicate delivery returns the existing invocation and cannot mint a new invocation or effect identity. `nodeInvocationId` identifies that requested use of a Node across all admission evaluations and execution retries. `admissionDecisionId` identifies one fresh, causally chained evaluation. `admissionRevision` is a monotonically increasing revision for the invocation and pending attempt ordinal until admission becomes final. `nodeExecutionId` identifies an execution created only by an admitted evaluation. `attemptOrdinal` identifies the execution attempt, beginning with the initial admitted attempt and increasing only when a retry creates a new execution. Ownership is separate versioned state, not part of execution identity.

For each evaluation, current authority, approval, deadline, wait, resource, breaker, bulkhead, and retry or readmission conditions MUST be evaluated under that key. A re-evaluation retains `nodeInvocationId`, uses a fresh causally chained `admissionDecisionId` and higher `admissionRevision`, and does not increment `attemptOrdinal`. An admission decision at an older revision is superseded and fenced only while no `Admitted` decision has committed for that pending attempt ordinal. A committed `Admitted` decision is final for `(nodeInvocationId, pendingAttemptOrdinal)` and MUST NOT be superseded. Later duplicate wakeups MUST return or reuse that committed decision, or record only an ignored duplicate observation; they MUST NOT create another admission-result Event. Post-admission revocation, cancellation, or supersession uses execution cancellation and fencing, never admission supersession.

`admitted` MUST atomically commit the admission Event, a unique `nodeExecutionId`, its `attemptOrdinal`, initial ownership epoch and owner, declared resource reservations, current authority-decision references, required one-use approval consumption, and any breaker permit or bulkhead active reservation, then make all of them visible together. The Event itself MUST contain the created execution identity and attempt ordinal. The same atomic operation MUST enforce:

```text
For every nodeInvocationId and pending attemptOrdinal,
|Executions(nodeInvocationId, attemptOrdinal)| <= 1.
```

Before approval, admission, or dispatch of effectful work, the runtime MUST durably register an immutable `effectIdentity` to its activation identity, authored effect slot or declared occurrence, operation, canonical validated-arguments digest, security scope, validation-schema identity and version, canonicalization identity and version, digest-algorithm identity and version, and operation-contract identity and version. The registration MUST retain the committed canonical argument bytes or a protected content-addressed reference to them. Effect identity is unique within that declared security and operation scope. Identity aliasing or operation, digest, descriptor, contract-version, or scope substitution MUST fail closed. Required one-use approval MUST bind and consume one use for the approved principal or actor, immutable effect registration when effectful, exact operation, exact canonical validated-arguments digest and descriptor versions, purpose, generation, attempt ordinal, expiry, and use count. Admission and dispatch MUST require exact registration, operation, digest, descriptor, contract-version, and scope equality. A consumed, expired, mismatched, superseded, or revoked approval cannot admit work. Current authority and approval are independent necessary admission checks; neither proves duplicate-effect safety.

When an admission touches multiple admission, authority, approval, breaker, bulkhead, ownership, or resource coordination keys, the runtime MUST use one composite coordination key or an atomic multi-key transaction with a declared deterministic global key order. If that atomic composition fails, all claims, permits, reservations, approval uses, ownership epochs, and admission facts MUST roll back or remain invisible. A half-open breaker permit and active bulkhead reservation commit with `admitted`; a bulkhead queue slot commits with `deferred`; each bounded permit, slot, and reservation releases atomically on cancellation, expiry, settlement, or transfer.

`deferred` creates no execution and carries a declared wait descriptor. `denied` is limited to policy, authorization, or explicit approval refusal and is never automatically retried. `rejected` is a non-policy inability to start and carries a FailureEnvelope. Missing requestable approval is `deferred`; explicit refusal is `denied`; malformed evidence is `rejected`. A committed deferred bulkhead queue slot MUST release or transfer atomically when its decision resolves to `admitted`, `denied`, `rejected`, cancellation, expiry, or transfer. Deferred queues MUST declare and enforce bounds on item count, bytes, re-evaluation count and rate, and elapsed wait. Exceeding a bound MUST produce a declared rejection or escalation, never an unbounded wait.

No non-admitted result creates a Node execution, reserves execution resources, exposes `starting`, or fabricates a terminal Node outcome. Retry retains `nodeInvocationId`, creates a new `nodeExecutionId`, and increments `attemptOrdinal`; it never reopens a prior settlement.

### 13.3 Committed settlement and outcome separation

Outcome selection is distinct from settlement. `SelectOutcome` MUST serialize eligible terminal Signal candidates, applicable cancellation fences, and deadline-expiry facts under one durable execution outcome-selection operation. The earliest committed eligible fact selects one immutable outcome: `succeeded`, `failed`, or `cancelled`. A terminal Signal is only a candidate until accepted by this operation. Later duplicate or conflicting candidates, fences, and expiry facts are stale for outcome selection and MAY only drive draining or reconciliation.

Subject to the conditional liveness condition below, every started execution MUST have exactly one committed settlement Event for its selected outcome. Settlement occurs only after required draining, child settlement, ownership accounting, and effect accounting complete. An outcome-selection fact is not itself a terminal settlement or a fourth Node state.

At-most-one settlement is an unconditional safety property:

```text
For every nodeExecutionId x, |SettlementLog(x)| <= 1.
```

Eventual settlement is a conditional liveness property. It requires continued runtime operation, Event Log availability, a committed outcome-selection fact, and completion of required draining, ownership transfer, or bounded orphaning. The runtime MUST NOT claim that a started execution is settled merely because it emitted a Signal, timed out locally, selected an outcome, or was observed by a projection.

Settlement, reservation release, and any ownership or reservation transfer MUST commit atomically and become visible together. If that atomic operation fails, the runtime MUST expose no terminal state, activate no downstream Node, release no reservation, and retain no projection that implies a completed settlement. A crash after settlement but before release or transfer is therefore not a valid state. The runtime MUST route the append failure through the declared fault path when doing so is possible.

`DispatchAuthorized` and `DispatchStarted` are durable effect-claim transitions serialized with the effect claim, applicable cancellation fence, `DeadlineExpired`, outcome selection, authority revision, approval use, and ownership transfer under the required composite or atomic multi-key operation. If cancellation or a non-succeeded outcome wins before `DispatchAuthorized`, dispatch is prohibited. If `DispatchAuthorized` wins first, later cancellation or transfer MUST treat the effect as in flight or possibly applied and retain or set `effectOutcome = unknown` until observation or reconciliation resolves it. `DispatchStarted` records the authorized physical-send attempt; it does not promise that a sink performed an effect exactly once.

A parent MUST NOT settle while it owns unsettled children unless their ownership has been durably transferred under a declared contract. Before a parent can settle through cancellation, each owned child MUST have its own committed cancellation settlement, not merely a cancellation request or fence. A transfer identifies the new recovery owner, ownership epoch, children, reservations, effect obligations, and responsibility for later settlement. A parent cannot use a child Signal, timeout, cancellation request, or local observation as a substitute for this rule.

### 13.4 Failure taxonomy and FailureEnvelope

A **fault** is a condition that can prevent or invalidate intended work. An **error** is an observation, such as a raw exception, message, status, or malformed response. A **failure** is an authoritative, typed operational fact represented by a FailureEnvelope. Raw exceptions and strings are not authoritative failure facts.

FailureEnvelope categories are closed:

```text
input | precondition | dependency | resource | deadline | conflict | protocol |
quality | execution | effect | checkpoint | poison | internal
```

A FailureEnvelope MUST conceptually include `schemaVersion`, `failureId`, Run identity, Effective Graph identity, Node identity, `nodeInvocationId`, optional `nodeExecutionId` and `attemptOrdinal`, `phase`, `category`, stable `code`, safe summary, `retryDisposition`, `effectOutcome`, `compensationStatus`, causal Event IDs, and optional `retryAfter` or details reference. A safe summary MUST have a declared bounded length, be redacted for secrets and sensitive data, be control-character safe, be non-recursive, and be safe for human display. Raw errors and exceptions MAY appear only through bounded, redacted, access-controlled evidence references with a declared retention policy; they MUST NOT be inlined as authority or treated as a substitute for a FailureEnvelope. Its closed supporting values are:

```text
phase = admission | execution | settlement | cancellation | compensation | recovery
retryDisposition = never | after_delay | after_change | after_reconcile
effectOutcome = not_applicable | not_started | confirmed_not_applied |
                confirmed_applied | unknown
compensationStatus = not_required | not_started | pending | succeeded | failed | unknown
```

Cancellation and valid denial are not FailureEnvelope categories and MUST NOT be recorded as failures merely to force a failure path. A timeout that causes failed settlement uses category `deadline`.

### 13.5 Cancellation, timeout, and deadline

Cancellation is ordinary control flow. Local, ancestor, user, policy, and supersession cancellation requests MAY create an applicable cancellation fence. Cancellation requests, fences, draining facts, and completed cancellation settlements MUST be recorded. Cancellation does not by itself create a FailureEnvelope.

A deadline is absolute and inherited. A child deadline MUST NOT extend its parent deadline. A timeout is relative and MUST resolve to an absolute deadline that does not extend the inherited deadline. Pre-start expiry MUST produce `rejected` with a `deadline` FailureEnvelope.

For a started execution, cancellation and deadline arbitration is total under the execution coordination key and uses `SelectOutcome` from Section 13.3. The earliest committed applicable cancellation fence and `DeadlineExpired` Event controls candidate eligibility. If the cancellation fence is first, `cancelled` is the only eligible settlement outcome; if `DeadlineExpired` is first, `failed` with a `deadline` FailureEnvelope is the only eligible settlement outcome. Dispatch authorization participates in the same serialized arbitration. Settlement still waits for the ownership and draining conditions of Section 13.3 and this section. Later cancellation or deadline facts MUST only drive draining, reconciliation, or observability and MUST NOT change the selected outcome.

Draining MUST have a declared bound. Cancellation settlement waits for the executor and owned children to terminate, or for explicit bounded orphaning. Orphaning is a durable ownership transfer to a declared recovery owner, never abandonment; it transfers effect, reservation, and eventual-settlement duties, fences the former owner, records `effectOutcome = unknown` when an effect may have occurred, and routes reconciliation. If cooperative stop does not complete within the bound, the runtime MUST fence, transfer, and account for the work before parent settlement or reservation release.

### 13.6 Retry eligibility and budgets

`RetryEligible` applies only to a settled failed execution. It authorizes only proposing pending attempt ordinal `k + 1`; it does not acquire breaker permits, bulkhead capacity, authority, approval, ownership, reservations, or an execution. Automatic retry is permitted only when `RetryEligible` is true. The predicate MUST require all of the following: declared policy allows the FailureEnvelope category, code, phase, and retry disposition; `maxAttempts`, including the initial attempt, is not exhausted; time and cost budgets remain; no cancellation, denial, or retired generation applies; the inherited deadline remains valid; every required condition change has occurred; effect outcome is mechanically repetition-safe; and the poison threshold has not been crossed. The subsequent atomic Admission re-evaluates and acquires current breaker, bulkhead, authority, approval, ownership, and reservation facts. An open breaker MAY defer the proposed retry through admission when its declared wait is retained.

`maxAttempts = 1` permits no execution retry. Waiting consumes elapsed time and may consume declared deadline or cost budget, but it MUST NOT consume an attempt ordinal. Retry eligibility, budget consumption, and retry scheduling MUST be durable facts before a retry becomes visible.

A durable `recoveryLineageId` and bounded shared recovery-lineage budget MUST cover retry-equivalent retry, readmission, fallback, restart, defer cycling, compensation retry, and graph recovery cycles. Each such route MUST durably consume or verify remaining lineage budget before proceeding. A new invocation within the same recovery lineage MUST NOT reset this budget. Local `maxAttempts` remains distinct. On lineage-budget exhaustion, the graph MUST route to a declared rejection, cancellation, human escalation, or terminal failure.

`ReadmissionEligible(invocation, rejectedDecision, currentFacts)` governs a rejected admission that created no execution. It is only a predicate over declared policy that allows the FailureEnvelope category, code, phase, and non-`never` retry disposition; every required condition change; a committed `notBefore` when delayed; declared count, rate, elapsed-time, and cost bounds; and absence of cancellation, denial, or retired generation. It MUST NOT re-evaluate authority, deadline, wait, resources, permits, or reservations; create a decision revision; invoke `RetryEligible`; or consume an execution attempt ordinal. When true, it permits a subsequent fresh `Admission` evaluation that retains the invocation and pending attempt ordinal, creates the new decision and revision, and atomically rechecks current authority, deadline, wait, resources, and permits.

An `unknown` or `confirmed_applied` effect outcome prohibits automatic and controlled repetition. Repetition is safe only with stable idempotency, reconciliation that establishes a repetition-safe state, a verified no-op, or completed compensation whose verified postcondition proves repetition safe. Current authority, approval, risk acceptance, or accepted, pending, or unknown compensation is never proof of mechanical effect safety. Risk acceptance MAY authorize reconciliation, compensation that explicitly handles uncertainty, or abandonment, but MUST NOT authorize repetition before mechanical safety is established. An unchanged unsafe action is never made safe by repetition.

### 13.7 Backoff and jitter

Backoff MUST be bounded by declared delay and deadline limits. A valid default is capped exponential backoff followed by declared jitter, for example:

```text
baseDelay(attemptOrdinal) = min(cap, initialDelay * 2^(attemptOrdinal - 1))
finalDelay = declaredJitter(baseDelay, declaredSeed or committedJitterResult)
```

This is a valid default, not a mandatory algorithm. Before a retry or readmission schedule becomes visible, the runtime MUST commit the base delay, jitter result or seed, final delay, `notBefore`, inherited deadline, and causal decision. Reconstruction and recorded-edge re-drive MUST reuse those facts and MUST NOT resample jitter. Controlled re-execution creates new timing facts under its new execution identity.

Historical reconstruction and recorded-edge re-drive consume only committed timer facts. `TimerDue(notBefore)` and `DeadlineExpired(deadline)` are distinct facts. During active recovery, before `notBefore` the runtime MUST re-arm the recorded timer without routing; at or after `notBefore` it MUST commit an idempotent causally linked `TimerDue` Event before routing. A deadline expiry MUST commit a distinct `DeadlineExpired` Event before outcome selection. A crash before `notBefore` does not permit an unrecorded wake or a newly sampled delay.

### 13.8 Failure isolation and composite propagation

Failure is an observation to a parent, not automatic Run failure. Sequence, Parallel and fan-out, Race, Join, and Statechart Nodes MUST each declare handling for every child admission result, terminal outcome, missing input, partial or degraded result, sibling cancellation or draining, and deterministic aggregate. Unsupported composite behavior MUST fail closed.

Fail-fast aggregation selects its triggering outcome by serialized Event admission under the declared coordination key, then applies the declared sibling cancellation or draining rule. Fail-slow aggregation retains all declared causes. Aggregation MUST use declared child identity and order, never nondeterministic arrival order. A Race selects the earliest valid committed success, not the first terminal result. Parent settlement and child ownership follow Section 13.3 and Section 13.5.

### 13.9 Supervision and restart

A supervisor MUST declare its observed scope, response for each observed admission result and terminal outcome, affected children, restart order, intensity, attempt and time budgets, escalation route, partial-result retention, draining behavior, ownership handling, and authority re-evaluation rule. A response MAY retry, restart, route to fallback, request a human decision, reconcile an effect, compensate, retain a declared result, or escalate.

Restart creates a new Node execution. Restarting an actor after its terminal outcome creates a new actor identity causally linked to the prior actor. Revival applies only to a parked nonterminal actor. Every protected restart, fallback, compensation, recovery, and reattachment admission MUST obtain and atomically bind fresh current authority and approval under Section 13.2. Supervision, restart, fallback, and compensation MUST NOT widen authority or bypass a denial.

### 13.10 Circuit breakers and bulkheads

A circuit breaker MUST be keyed by declared dependency or resource and an ownership or isolation scope that includes the applicable principal, tenant, or declared security domain. It has exactly the states `closed`, `open`, and `half_open` and MUST declare eligible FailureEnvelope categories and codes, threshold, observation window, open duration, probe policy, reset rule, success and failure transitions, and transition records. Every transition MUST be committed under the breaker coordination key. Only unique committed eligible failed settlements count. Breaker-generated admission rejection, cancellation, denial, duplicate reports, and stale reports MUST NOT count. Half-open probe permits MUST be bounded, allocated atomically, and committed with an `Admitted` Event when used for execution. An open breaker produces `deferred` when the declared wait is retained; otherwise it produces `rejected` with a `dependency` or `resource` FailureEnvelope.

A bulkhead MUST declare a partition and isolation scope including the applicable principal, tenant, or declared security domain; active capacity; queue capacity; fairness; deadline treatment; and overflow rule. Resource reservation and queue-slot allocation, cancellation, expiry, promotion, and release MUST be atomic under the partition key. Its resource reservation MUST commit atomically with `admitted`. Queue admission produces `deferred`; saturation without a queue produces `rejected` with a `resource` FailureEnvelope. Promotion MUST re-evaluate current deadline and authority. A reservation releases only after committed settlement or a declared atomic transfer. Unsupported advanced breaker or bulkhead declarations MUST fail closed.

### 13.11 Fallback, degraded success, and partial results

Fallback is routing, not retry. It MAY start declared alternative work only after the applicable routing rule, and it MUST NOT bypass denial or widen authority.

Every result contract MUST identify its contract identity and version, value or reference, completeness, assurance, evidence, and provenance:

```text
completeness = full | partial
assurance = normal | degraded
```

Partial and degraded are result qualities, not terminal states. An execution settles `succeeded` only when its declared contract accepts the produced completeness and assurance. Otherwise a salvage result MAY accompany `failed` or `cancelled`, and a parent MAY consume it only through an explicit result contract.

### 13.12 Side-effect safety, reconciliation, and compensation

Every external effect MUST have a stable immutable registration, stable `effectIdentity`, `effectOutcome`, and at most one orchestrator dispatch claim keyed by `effectIdentity`. Registration and claim transitions are durable and ownership transfer preserves the claim. Before dispatch, the runtime MUST atomically commit `DispatchAuthorized` and its claim containing the immutable registration, operation, canonical validated-arguments digest, validation-schema, canonicalization, digest-algorithm, and operation-contract identities and versions, execution, attempt, generation, ownership epoch, Context and input fence, authority revision, approval-use reference when present, dispatch ordinal, and dispatch state. It MUST recheck those fences and the exact registration, operation, digest, descriptor versions, contract version, and scope immediately before `DispatchStarted`. Replay and recovery MUST reuse the committed canonical bytes or their protected content-addressed reference and MUST NOT recanonicalize under a newer descriptor or contract. Duplicate initial delivery or same-execution redelivery MUST NOT dispatch again unless sink-enforced idempotency or another already-declared mechanical repetition-safety proof applies. Where available, the runtime MUST supply a sink-enforced ownership fencing token. Without such a token, the runtime MUST NOT claim that a stale owner was physically prevented after authorization; it must treat the effect as in flight or possibly applied. After a crash or ownership ambiguity, the effect outcome MUST become `unknown` and redispatch is prohibited pending mechanical proof. This at-most-one orchestrator claim does not promise exactly-once external effects or atomic rollback.

A retry, fallback, restart, or controlled re-execution of possible effectful work MUST use stable idempotency, reconciliation, verified no-op, completed compensation with a verified repetition-safe postcondition, or an explicit prohibition on repetition. Current authority, approval, and risk acceptance are necessary for protected admission but do not establish duplicate-effect safety.

Compensation is separately admitted, bounded execution with its own invocation, admission, execution, and attempt identities; settlement; FailureEnvelope; idempotency; retry; timeout; cancellation; and fresh authority rules. Before compensation starts, its causal effect-dependency graph MUST be acyclic; a cycle MUST fail closed. Compensation MUST run in reverse topological order over declared causal effect dependencies. It MUST use a declared deterministic tie-break for incomparable effects or explicitly declared parallel antichains with conflict rules. Unknown effects MUST be reconciled before compensation unless the compensation contract explicitly handles uncertainty. Compensation never erases original effect, failure, or settlement facts. Residual effects and failed, pending, or unknown compensation remain visible.

### 13.13 Checkpoints and restart recovery

A checkpoint is a boundary-durable Event over a committed Event Log prefix, never another authority. It MUST reference a content-addressed Effective Graph identity, Event Log prefix identity and digest, anti-rollback monotonic anchor, generations, active identities, committed State and Blackboard values, budgets, timers, waits, outcome-selection facts, effect-dispatch claims, effect ledger, and stream cursors. The monotonic anchor MUST be compared with an independently retained authoritative high-water mark or equivalent non-rollbackable fact; a checkpoint below that mark MUST be rejected. Its projection MUST equal the deterministic projection of the referenced prefix or be discarded as a cache. Shared breaker and bulkhead state MUST be referenced by authoritative scope and version, never restored from a stale Run-local copy.

Restore MUST verify the checkpoint, anti-rollback anchor, and referenced Log prefix, then replay the suffix. Bounded recovery MUST place every recovered started execution in exactly one durable state regardless of retry intent: reattached under an exclusive committed ownership epoch or lease transfer; atomically retired, fenced, settled, and released; or explicitly transferred with all ownership, reservation, effect, dispatch, and eventual-settlement obligations. Initial ownership creation and every later transfer are committed authority facts. Reattachment requires fencing the old owner, proving execution identity, preserving any prior outcome-selection fact and effect-dispatch claim, and obtaining fresh authority. If an outcome was already selected, recovery MUST honor it; if none was selected, recovery MAY select a recovery failure only through `SelectOutcome`. Unknown possible effects remain blocked pending reconciliation. A later retry is permitted only when Section 13.6 establishes safety.

### 13.14 Poison messages and repeated-failure detection

A poison fingerprint MUST declare canonicalization or normalization identity and version, graph identity, Node identity, canonicalized selected input values or an unambiguous digest of those values, stable failure code, condition identity and version, effect outcome, authority or security scope, and counting scope. The committed record MUST include the fingerprint components and resulting fingerprint; replay MUST reuse them rather than recanonicalizing historical input. Its threshold and window MUST be committed. Crossing the threshold disables unchanged automatic retry and routes through an explicit declared path such as repair, changed input, reconciliation, fallback, or human decision. Cancellation, denial, duplicate reports, and stale reports are excluded from poison detection.

### 13.15 Concurrent arbitration and stale-result suppression

The runtime MUST fence admission requests, terminal Signal candidates, results, effect registrations, effect proposals, effect-dispatch commands, and effect observations by activation identity, input identity or digest, Context epoch, authority-decision revision, result-contract identity and version, immutable effect registration and effect identity, admission-decision revision, generation, invocation, execution, actor, attempt, ownership epoch, dispatch state, and parent settlement where applicable. A candidate or dispatch command failing any applicable fence is stale and MUST NOT settle work, activate a downstream Node, register or dispatch an effect, or revise committed state. Results observed before a steer, revocation, Context change, or result-contract change MUST NOT commit unless the declared compatibility rule explicitly accepts their captured fence values.

Concurrent arbitration uses serialized durable order for a declared coordination key. Stale observations that could indicate an external effect remain relevant to reconciliation and MUST be routed to it without reopening settlement or reviving a retired generation.

### 13.16 Fault observability and deterministic replay

Fault-related activation identities, admission decisions, revisions, final admission reuse, waits, reservations, approval bindings and consumption, recovery-lineage budgets, outcome selection, candidate acceptance or suppression, settlements, child ownership, orphaning, FailureEnvelopes, retry and readmission eligibility, budget use, `TimerDue` and `DeadlineExpired` facts, breaker and bulkhead transitions, result quality, immutable effect registrations, dispatch authorization and started states, effect-dispatch claims, effect ledger changes, compensation, checkpoints, ownership epochs, poison fingerprints, and stale fences MUST be inspectable through Event Log-derived projections.

Reconstruction replays committed facts. Recorded-edge re-drive preserves recorded outcome selection, settlement, timing, fence, authority revision, approval, ownership, effect-dispatch claim, and effect facts without repeating external effects. Controlled re-execution uses new identities and newly committed admission, timing, authorization, and mechanical effect-safety facts. No projection, checkpoint, or transient Signal is an independent fault authority.

---

## 14. Backpressure and Resource Management

### 14.1 Stream durability classes

ABG recognizes three stream durability classes. A durability class never changes a Signal into an Event or an Event into a Signal. Nodes emit Signals; runtime interpretation admits selected Signals or observations as Events with Log Records.

- **Ephemeral** streams exist for immediate coordination or display. Their Signals remain transient unless a separate audit-critical rule admits one as an Event; once admitted, it MUST receive a Log Record.
- **Boundary-durable** streams MUST admit declared boundary Signals, such as milestones, summaries, checkpoints, and terminal facts, as Events with Log Records.
- **Fully durable** streams MUST admit every declared Signal item as an Event and unconditionally append a Log Record for each one.

The declared class determines what a replay can prove. A boundary-durable stream cannot support a claim that every transient Signal is recoverable. Every Event has a Log Record by definition.

### 14.2 Backpressure strategies

Streams can outpace consumers. A graph or runtime SHOULD declare appropriate strategies:

```text
buffer
sample
throttle
debounce
summarize
drop low-priority ephemeral items
pause producer
cancel producer
```

Audit-critical Events MUST NOT be discarded merely to relieve pressure. They require a durable path or a declared fail-safe response.

### 14.3 Priority and fairness

Policy violations, cancellations, authority decisions, and failures usually take precedence over verbose progress. Priority MUST NOT starve valid work indefinitely. Bounded concurrency and fair scheduling rules make resource use explainable. Bulkhead partitioning, queue capacity, reservation, overflow, and fairness semantics are defined in Section 13.10.

---

## 15. Policy and Safety

### 15.1 Resource authorization

Actors and Actions MUST use only operations permitted by the Effective Graph's authorization constraint. That constraint covers capability, resource, scope, time, purpose, and approval requirements.

### 15.2 Parent-to-child attenuation

Delegation MUST NOT widen authority. Parent and baseline denies are deny-preserving. Child authorization is the meet of parent and child constraints across capability, resource, scope, time, purpose, and approval requirements. A child can preserve or strengthen an approval requirement but MUST NOT relax one. Structural removal is stronger than a rule because the omitted capability is absent from the child surface.

### 15.3 Protected-effect gate

Potentially harmful, irreversible, or externally visible effects MUST pass through a Policy Gate:

```text
effect proposed
  -> identify resource and risk
  -> evaluate authorization and behavioral policy
  -> allow, deny, or request-human-decision
  -> submit the protected invocation for node-start admission
```

A separately declared safer alternative is a routed invocation with its own Policy Gate and Node-start admission; it is not a Policy Gate decision value. A valid denial is a pre-start admission result, not a failure or terminal Node outcome. Fallback, retry, restart, delegation, and compensation MUST NOT bypass denial or widen authority.

### 15.4 Confidence and evidence

Low confidence SHOULD NOT silently become high-impact action. A graph MAY gather more evidence, run validation, disclose uncertainty, request human input, or stop. Confidence SHOULD consider evidence quality, conflicts, validation results, risk, and task criticality, not only model self-assessment.

### 15.5 Budget and quality policy

Cost, time, resource use, and acceptance criteria are policy concerns. They SHOULD be represented as observable facts and evaluated before limits are exceeded where possible.

---

## 16. Observability

### 16.1 Required observability

An ABG control plane MUST make the following inspectable:

```text
Authored Graph and Effective Graph identity
Mission and Run lifecycle
Node and actor lifecycle
Event Timeline and causal chains
policy and authority decisions
Blackboard updates and their bindings
memory provenance when decision-relevant
artifacts, costs, latency, errors, and human intervention
admission decisions, waits, executions, settlements, retries, and stale suppression
FailureEnvelopes, effect outcomes, compensation, checkpoints, poison fingerprints, and resilience state
admission revisions and supersession, approval use, ownership epochs, drain or orphan state, and readmission decisions
outcome selections, TimerDue and DeadlineExpired facts, effect-dispatch claims and states, and atomic transfer or release facts
```

### 16.2 Explainable execution

An audit-relevant decision SHOULD record the chosen path, its reason, considered alternatives when available, policy outcome, and causal predecessor. Explanation MUST be rooted in facts and declared rules, not reconstructed solely from a later narrative.

### 16.3 Timeline and projections

The Timeline is usually the primary operational view because it answers what happened, when, and why. Graph views, actor views, policy views, summaries, and Timelines are projections derived from the authoritative Event Log and its committed state.

### 16.4 Fault observability

Fault observability MUST distinguish an admission decision and revision, final admission reuse, a terminal Signal candidate, outcome selection, a committed settlement, a FailureEnvelope, a cancellation, a valid denial, a readmission decision, and a recovery authorization. It MUST expose the identities, causal records, approval binding and consumption, ownership epoch, dispatch claim, declared retry or recovery decision, timing facts, effect outcome, and stale fence that explain a fault decision. Section 13.16 defines the deterministic replay obligations for these records.

---

## 17. ABG vs Ordinary DAG

A directed acyclic graph is useful for static dependency execution:

```text
A and B -> C -> D
```

ABG additionally represents dynamic selection, Event reaction, intervention, loops, cancellation, and recovery.

| Dimension | DAG | Async Behavior Graph |
|---|---|---|
| Structure | Mostly static | Dynamic routing within declared semantics |
| Execution | Dependency completion | Event reaction and coordination |
| Mid-run intervention | Often external | First-class Event input |
| Streaming | Often result-oriented | Signal and Event stream-oriented |
| Decision making | Limited | Central |
| Recovery | Often external | Graph-visible |

---

## 18. ABG vs Behavior Tree

| Dimension | Behavior Tree | Async Behavior Graph |
|---|---|---|
| Basic shape | Tree | Graph |
| Execution style | Often tick-based | Primarily Event-driven |
| Node result | Success, failure, running | Signal stream and terminal outcome |
| Partial result | Limited | First-class |
| Long procedure | Often awkward | Statechart or composite workflow |
| Parallelism | Varies by implementation | Explicit Parallel, Race, and Join semantics |
| Observability | Added separately | Event and record model is central |

A Behavior Tree can serve as an ABG decision language:

```text
Behavior Tree subset of Async Behavior Graph
```

---

## 19. Formal Model

Let an Authored Graph be:

```text
A = (N, E, B, P, H, D)
```

Where:

```text
N: declared Nodes
E: declared Edges
B: declared Blackboard bindings and shapes
P: baseline behavioral policy and resource authorization constraint A0
H: declared fault, recovery, resilience, and result-contract rules
D: graph metadata and declared defaults
```

Let ordered overlays be `O = [o1, o2, ... on]`. Materialization produces the Effective Graph:

```text
G = M(A, O)
```

`M` is pure and deterministic. It leaves `A` unchanged and applies overlays in their declared order. Guidance and behavioral policy composition use declared precedence. An unresolved behavioral conflict MUST make `M` fail closed. If `Ai` is the authorization restriction imposed by overlay `oi`, covering capability, resource, scope, time, purpose, and approval requirements, then:

```text
Authorization(G) = A0 meet A1 meet ... meet An
```

The meet is deny-preserving: a baseline or parent denial remains denied, and approval requirements MUST be preserved or strengthened. An ambiguous authorization restriction MUST make `M` fail closed. No overlay can widen authority. A wider authorization MUST require a revised Authored Graph with changed baseline authorization.

Let the runtime vocabulary be:

```text
Sigma: Signals emitted by Nodes
V: admitted immutable Events, each represented by a Log Record
T: Streams of Signals or Events
L: Event Log, the durable sequence of Log Records
Q: runtime State, including validated Blackboard values; activation and invocation indexes; admission evaluations, revisions, finality, and bounded deferred queues; active, retired, and versioned ownership records; approval bindings and consumption; outcome-selection and settlement indexes; retry, readmission, continuation, and recovery-lineage budgets; deadlines, timers, and waits; breaker and bulkhead state; checkpoint reference; immutable effect registrations, effect-dispatch claims and states, and effect ledger; poison fingerprints; and stale fences
I: an input item, either a Node Signal or an admitted Event already represented in L
```

Each Node is modeled as:

```text
ni: (Context(Q, Memory), T_in, Policy(G)) -> T_out(Sigma)
```

For a requested Node use, let the invocation, admission, execution, and terminal outcome be:

```text
z = (causalEventOrTransitionOrEdge, targetNodeId, generation,
     occurrenceOrItemId, securityScope)
u = (runId, effectiveGraphId, nodeId, activationIdentity, nodeInvocationId)
x = (u, nodeExecutionId, attemptOrdinal, generationId)
w = (nodeExecutionId, ownershipEpoch, ownerRef, reservationRefs,
     effectAndSettlementObligations)
r = (effectIdentity, activationIdentity, authoredEffectSlotOrOccurrence,
     operation, canonicalValidatedArgumentsDigest, securityScope,
     validationSchemaIdAndVersion, canonicalizationIdAndVersion,
     digestAlgorithmIdAndVersion, operationContractIdAndVersion,
     canonicalArgumentsOrProtectedContentAddress)
h = (recoveryLineageId, sharedBudget, consumedBudget)
o in {succeeded, failed, cancelled}
```

`activationIdentity` is the committed identity `z`; it is the unique causal input to `u`.

An admission result is a tagged union, where `revision` is monotonic for `(u, pendingAttemptOrdinal)`:

```text
a ::= Admitted(admissionDecisionId, u, x, initialOwnershipRef,
               reservationRefs, authorityDecisionRefs, approvalUseRef?, revision)
   | Deferred(admissionDecisionId, u, pendingAttemptOrdinal,
              waitDescriptor, revision)
   | Denied(admissionDecisionId, u, pendingAttemptOrdinal, denialRef, revision)
   | Rejected(admissionDecisionId, u, pendingAttemptOrdinal,
              FailureEnvelope, revision)
denialRef ::= BehavioralPolicyDenial(ref) | AuthorizationDenial(ref) |
              ExplicitApprovalRefusal(ref)
```

Only `Admitted` creates `x` and its initial `w`. `approvalUseRef?` is present exactly when that admission consumed approval. `Deferred`, `Denied`, and `Rejected` remain admission facts rather than lifecycle states. Every completed admission evaluation before final admission yields exactly one such committed result. Later revisions supersede earlier revisions only before `Admitted`; after `Admitted`, duplicate wakeups reuse the final decision or record an ignored duplicate observation and yield no new admission-result Event.

The fault-tolerance functions and predicates are:

```text
Admission(G, Q, L, u, pendingAttemptOrdinal) -> a
ReadmissionEligible(G, Q, L, u, rejectedDecision) -> true | false
AcceptCandidate(G, Q, L, x, candidate) -> accepted | stale
SelectOutcome(G, Q, L, x, acceptedCandidateOrFenceOrDeadline) -> o
RetryEligible(G, Q, L, x, FailureEnvelope) -> true | false
ResolveComposite(G, Q, L, composite, childFacts) -> aggregate or routing decision
Settle(G, Q, L, x, selectedOutcome) -> (Q', L', o)
RegisterEffect(G, Q, L, r) -> registered | rejected
DispatchAuthorized(G, Q, L, r) -> dispatchClaim | prohibited
DispatchStarted(G, Q, L, dispatchClaim) -> started | suppressed
```

`z` is committed before activation, and duplicate delivery of `z` reuses one `u`. `Admission` linearizes by a composite key or atomic multi-key transaction and atomically creates the Event, execution, initial ownership, reservation, current authority references, required approval consumption, and applicable permit for `Admitted`. `ReadmissionEligible` applies only to a rejected admission with no execution and is only a bounded policy, condition-change, timing, and fence predicate; a later `Admission` rechecks all current resources and authority. `AcceptCandidate` applies activation, input, Context, authority, result-contract, effect-registration, admission-revision, identity, generation, cancellation, actor, attempt, ownership epoch, and parent-settlement fences. `SelectOutcome` serializes accepted candidates, cancellation fences, and `DeadlineExpired` facts, then commits the earliest eligible immutable outcome. `Settle` may append one settlement only for that selected outcome and atomically releases or transfers reservations after owned children have their actual settlements or are durably transferred. `RetryEligible` applies only to a settled failed execution and proposes only its next pending ordinal; it does not acquire admission resources. `RegisterEffect` immutably binds `r` before approval or admission. `DispatchAuthorized` serializes the claim with outcome, cancellation, deadline, authority, approval, and ownership facts; `DispatchStarted` records the physical-send attempt after immediate fence validation. `ResolveComposite` uses declared child identity and order.

The settlement invariant and conditional liveness property are:

```text
For every execution x, |Settlement_L(x)| <= 1.
For every activation z, |Invocations_L(z)| <= 1.
For every u and pending attemptOrdinal k, |Executions_L(u, k)| <= 1.
For every completed pre-final admission evaluation e, |AdmissionResults_L(e)| = 1.
If Admitted(u, k) is committed, no later admission-result Event exists for (u, k).
For every execution x, |OutcomeSelections_L(x)| <= 1.
Every Settlement_L(x) references OutcomeSelection_L(x) and atomically releases or transfers x's reservations.
Every ownership epoch w has one committed owner; a later w fences its predecessor.
For every effectIdentity r, |Registrations_L(r)| = 1 and |DispatchClaims_L(r)| <= 1.
ContinuedRuntime(x) and LogAvailable and OutcomeSelected(x)
  and SettlementReady(x)
  imply eventually AtomicSettlementAndReleaseOrTransfer(x).
```

`SettlementReady(x)` means required draining, owned-child settlement or durable ownership transfer, ownership accounting, and effect accounting have completed. `AtomicSettlementAndReleaseOrTransfer(x)` commits the settlement and reservation release or transfer together; release or transfer is a consequence, not a precondition.

Runtime interpretation is modeled as:

```text
R: (G, Q, L, i in I) -> (Q', L', effects, stream routing)
```

`L'` extends `L`; it never revises committed records. When `i` is a Signal, runtime interpretation MAY admit an Event only by appending its Log Record to form `L'`. When `i` is an admitted Event, its Log Record is already in `L`. When `Q'` contains an audit-critical Blackboard update, transition, authority decision, admission result, settlement, retry, result, or other execution fact, its Log Record MUST be present in `L'` before `Q'` becomes visible, or both changes MUST commit atomically. The runtime does not overload Signals as Events or use a Stream as proof of durability. All decisions become visible only after their required Log Records commit.

Execution proceeds as a loop:

```text
1. Receive a Node Signal, an admitted Event, or valid later demand.
2. Interpret the input against the Effective Graph and Policy.
3. Linearize required immutable Events, including atomic admission, reservation, authority, and approval facts.
4. Apply only the projections and state transitions whose required append succeeded.
5. Derive applicable Context, evaluate Node-start admission, and activate only admitted Nodes.
6. Receive their Signal streams, accept eligible candidates, select outcomes, dispatch effects only through claims, and continue coordination.
7. Continue until a terminal Run outcome or declared wait occurs.
```

---

## 20. Minimal Runtime Semantics

An ABG runtime MUST provide the following semantics.

### 20.1 Node lifecycle

```text
admitted (outside lifecycle) -> creates execution in starting
starting -> running -> succeeded | failed | cancelled
```

Admission is outside this lifecycle. Only an atomically committed final `admitted` result, execution identity, initial ownership epoch, resource reservation, current authority references, and required approval consumption create `starting`; `deferred`, `denied`, and `rejected` create no Node lifecycle instance. Every started Node MUST use the outcome-selection and exactly-one committed settlement semantics in Section 13.3. Eventual settlement requires continued runtime operation, Event Log availability, committed outcome selection, completion of required draining, ownership transfer or orphan accounting, and effect accounting, plus readiness for reservation release or transfer to commit atomically with settlement. Retry creates a new execution and MUST NOT reopen a settled lifecycle. Readmission creates no execution until a later admission succeeds. An actor managed by a Node MAY separately enter its declared parked lifecycle.

### 20.2 Actor lifecycle

```text
created -> starting -> running -> parked -> revived -> running
created | starting | running | parked | revived -> stopping -> stopped | failed | cancelled
created | starting | running | parked | revived -> failed | cancelled
```

`parked` and `revived` are nonterminal lifecycle states. Every nonterminal Actor state has a valid failure, cancellation, and stop exit as shown above. `stopped`, `failed`, and `cancelled` are terminal for that actor instance. Restart after any terminal outcome creates a new, causally linked actor instance. Revival applies only to the same parked nonterminal instance; it is not a restart.

### 20.3 Workflow lifecycle

```text
created -> active -> blocked -> active
active -> completed | failed | cancelled
```

A blocked workflow retains its identity and declared wait condition. It MUST NOT accept stale inputs after an interrupt or superseding transition.

### 20.4 Mission and Run lifecycle

Mission catalog state and Run execution state are separate as defined in Section 11. A terminal Node or workflow Signal is a candidate and contributes to a committed Run terminal Event and Log Record only through runtime interpretation and declared aggregation rules. A settled selected `succeeded` outcome can contribute to `completed` only when the enclosing completion rule passes. A settled selected `failed` outcome contributes to `failed` only when no declared recovery path remains. A settled selected `cancelled` outcome contributes to `cancelled` when the applicable cancellation scope is settled. A parent cannot contribute a terminal outcome while it owns an unsettled child unless ownership is durably transferred or the child has an actual committed cancellation settlement. Admission `denied` is never a Node or Run terminal state.

### 20.5 Event delivery

Event delivery MUST provide ordered delivery within each declared source or coordination key, durable ordering for Log Records, correlation and causation metadata, activation identity reuse, and an explicit duplicate strategy. It MUST linearly serialize admission, outcome selection, cancellation and deadline arbitration, breaker, bulkhead, ownership, immutable effect registration, and effect-dispatch authorization operations by their declared coordination keys. When multiple keys are required, it MUST use a composite key or atomic multi-key operation with deterministic global key order. It MUST implement the steer and queue drain-lane semantics of Section 11.4 for mid-run input and the stale-result suppression semantics of Section 13.15. Cross-source total order is optional unless a graph declares it as a requirement.

### 20.6 Replay and side effects

At minimum, the runtime MUST reconstruct state and projections from durable Log Records. Recorded-edge re-drive and controlled re-execution are stronger optional capabilities. Reconstruction and recorded-edge re-drive MUST preserve committed waits, `TimerDue`, `DeadlineExpired`, fences, outcome selections, authority revisions, approval consumption, ownership epochs, and effect-dispatch claims without resampling jitter or repeating external effects. A runtime MUST NOT label any repetition of an unknown or confirmed-applied effect as safe, including controlled re-execution, without stable idempotency, reconciliation, verified no-op, completed compensation with a verified repetition-safe postcondition, or an explicit non-repeat policy.

Before approval, admission, or dispatch of a protected external effect, the runtime MUST immutably register its activation, effect slot or occurrence, operation, canonical arguments digest, security scope, validation-schema version, canonicalization version, digest-algorithm version, operation-contract version, and committed canonical bytes or protected content address. Before dispatch, the runtime MUST atomically record at most one current `DispatchAuthorized` claim for its stable effect identity and recheck the exact registration and descriptor versions immediately before `DispatchStarted`. Replay and recovery MUST reuse the committed canonical representation rather than recanonicalize it under a newer contract. A duplicate delivery, stale owner, ownership ambiguity, or descriptor mismatch MUST suppress dispatch and retain or set `effectOutcome = unknown` until mechanical safety is established.

### 20.7 Admission and quality gates

An admission gate MUST validate required structure, current authority, current approval, deadline, wait, resources, and readiness before protected work begins. For effectful work it MUST require the immutable effect registration and exact operation, canonical arguments digest, and security scope bound by any approval. It MUST commit exactly one Node-start admission Event per completed pre-final evaluation: `admitted`, `deferred`, `denied`, or `rejected`. A committed admitted decision is final for its invocation and pending attempt ordinal. Admission re-evaluation receives a fresh decision identity and revision without consuming an execution attempt only before admission becomes final. Missing requestable approval is `deferred`; explicit approval refusal is `denied`; malformed input or evidence is `rejected` with a FailureEnvelope. Only `admitted` can start protected work, atomically with its execution, initial ownership epoch, reservation, authority reference, and required approval consumption. The other results route to a declared wait, repair, fallback, escalation, or human-decision path without creating a Node terminal outcome.

An all-must-approve quality gate MUST pass only when each required evaluator approves according to its declared evidence contract. Missing or invalid evaluator output MUST be rejection unless the graph explicitly defines another safe outcome.

---

## 21. LLM-Agent Workflow Patterns

### 21.1 Research pattern

```text
observe request
  -> classify intent
  -> decide whether fresh evidence is needed
  -> gather independent evidence paths
  -> Join and reconcile evidence
  -> draft response
  -> evaluate acceptance criteria
  -> stream final response
```

The evidence Join MUST state how it handles conflicts, duplicates, missing sources, and uncertain findings.

### 21.2 Change-and-validate pattern

```text
observe request
  -> inspect relevant context
  -> form a plan
  -> submit protected actions for node-start admission
  -> apply change
  -> validate outcome
  -> repair or compensate if validation fails
  -> summarize evidence and result
```

The graph records the evidence that justified each protected action and whether the validation criteria were met.

### 21.3 Multi-actor coordination pattern

```text
Mission
  -> planning actor
  -> bounded Parallel or fan-out of specialist actors
  -> Join typed results
  -> coordinator selects next step
  -> response or repair
```

Each specialist has its own identity and typed result contract. The coordinator uses a Selector and Join pattern rather than an undefined special node type.

### 21.4 Intent-gated routing pattern

An intent gate classifies a request into declared classes and routes it to an appropriate graph path. For example:

```text
intent gate
  -> direct response when sufficient
  -> exploration when evidence is needed
  -> planning when the requested work is open-ended
  -> execution when a validated plan and authority are present
  -> clarification when the request is materially ambiguous
```

The classification is observable, reviewable, and revisable when new input changes the intended path.

### 21.5 Read-constrained planning pattern

A planning graph can constrain itself to observation, analysis, and plan production. It assesses ambiguity, gathers evidence when justified, drafts a plan, evaluates plan quality, and asks a human question when uncertainty would make the plan unsafe or unhelpful.

The constraint is enforced by capability attenuation and authorization policy, not by a planning instruction alone.

### 21.6 Plan execution with verification pattern

An execution graph admits a validated plan, selects ready work, delegates under bounded concurrency where useful, and independently verifies each claimed result before committing progress. A final quality gate assesses the completed work against declared acceptance criteria.

If verification rejects the result, the graph enters a bounded repair loop. At the repair bound, it escalates with recorded evidence rather than silently declaring success. Progress commits occur only after independent verification and a read-back or equivalent confirmation of the committed state.

### 21.7 Mode overlay pattern

A mode overlay materializes behavioral guidance, policy additions, and capability attenuation onto an Authored Graph before execution. It is not an alternate execution graph. The Effective Graph records the ordered overlay composition so operators can see which constraints applied.

---

## 22. How to Think About Graph Authoring

An ABG graph is an executable expression of operational intent, not a visualization over hidden control flow.

Good ABG authoring has these qualities:

1. **Behavior selection is explicit.** The graph shows why a path can start.
2. **Failure paths exist.** The graph describes recovery, escalation, or a failed outcome.
3. **Human intervention is clear.** Requests for approval, correction, and input are visible.
4. **Authority is inspectable.** Protected actions identify the relevant policy and resource boundary.
5. **Partial results have contracts.** The graph states when partial output is usable.
6. **Parallelism is real and bounded.** Static branches are concurrent, and fan-out has an explicit limit and aggregate.
7. **State changes are declared.** Blackboard bindings and transitions are validated and observable.
8. **Replay scope is honest.** The graph distinguishes reconstruction from recorded re-drive and controlled re-execution.

---

## 23. Design Principles

### 23.1 Explicit over implicit

Important decisions, authority gates, state changes, and recovery paths belong in the graph or its declared policy. They should not be hidden in uninspectable instructions.

### 23.2 Stream first

Long-running work should expose progress and terminal outcomes as Streams of Signals or Events rather than only as an opaque final result.

### 23.3 Human-visible runtime

An agent should be observable enough that a human can inspect what happened, why it happened, and how to intervene.

### 23.4 Bounded autonomy

Autonomy exists within explicit authority, time, cost, concurrency, recursion, retry, and continuation bounds.

### 23.5 Recovery is first-class

Cancellation, timeout, retry, compensation, escalation, and partial-result salvage are graph behavior, not afterthoughts.

### 23.6 Model-agnostic

ABG does not depend on a particular model. A model turn is one Action or actor specialization within a larger runtime.

### 23.7 Tool-agnostic

ABG models protected capabilities and external effects without requiring a specific action provider or interface.

### 23.8 Replayable by design

Runs should be designed for reconstruction from durable facts. Stronger replay forms require the stronger safeguards defined in Section 11.6.

---

## 24. Conceptual Tools of an ABG Control Plane

### 24.1 Graph as map

The Authored Graph describes intended paths. The Effective Graph describes the paths and constraints actually available to a Run.

### 24.2 Timeline as evidence

The Event Timeline is a projection of the Event Log that makes recorded causal links and operational changes understandable. The Event Log, not the Timeline, remains authoritative.

### 24.3 Policy as boundary

Policy defines behavioral constraints and resource authority. It shapes autonomy without replacing decision and workflow semantics.

### 24.4 Blackboard and memory as working surfaces

The Blackboard coordinates validated short-lived work. Memory supplies reusable knowledge. Context selects from both without collapsing either into a prompt.

### 24.5 Actor as unit of responsibility

Actors define identity, isolation, authority, cancellation, result submission, and failure boundaries.

### 24.6 Mission as durable intent

A Mission binds productive intent to constraints, graph selection, artifacts, and a catalog of execution attempts.

---

## 25. Glossary

| Term | Meaning |
|---|---|
| ABG | Async Behavior Graph, an event-driven model for agent decision and execution. |
| Authored Graph | Immutable declarative graph input before materialization. |
| Effective Graph | Pure materialization result used by a Run after ordered overlays apply. |
| Materialization | Deterministic, non-mutating transformation from Authored Graph and overlays to Effective Graph. |
| Mode | A named overlay of behavioral guidance, enforceable policy additions, and monotone authorization restrictions. |
| Mission | Durable productive intent with constraints, graph selection, artifacts, and a Run catalog. |
| Run | One execution attempt for a Mission and Effective Graph. |
| Node | A behavior unit that consumes declared input and emits Signals. |
| Activation identity | Committed identity formed from a causal Event, transition, or Edge; target Node; coordination generation; occurrence or item; and security scope. Duplicate delivery reuses one invocation. |
| Node invocation | Stable requested use of a declared Node, identified by `nodeInvocationId` across retries. |
| Node-start admission | Linearizable pre-start evaluation and committed decision outside the Node lifecycle. |
| admitted | Final admission result for an invocation and pending attempt ordinal that atomically creates one Node execution and initial ownership epoch, reserves declared bounded resources, and binds current authority and required approval use. |
| deferred | Admission result that creates no execution and records a declared wait. |
| denied | Admission result for policy, authorization, or explicit approval refusal; it creates no execution and is never automatically retried. |
| rejected | Non-policy admission result that creates no execution and carries a FailureEnvelope. |
| Admission decision | Committed result of one admission evaluation, identified by a fresh causally chained `admissionDecisionId`. |
| Admission revision and supersession | Monotonic revision for an invocation and pending attempt ordinal before final admission; a later pre-final revision fences a prior decision, while a committed admitted decision is never superseded. |
| Readmission | Bounded fresh admission evaluation after a rejected admission that created no execution and did not consume an execution attempt. |
| One-use approval | Approval atomically bound and consumed for a principal or actor, immutable effect registration when effectful, exact operation and arguments digest, purpose, generation, attempt, expiry, and use count. |
| Node execution | One admitted execution identified by `nodeExecutionId`. |
| Attempt ordinal | Invocation-local execution count, including the initial attempt and increasing only for a new retry execution. |
| Settlement | The one committed terminal Event, if any, for a Node execution. |
| Terminal Signal candidate | A `succeeded`, `failed`, or `cancelled` Signal that follows `AcceptCandidate -> SelectOutcome -> Settle`; acceptance alone cannot settle an execution. |
| Terminal outcome | One of exactly `succeeded`, `failed`, or `cancelled` for a settled Node execution. |
| Fault | Condition that can prevent or invalidate intended work. |
| Error | Observed exception, message, status, or malformed response that is not itself an authoritative failure fact. |
| Failure | Typed authoritative operational fact represented by a FailureEnvelope. |
| FailureEnvelope | Versioned typed failure fact with identity, phase, category, code, safe summary, retry, effect, compensation, and causal information. |
| Safe summary | Bounded, redacted, control-character safe, non-recursive, human-safe FailureEnvelope summary. |
| Failure phase | Closed FailureEnvelope stage: `admission`, `execution`, `settlement`, `cancellation`, `compensation`, or `recovery`. |
| Retry disposition | Closed FailureEnvelope retry guidance: `never`, `after_delay`, `after_change`, or `after_reconcile`. |
| Retry eligibility | Proposal predicate for a settled failed execution based on policy, bounds, timing, mechanical effect safety, poison, and fences; a later Admission acquires current authority, approval, ownership, permits, and reservations. |
| Recovery lineage | Durable shared identity and budget spanning retry-equivalent retry, readmission, fallback, restart, defer cycling, compensation retry, and graph recovery cycles. |
| Backoff and jitter | Declared bounded retry timing whose base delay, jitter fact, final delay, `notBefore`, and deadline are committed before scheduling. |
| Deadline | Inherited absolute latest time for work to remain eligible. |
| Timeout | Relative duration resolved to an absolute deadline that cannot extend its parent deadline. |
| Result contract | Declared identity and version, value or reference, completeness, assurance, evidence, and provenance required for a result. |
| Partial result | Result with `partial` completeness; it is a quality, not a terminal state. |
| Degraded result | Result with `degraded` assurance; it is a quality, not a terminal state. |
| Effect outcome | Recorded external-effect state: `not_applicable`, `not_started`, `confirmed_not_applied`, `confirmed_applied`, or `unknown`. |
| Effect registration | Durable immutable binding of effect identity to activation, effect slot or occurrence, operation, canonical arguments, security scope, and versioned validation, canonicalization, digest-algorithm, and operation-contract descriptors. |
| Effect ledger | Committed record of stable external-effect identities, dispatch claims, dispatch states, and effect outcomes. |
| Effect-dispatch claim | At-most-one orchestrator claim for an effect identity, carrying immutable registration, fence, execution, ownership, authority, approval, ordinal, and state. `DispatchAuthorized` precedes `DispatchStarted`. |
| Reconciliation | Declared process that determines or safely bounds the outcome of a possible external effect. |
| Compensation | Separately admitted bounded execution that reverses or mitigates effects without erasing original facts, ordered over causal effect dependencies. |
| Compensation status | Closed FailureEnvelope compensation state: `not_required`, `not_started`, `pending`, `succeeded`, `failed`, or `unknown`. |
| Circuit breaker | Committed `closed`, `open`, or `half_open` resilience control keyed by dependency or resource. |
| Bulkhead | Declared capacity partition with atomic admission reservation, queue, fairness, deadline, and overflow rules. |
| Checkpoint | Boundary-durable cache Event over a content-addressed committed Log prefix and anti-rollback anchor compared with an independent authoritative high-water mark. |
| Ownership epoch | Committed exclusive ownership or lease generation that fences prior execution owners during transfer or reattachment. |
| Outcome selection | Durable operation that chooses one immutable execution outcome before settlement from terminal candidates, cancellation fences, and deadline expiry. |
| TimerDue | Idempotent committed fact that a recorded `notBefore` delay has elapsed. |
| DeadlineExpired | Committed fact that an inherited absolute deadline elapsed; distinct from TimerDue. |
| Poison fingerprint | Committed, versioned canonical repeated-failure identity used to disable unchanged automatic retry at a declared threshold. |
| Stale fence | Captured input, Context, authority, contract, effect, admission, identity, generation, ownership, and parent-settlement values that prevent obsolete facts from changing committed state. |
| Fallback | Declared routing to alternative work, distinct from retry and unable to bypass denial or widen authority. |
| Action Node | A Node that performs work. Model, memory, and external actions are specializations. |
| Edge | Declared control, data, Event, guard, mapping, priority, or cancellation connection. |
| Signal | A transient execution emission from a Node to the runtime. |
| Event | An immutable fact admitted with its durable Log Record. |
| Stream | An ordered flow of Signals or Events. Its durability class governs which Signals or observations are admitted as Events. |
| Log Record | Durable envelope for an Event, including ordering, source, correlation, and causation. |
| Event Log | Immutable sequence of Log Records and the sole authoritative source of execution facts. |
| Correlation | Link among facts belonging to one broader intent or scope. |
| Causation | Link to the direct prior fact, decision, or transition that caused an Event. |
| Context | Read-oriented view supplied to a Node. |
| Blackboard | Runtime-managed structured working memory with declared bindings and shapes. |
| State | Current runtime snapshot, including active graph and validated Blackboard values. |
| Memory | Reusable knowledge and artifacts selected into Context when relevant. |
| Policy | Behavioral constraints and resource authorization rules. |
| Authorization constraint | Deny-preserving restriction over capability, resource, scope, time, purpose, and approval requirements. |
| Policy Gate | A Node pattern that evaluates policy before a protected transition or action. |
| Actor | Isolated execution entity with identity, authority, lifecycle, and result contract. |
| Human Node | Node that awaits a human response, approval, correction, or selection. |
| Parallel Node | Node that coordinates truly concurrent static branches or bounded collection fan-out. |
| Race Node | Node that selects the earliest valid committed success under a declared validity rule. |
| Join Node | Node that merges declared results or streams under an explicit contract. |
| Watch Node | Node that monitors declared Events and applies a declared response. |
| Timeline | Human and operational projection of the authoritative Event Log; never an independent authority. |
| Reconstruction | Rebuilding state and projections from durable Log Records. |
| Recorded-edge re-drive | Reapplying recorded decisions and observations without repeating external effects. |
| Controlled re-execution | Selectively repeating work under explicit authority, idempotency, and compensation rules. |
| Continuation | Bounded same-Run session resumption or a causally linked successor Run, distinct from an in-graph loop. |
| Coordination key | Identifier for demands that MUST be serialized to protect one coordination scope. |
| Drain lane | Ordered admission owner for one coordination key. |
| Generation | One uniquely identified active admission cycle in a drain lane. |
| Steer | Compatible later input admitted into an active generation at a safe admission boundary. |
| Queue | Later demand held for promotion after the current generation reaches a handoff point or settles. |

---

## 26. Conclusion

Async Behavior Graphs do not reduce LLM agents to prompt chains or bare action loops. They treat an agent as a running system:

```text
observe facts
  -> select behavior from an Effective Graph
  -> coordinate asynchronous work
  -> validate policy and declared state changes
  -> append committed Event Log facts and apply their projections
  -> project an accountable Timeline
  -> recover, wait, or complete
```

The central ABG claim is simple:

> Reliable agent behavior comes from observable execution structure, explicit authority and policy, honest replay semantics, durable facts, and graph paths that humans can inspect and influence.

---

## Appendix A. ABG as a One-line DSL

```text
author graph -> materialize overlays -> interpret Signals -> admit Events with records -> apply committed projections -> select behavior -> coordinate actors -> repeat
```

---

## Appendix B. Mandatory Minimal Conformance Contract

A conforming ABG runtime MUST satisfy every item in this contract:

### B.1 Core Conformance Requirements

```text
1. Materialization MUST be pure, deterministic, ordered, and leave the Authored Graph unchanged. Unresolved overlay conflicts MUST fail closed.
2. Authorization overlays MUST preserve or reduce baseline authority by meet across capability, resource, scope, time, purpose, and approval requirements. Baseline and parent denies MUST be preserved, and approval requirements MUST NOT be relaxed; wider authority requires a revised Authored Graph.
3. Nodes MUST emit Signal streams and MUST NOT arbitrarily mutate shared state.
4. The runtime MUST parse and validate declared Blackboard bindings before admitting their Events with Event Log Records and making the associated projection visible. Append failure MUST leave no admitted Event or committed update; atomic record-plus-projection commits MAY be used.
5. Signals, observations, Events, Streams, Log Records, and the Event Log MUST have distinct semantics. Every Event MUST have a Log Record, and the Event Log MUST be the sole authoritative source of execution facts.
6. Audit-critical Events MUST have durable Log Records with causation and correlation metadata. Run and Mission record scopes MUST remain distinguishable.
7. Actors MUST have identity, authority boundaries, cooperative cancellation, typed result contracts, and terminal stop, failure, and cancellation semantics.
8. Static Parallel branches MUST be concurrent, and collection fan-out MUST declare bounded concurrency and an aggregate contract.
9. Race and Join Nodes MUST define validity, readiness, cancellation, and merge behavior explicitly.
10. Policy MUST distinguish behavioral guidance from resource authorization and MUST attenuate through overlays and delegation.
11. Mission catalog state and Run execution state MUST remain separate; a Run is one execution attempt.
12. A coordination key MUST have one active generation and MUST implement steer, queue, coalescing, promotion, interrupt, and stale admission and result suppression.
13. Continuation bounds MUST differ from in-graph loop bounds. Done, durable stop, and explicit resume MUST become committed Events before controlling restart-safe continuation.
14. Reconstruction from durable facts MUST be the minimum replay capability. Controlled re-execution MUST require side-effect policy.
15. Side-effecting controlled replay and automatic retry MUST require stable idempotency, reconciliation that establishes repetition-safe state, verified no-op, completed compensation with a verified repetition-safe postcondition, or explicit prohibition. Authority, approval, or risk acceptance MUST NOT substitute for mechanical effect safety.
16. Admission and all-must-approve quality gates MUST fail closed when required input or approval is missing or invalid.
17. A model turn MUST be one managed Action or actor specialization, not the entire runtime.
18. Node-start admission MUST be outside the Node lifecycle and produce exactly admitted, deferred, denied, or rejected as committed Events. Admission evaluation MUST be linearizable, revisioned, and atomically bind the final admitted Event, execution, initial ownership, reservation, current authority, required one-use approval consumption, and applicable permits. A committed admitted decision MUST NOT be superseded or followed by another admission-result Event for the same invocation and pending attempt ordinal.
19. Every started execution MUST preserve at-most-one committed settlement with terminal outcome succeeded, failed, or cancelled. Outcome selection MUST precede settlement. Terminal Signals are candidates, and settlement, release, or transfer MUST commit atomically. A parent MUST wait for owned children to have actual committed cancellation settlements or durably transfer ownership before parent settlement.
20. Failures MUST use the closed FailureEnvelope taxonomy and supporting values. Safe summaries and evidence references MUST be bounded and redacted. Cancellation, valid denial, valid false Condition, and valid Selector no-match MUST NOT be represented as failure categories.
21. Retry applies only to settled failed executions and only proposes the next pending attempt; atomic Admission acquires all current permits, authority, ownership, and reservations. Readmission applies only to rejected admissions without executions and is a separate bounded policy, condition, timing, and fence predicate; only its subsequent fresh Admission rechecks current authority, deadline, wait, resources, and permits. Retry, readmission, backoff, jitter, TimerDue, DeadlineExpired, waits, and budgets MUST be bounded and committed before visible scheduling. Reconstruction and recorded-edge re-drive MUST reuse timing facts without resampling.
22. Sequence, Parallel and fan-out, Race, Join, and Statechart Nodes MUST declare admission, outcome, missing-input, partial-result, cancellation or draining, child ownership, and deterministic aggregation behavior. Valid false Condition and Selector no-match MUST use ordinary successful routing results.
23. Supervisors, circuit breakers, and bulkheads MUST have declared bounded, committed resilience state, isolation scope, coordination keys, and current-authority checks. Breaker counts use only unique eligible failed settlements; half-open permits and bulkhead queue operations MUST be atomic. Multi-key operations MUST use a composite key or atomic transaction with deterministic global key order and all-or-nothing visibility. Unsupported advanced resilience declarations MUST fail closed.
24. An unknown or confirmed-applied external effect MUST prohibit automatic and controlled repetition unless stable idempotency, reconciliation, verified no-op, or completed compensation with a verified repetition-safe postcondition establishes safety. Committed authority, approval, risk acceptance, or pending, accepted, or unknown compensation MUST NOT establish safety.
25. Checkpoints MUST be boundary-durable references to content-addressed committed Log prefixes with anti-rollback anchors. Restore MUST verify the prefix and deterministic projection, preserve outcome selections, effect-dispatch claims, fences, and ownership epochs, and place every recovered started execution into reattached, atomically retired and settled, or explicitly transferred durable state.
26. Compensation MUST be separately admitted bounded work with its own identities and settlement. Its dependency graph MUST be acyclic before it starts; it MUST reconcile unknown effects first unless declared otherwise and use deterministic reverse causal ordering. Stale candidates or results MUST NOT change committed state while possible effects remain available to reconciliation.
27. Every protected initial start, retry, readmission, fallback, restart, compensation, recovery, and reattachment MUST atomically validate and bind fresh current authority and required approval. Recovery MUST NOT widen authority.
28. Cancellation and deadline arbitration MUST use the earliest committed applicable fact under the execution coordination key. Draining MUST be bounded, and nonterminating work MUST be fenced and orphaned or transferred before parent settlement or reservation release.
29. Admission, result, effect-proposal, and effect-dispatch fences MUST include input, Context, authority revision, result-contract version, effect, admission revision, generation, invocation, execution, actor, attempt, ownership epoch, and parent-settlement facts. An effect identity has at most one orchestrator dispatch claim.
30. Poison fingerprints MUST commit their versioned canonical components, selected canonical input values or unambiguous value digest, security scope, and counting scope. Deferred queue count, bytes, evaluation rate, and elapsed wait MUST be bounded.
31. A committed activation identity MUST map to at most one Node invocation. Effectful work MUST register an immutable effect identity to activation, occurrence, operation, canonical arguments, security scope, and versioned validation-schema, canonicalization, digest-algorithm, and operation-contract descriptors before approval, admission, or dispatch; substitution or recanonicalization under a changed descriptor MUST fail closed.
32. DispatchAuthorized and DispatchStarted MUST serialize with effect claim, cancellation, DeadlineExpired, outcome selection, authority, approval, and ownership. Cancellation or non-succeeded outcome before authorization prohibits dispatch; authorization before cancellation or transfer makes the effect in flight or possibly applied until observed or reconciled.
33. A durable recovery-lineage budget MUST span retry-equivalent cycles without reset by a new invocation. Deferred queue slots MUST release or transfer on every resolution path. A checkpoint below an independently retained authoritative high-water mark MUST be rejected.
```

### B.2 Fault-Tolerance Validation Scenarios

Each scenario is a trace over committed Events. `Then` states the required identity preservation, Event order or count, terminal outcome where applicable, and a required negative assertion.

| Scenario | Given | When | Then |
|---|---|---|---|
| Log append failure | A pending protected admission. | The atomic admission append fails. | Zero admission Events, executions, reservations, approval consumptions, and downstream activations become visible. |
| Settlement and atomic release failure | An outcome is selected and settlement needs reservation release. | The combined settlement and release commit fails. | Zero settlement Events, releases, transfers, and downstream activations become visible; recovery retains the selected outcome. |
| Denial before start | A current policy or approval explicitly refuses. | Admission evaluates. | One `Denied` Event, zero executions, and no Node or Run terminal result are recorded. |
| Deferred then denial | An invocation is waiting for requestable approval. | A later evaluation observes explicit refusal. | `Deferred(revision r)` precedes `Denied(revision r+1)` for the same invocation and pending ordinal; zero executions exist. |
| Malformed input | Required evidence is malformed. | Admission evaluates. | One `Rejected` Event with an admission FailureEnvelope is committed; zero executions and retries occur. |
| Duplicate causal activation delivery | The same committed activation is delivered twice. | Both deliveries request the target Node. | One activation identity maps to one reused invocation; zero additional invocation or effect identities are minted. |
| Admitted finality after duplicate wake | An `Admitted` Event already committed for one invocation and pending ordinal. | A duplicate wake arrives. | The final decision is returned or reused, or one ignored duplicate observation is recorded; zero later admission-result Events, executions, reservations, or approval consumptions occur. |
| One-use approval race | Two compatible requests present the same one-use approval. | Both evaluate concurrently. | One atomic approval consumption and at most one `Admitted` Event occur; the other request cannot start. |
| Approval digest or contract substitution | An approval references an immutable effect registration, canonical arguments, and versioned schema, canonicalization, digest, and operation-contract descriptors. | Admission, recovery, or dispatch presents a different operation, digest, descriptor version, contract version, or security scope, or recanonicalizes under a newer contract. | The mismatch fails closed; committed canonical bytes or their protected reference are reused; zero admissions, dispatch authorizations, or physical-send attempts occur. |
| Rejected readmission | A rejected admission created no execution. | `ReadmissionEligible` passes after a changed condition. | A fresh causally chained decision and revision retain invocation and pending ordinal; execution attempt count remains unchanged until a later admission. |
| Ineligible readmission | A rejected admission lacks required policy, condition change, `notBefore`, or remains cancelled, denied, or retired. | Readmission is considered. | No new admission evaluation or execution is scheduled; the pending ordinal and prior rejection remain unchanged. |
| Multi-key transaction rollback | Admission requires authority, approval, breaker, bulkhead, ownership, and resource keys. | One claim or commit fails. | Zero admission, permit, reservation, ownership, or approval-use facts become visible; no dispatch or execution starts. |
| Cancellation before deadline | A running execution has a deadline. | Applicable cancellation fence commits before `DeadlineExpired`. | Cancellation selects immutable `cancelled`; settlement follows drain, and later expiry cannot change it. |
| Deadline before cancellation | A running execution has a deadline. | `DeadlineExpired` commits before applicable cancellation fence. | Expiry selects immutable `failed` with `deadline`; settlement follows drain, and later cancellation only drains or reconciles. |
| Success before deadline | A running execution has a deadline. | An eligible success candidate selects outcome before `DeadlineExpired`. | `succeeded` remains immutable through settlement; later deadline expiry cannot replace it and only remains observable. |
| Cancellation before DispatchAuthorized | A protected effect is registered but has no dispatch authorization. | Cancellation or a non-succeeded outcome selects first. | DispatchAuthorized and DispatchStarted are prohibited; zero physical-send attempts occur. |
| DispatchAuthorized before cancellation | DispatchAuthorized commits before cancellation or transfer. | Cancellation then selects or ownership changes. | The claim is retained, the effect is treated in flight or possibly applied with `unknown` outcome until observed or reconciled, and no redispatch occurs. |
| Condition false | A valid predicate evaluates false. | The Condition settles. | One `succeeded` settlement carries `matched = false`; no FailureEnvelope, retry, breaker count, poison count, or failure propagation occurs. |
| Condition evaluator malfunction | Predicate evaluation cannot complete validly. | The Condition settles. | One `failed` settlement carries a FailureEnvelope; ordinary false routing is not emitted. |
| Selector no-match | A valid declared selection finds no candidate. | The Selector settles. | One `succeeded` settlement carries `selection = none`; no retry, breaker count, poison count, or failure propagation occurs. |
| Selector malfunction | A selector evaluator or model-assisted selection malfunctions. | The Selector settles. | One `failed` settlement carries a FailureEnvelope; `selection = none` is not used as a substitute. |
| Concurrent terminal candidates | One execution receives conflicting terminal candidates. | Candidates race under its execution key. | The earliest eligible committed candidate selects one immutable outcome; after required drain one settlement follows, while later candidates are stale and create no downstream activation. |
| Parent with unsettled child | A parent owns an active child. | The parent receives its own terminal candidate. | Parent settlement is blocked until child settlement, actual committed child cancellation settlement, or durable ownership transfer; no premature parent terminal Event occurs. |
| Cancellation drain timeout | Cancellation begins while executor or child remains active. | The declared drain bound expires. | A fence and durable recovery-owner transfer precede parent settlement or release; possible effects are `unknown` and route to reconciliation. |
| Bounded retries | A failed execution has `maxAttempts = 1`. | Retry is considered. | No new execution is created; waiting did not consume an attempt, and retry eligibility remains false. |
| Deterministic jitter replay | A retry schedule has committed base delay, jitter fact, final delay, `notBefore`, and deadline. | Reconstruction or recorded-edge re-drive runs. | The recorded timing facts and identities are reused exactly; no jitter is resampled and no effect is repeated. |
| Timer re-arm versus TimerDue | A retry delay has committed `notBefore`. | Recovery occurs before, then at or after, `notBefore`. | Before it re-arms the recorded timer with no routing Event; after it commits one idempotent `TimerDue` Event before routing. `DeadlineExpired` remains separate. |
| Poison canonicalization stability | Equivalent inputs differ only in irrelevant representation. | Their failures are counted. | Committed canonicalization identity, version, selected canonical values or value digest, components, and fingerprint are reused on replay; declared equivalent inputs count in the same scope. |
| Concurrent composites | A fan-out has multiple children and a declared coordination key. | A fail-fast cause and later child results arrive. | The serialized first declared cause controls fail-fast, fail-slow retains every cause, and aggregation uses declared identities and order rather than arrival order. |
| Half-open stampede | A breaker enters `half_open` with one probe permit. | Multiple admissions race. | At most one atomic probe reservation is admitted; nonpermit requests are deferred or rejected and do not count as breaker failures. |
| Breaker counting and open admission | A breaker has duplicate, stale, denied, cancelled, and unique eligible failed reports. | It counts and then opens. | Only unique eligible failed settlements change the threshold; an open breaker defers with a wait or rejects `dependency` or `resource`, and its rejection does not count. |
| Bulkhead queue overflow and promotion | A full partition has a bounded queue. | One request overflows and another queued request is promoted. | Overflow is one `Rejected(resource)` Event; promotion is atomic and rechecks current deadline and authority before any admission. |
| Deferred queue slot release | A deferred bulkhead decision owns a queue slot. | It resolves to Denied, Rejected, cancellation, expiry, or transfer. | The slot releases or transfers atomically with resolution; no leaked slot blocks later promotion. |
| Duplicate initial protected-effect delivery | One execution emits the same effect proposal twice. | Dispatch is attempted twice. | One dispatch claim keyed by effect identity commits; the second delivery is suppressed and no second orchestrator dispatch occurs. |
| Ownership transfer between authorization and send | DispatchAuthorized exists and ownership transfers before physical send. | Old and new owners attempt DispatchStarted. | With sink fencing, the stale owner is rejected by the token; without it, physical prevention is not claimed, the effect becomes in flight or unknown, and no redispatch occurs. |
| Undeclared degraded result | A result is partial or degraded outside its contract. | It reaches settlement. | It cannot settle `succeeded`; only explicit salvage may accompany `failed` or `cancelled`. |
| Unknown effect plus risk acceptance | An effect outcome is `unknown` and a human accepts residual risk. | Any repetition is considered. | Automatic and controlled repetition remain prohibited; risk acceptance may authorize reconciliation, uncertainty-aware compensation, or abandonment only. |
| Compensation ordering | Effects have declared causal dependencies and incomparable branches. | Compensation is admitted. | Compensation follows reverse topological order and declared tie-break or parallel-antichain rule; original effect facts remain visible. |
| Compensation cycle rejection | A compensation dependency graph contains a cycle. | Compensation is considered. | One failure or declared rejection routes before compensation starts; zero compensation executions or effects occur. |
| Inconsistent or stale checkpoint | A checkpoint digest, anchor, or projection disagrees with its Log prefix. | Restore evaluates it. | The checkpoint is discarded as cache; no stale state, breaker, bulkhead, or execution ownership is restored. |
| Ownership epoch reattachment | A running execution may be reattached after recovery. | A new owner requests reattachment. | Exclusive new epoch or lease, old-owner fence, identity proof, fresh authority, prior outcome selection, and dispatch claims commit or are preserved before reattach; otherwise recovery retires, settles the already selected outcome or selects recovery failure, and releases or transfers obligations. |
| Recovery with no retry | A started execution is recovered and retry is not intended or eligible. | Recovery closes it. | It is exactly one of reattached, atomically retired and settled with release, or explicitly transferred; no active unowned execution or reservation remains. |
| Recovery-lineage budget laundering | Retry, fallback, restart, and new-invocation routes share one recovery lineage. | They cycle until the shared budget is exhausted. | The new invocation does not reset budget; the graph follows declared rejection, cancellation, human escalation, or terminal-failure route. |
| Checkpoint below authoritative high-water mark | A checkpoint anchor is below an independently retained authoritative high-water mark. | Restore evaluates it. | The checkpoint is rejected; zero state, ownership, effect claim, or projection restoration occurs. |
| Replay-form separation | A history contains effects and timer facts. | Reconstruction, recorded-edge re-drive, and controlled re-execution are requested. | The first two repeat no effects or timers; controlled re-execution uses new identities and fresh safety checks. |
| Steer, revocation, or Context-version stale result | A result captured old input, Context, authority, or contract fences. | A steer, revocation, or contract change commits first. | The old result is stale and cannot settle or activate downstream work unless explicit compatibility accepts every captured value. |
| Bounded deferred flood | Deferred arrivals exceed declared queue or re-evaluation limits. | Additional waits or wakeups arrive. | Limits produce declared rejection or escalation; queue bytes, count, rate, and elapsed wait remain bounded and no duplicate admission occurs. |
| No authority widening | A retry, fallback, restart, delegation, compensation, or recovery path is proposed. | Authority is weaker, revoked, or denied. | No path bypasses the current authority check or denial; no execution starts and no recovery widens authority. |

---

## Appendix C. Core Metaphors

```text
A Behavior Tree is a decision structure for behavior.
A Statechart is a map for long-running procedures.
An actor system is an organization of independent executors.
A Stream is the nervous system of coordination.
An Event Log is the ledger of fact and audit.
Policy is the boundary around autonomy.
An Async Behavior Graph binds them into an observable agent runtime.
```
