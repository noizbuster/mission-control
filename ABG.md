# Async Behavior Graph Theory Design Document

**Project:** mission-control / mctrl  
**Document purpose:** To define the theoretical background, philosophy, and execution semantics of Async Behavior Graphs for building, observing, and operating LLM agent workflows.  
**Scope:** This document intentionally excludes implementation boilerplate, package layout, TUI/Desktop technology choices, build systems, and deployment details. It focuses on the conceptual model that `mission-control` should operate: what kind of runtime it controls, what kind of behaviors it represents, and how LLM agents can be made observable, interruptible, and reliable.

---

## 1. Executive Summary

**Async Behavior Graph**, abbreviated as **ABG**, is a graph-based orchestration model for LLM agents. It unifies behavior selection, long-running workflows, asynchronous tool execution, streaming observations, user intervention, policy enforcement, and failure recovery into one operational model.

ABG does not discard Behavior Trees. Instead, it treats Behavior Trees as one useful subset of a larger model. Behavior Trees are excellent at answering the question:

```text
Given the current situation, what should the agent do next?
```

ABG expands this question into a broader runtime problem:

```text
Given a stream of events, changing context, active workflows, running actors,
policy constraints, user interventions, and partial results,
what should the agent do next, what should continue running,
what should be cancelled, and what should be recorded?
```

ABG combines ideas from several established models:

- **Behavior Trees** for priority, conditions, selection, and fallback-oriented decision making.
- **Statecharts** for explicit state transitions in long-running workflows.
- **Actor Model** for isolated execution units, message passing, cancellation, supervision, and restart.
- **Reactive Streams / Dataflow** for asynchronous events, partial results, token streams, and tool output streams.
- **Event Sourcing** for observability, replay, auditability, and state reconstruction.
- **Policy Runtime** for cost limits, time limits, safety boundaries, permissions, user approvals, and confidence-based gates.

A concise definition:

> An Async Behavior Graph is an event-stream-driven decision and execution model that combines stateful workflows and actor-based execution to dynamically select, run, observe, revise, and recover LLM agent behavior.

Under this model, `mission-control` is not merely an agent launcher. It is an **LLM agent operations console**: a control plane for authoring, running, inspecting, replaying, and steering Async Behavior Graphs.

---

## 2. Why a New Concept Is Needed

A traditional software function often follows this shape:

```text
input -> function -> output
```

An LLM agent workflow is different. It usually looks more like this:

```text
user message
  -> intent analysis
  -> context gathering
  -> planning
  -> tool execution
  -> partial result observation
  -> plan revision
  -> ask user or continue
  -> validation
  -> final streamed response
```

Several problems appear at the same time.

### 2.1 Situation-dependent behavior selection

The agent must continuously decide what to do next:

```text
Should it answer now?
Should it search more?
Should it read files?
Should it run tests?
Should it call a model?
Should it ask the user?
Should it stop because the result is good enough?
```

This is where Behavior Trees are useful, but only as part of the answer.

### 2.2 Long-running workflows

A single user request may involve many steps:

```text
inspect -> plan -> edit -> test -> repair -> summarize
```

These steps may take seconds, minutes, or longer. They may pause, wait for user approval, fail, retry, or resume from a checkpoint.

### 2.3 Asynchrony and parallelism

File search, web search, shell commands, model calls, database reads, browser actions, and API calls can run concurrently. Some tasks may finish early. Others may continue streaming. Some may become irrelevant and should be cancelled.

### 2.4 Streaming results

LLM tokens, shell stdout, test logs, search results, browser observations, and tool output often arrive incrementally. Treating every action as `await result` hides the most important part of agent execution: the process.

### 2.5 Mid-run user intervention

Users do not always wait until the agent is done. They may say:

```text
No, not that file. Look at the API side.
Cancel this.
Use the cheaper model.
Do not edit files yet.
Continue, but skip tests.
```

The runtime must treat user intervention as a first-class event, not as an exceptional interruption.

### 2.6 Failure recovery

Agent systems must handle tool failures, timeouts, rate limits, invalid tool arguments, failing tests, poor model output, stale context, missing permissions, and conflicting evidence.

A useful agent runtime cannot only represent the happy path. It must represent recovery paths.

### 2.7 Operational visibility

An operator must be able to answer:

```text
Why did the agent call this tool?
Why did it use this model?
Why did it stop searching?
Why did it ask for approval?
Why was this actor cancelled?
Where did the run fail?
Can I replay it?
Can I resume from here?
```

Prompt chains and simple tool loops usually do not provide enough structure to answer these questions.

Behavior Trees, State Machines, Workflow Engines, Actors, and Reactive Streams each solve part of the problem. ABG integrates these ideas into a single operational model for LLM agents.

---

## 3. Relationship to Existing Methodologies

### 3.1 Relationship to Behavior Trees

A Behavior Tree is a behavior selection model widely used in game AI and robotics. Nodes usually return one of three statuses:

```text
SUCCESS | FAILURE | RUNNING
```

Behavior Trees are strong at:

- Priority-based behavior selection.
- Separation of conditions and actions.
- Fallback behavior.
- Readable decision structures compared to deeply nested `if/else` logic.
- Representing ongoing actions with `RUNNING`.

However, in LLM agent systems, `RUNNING` is too coarse. A tool that is running may produce many meaningful events:

```text
tool.started
tool.stdout.delta
tool.partial_result
tool.rate_limited
tool.retried
tool.completed
tool.failed
```

A classic Behavior Tree does not treat this stream as a first-class object. ABG keeps the selection strengths of Behavior Trees, but expands node output from a simple status into a **Signal stream**.

In ABG:

```text
Behavior Tree status is a special case of a richer stream protocol.
```

```text
RUNNING -> started + progress signals
SUCCESS -> success signal
FAILURE -> failure signal
```

### 3.2 Relationship to Statecharts

A Statechart explicitly models states and transitions:

```text
idle -> planning -> executing -> observing -> responding
```

Long-running LLM workflows often fit this model well. A code-fixing workflow, for example, may be represented as:

```text
inspect -> plan_patch -> edit -> test -> review -> respond
                     \-> failure -> repair_or_rollback
```

ABG can embed a Statechart as a node or subgraph:

```text
Decision Node
  -> Workflow Node: code-fix-flow
      states:
        inspect
        patch
        test
        review
        respond
```

Statecharts give ABG explicit procedural structure without forcing the entire agent to become a fixed state machine.

### 3.3 Relationship to the Actor Model

The Actor Model represents independent execution units that communicate by messages:

```text
PlannerActor -> ToolActor -> ObserverActor -> MemoryActor
```

Actors are a natural fit for LLM agents because many parts of an agent workflow are independently running, cancellable, and failure-prone:

- Tool executors.
- Subagents.
- File watchers.
- Test runners.
- Long-running shell commands.
- External event subscribers.
- Model-call workers.
- Memory retrieval workers.

Actors provide isolation, mailboxes, cancellation, restart, supervision, and backpressure. In ABG, actors form the execution layer beneath the decision and workflow layers.

### 3.4 Relationship to Reactive Streams and Dataflow

LLM agents are streaming systems.

Streams may include:

- User messages.
- Model token deltas.
- Tool stdout.
- Tool partial results.
- Search result batches.
- File change notifications.
- Timer events.
- Policy events.

ABG treats streams as first-class inputs and outputs:

```text
Input Event Stream
  -> Decision Graph
  -> Action Stream
  -> Observation Stream
  -> Updated Context
```

In this view, the central question is not only:

```text
Has the task completed?
```

It is also:

```text
What events are flowing right now,
and how should those events change the next behavior?
```

### 3.5 Relationship to Workflow Engines

Workflow engines such as Temporal, Durable Functions, Airflow, or similar systems are strong at durability, retries, long-running processes, and state recovery.

ABG has overlapping concerns, but its center of gravity is different.

A workflow engine is often about:

```text
Reliably executing a known procedure.
```

ABG is about:

```text
Observing a changing situation and dynamically selecting the next procedure.
```

In other words, ABG includes workflow concepts, but it is more agentic. It must allow the path itself to change based on observations, policy, partial results, and user intervention.

---

## 4. Core Philosophy

### 4.1 An agent is not a function; it is a running system

An LLM agent should not be modeled as a single function call. It is better understood as a running system with state, events, policies, memory, tools, and an event loop.

```text
Agent = policy + memory + tools + workflow + event loop
```

ABG treats an agent not as a chain of calls, but as an execution system that can be observed and controlled.

### 4.2 Behavior is a process, not just a result

Traditional async code often focuses on the final result:

```text
result = await runTask(input)
```

ABG focuses on the process:

```text
for await (signal of runTask(input)) {
  observe(signal)
  decide(signal)
  maybeIntervene(signal)
}
```

A behavior includes start, progress, partial output, retry, cancellation, failure, recovery, and completion. These are not incidental implementation details. They are part of the behavior.

### 4.3 Decision and execution should be separated

A common failure mode in LLM agent systems is mixing decision logic and execution logic in the same function or prompt.

For example, one block may contain:

- Deciding what to do.
- Calling a tool.
- Handling timeouts.
- Retrying failures.
- Updating internal state.
- Writing user-facing messages.

ABG separates these concerns:

```text
Decision Layer : chooses what should happen next.
Workflow Layer : manages the procedure and state transitions.
Actor Layer    : executes actual work.
Stream Layer   : carries events and partial results.
Policy Layer   : constrains and authorizes behavior.
```

This separation improves observability, testability, safety, and replayability.

### 4.4 Important things must become events

In ABG, the event log is not just debug output. It is the operational ledger of the agent.

Examples:

```text
user.message.received
decision.selected
workflow.transitioned
actor.spawned
tool.started
tool.delta
tool.completed
policy.blocked
user.intervened
run.cancelled
```

A rich event log enables:

- Replay.
- Failure analysis.
- State reconstruction.
- Cost and latency analysis.
- Agent decision audit.
- User trust.
- Regression scenario generation.

### 4.5 The LLM is not the whole brain; it is one actor or policy component

In ABG, the LLM is not the entire runtime. It is a powerful component within the runtime.

An LLM may act as:

- Planner.
- Policy evaluator.
- Summarizer.
- Critic.
- Tool argument generator.
- Response generator.
- Classifier.
- Memory query generator.

This distinction matters. If orchestration is delegated entirely to the LLM, the system becomes harder to debug, harder to replay, harder to constrain, and harder to operate.

ABG allows LLM autonomy, but wraps it in explicit graph structure, policy gates, event logs, and runtime control.

---

## 5. Core Concepts

### 5.1 Graph

The top-level structure is the Graph.

```text
Graph = Nodes + Edges + Event Streams + Runtime Context + Policies
```

A Graph may represent:

- One agent workflow.
- One mission type.
- One automation rule.
- One composite task.
- One reusable behavior template.

Examples:

```text
coding-agent-review-graph
research-and-answer-graph
bug-fix-graph
release-checklist-graph
customer-support-agent-graph
```

### 5.2 Node

A Node is the basic unit of behavior. A Node does not merely return a value. It emits a stream of Signals.

Conceptually:

```text
Node.run(Context, InputStream) -> AsyncStream<Signal>
```

In TypeScript-like notation:

```ts
interface BehaviorNode {
  id: string;
  kind: NodeKind;
  run(ctx: RuntimeContext, input: AsyncIterable<Event>): AsyncIterable<Signal>;
}
```

A Node may be one of many types:

- Condition Node.
- Action Node.
- Selector Node.
- Sequence Node.
- Parallel Node.
- Race Node.
- Join Node.
- Watch Node.
- Policy Node.
- Statechart Node.
- Actor Node.
- Memory Node.
- Tool Node.
- LLM Node.
- Human Approval Node.

### 5.3 Edge

An Edge connects nodes. It may represent control flow, data flow, event routing, guards, priorities, or mapping.

```text
Edge = source + target + condition + mapping + priority
```

Examples:

```text
on success -> next
on failure -> fallback
on event(user.cancel) -> cancel
on progress -> observer
on confidence.low -> ask-user
on timeout -> recover
```

ABG edges are richer than ordinary graph edges because they may carry runtime semantics.

### 5.4 Event

An Event is a fact that happened, either inside or outside the runtime.

```ts
type Event = {
  id: string;
  type: string;
  source: string;
  timestamp: number;
  payload?: unknown;
  causationId?: string;
  correlationId?: string;
};
```

Examples:

```text
user.message.received
tool.stdout.delta
tool.completed
workflow.state.entered
model.token.delta
policy.budget.exceeded
file.changed
timer.timeout
```

Events should generally be immutable. They represent observed facts.

### 5.5 Signal

A Signal is emitted by a Node to the Runtime. If an Event is a recorded fact, a Signal is a meaningful execution emission from a node.

```ts
type Signal =
  | { type: "started"; nodeId: string }
  | { type: "progress"; nodeId: string; data?: unknown }
  | { type: "emit"; nodeId: string; event: Event }
  | { type: "select"; nodeId: string; target: string }
  | { type: "transition"; nodeId: string; from: string; to: string }
  | { type: "spawn"; nodeId: string; actor: string; input?: unknown }
  | { type: "cancel"; nodeId: string; target: string }
  | { type: "success"; nodeId: string; result?: unknown }
  | { type: "failure"; nodeId: string; error: unknown }
  | { type: "cancelled"; nodeId: string };
```

Behavior Tree statuses map into ABG Signals:

```text
RUNNING -> started + progress stream
SUCCESS -> success signal
FAILURE -> failure signal
```

### 5.6 Context

Context is the shared execution environment. It should not become an uncontrolled global mutable object.

ABG context can be divided into layers:

```text
Run Context      : unique data for the current run
Mission Context  : goal, constraints, user request
Memory Context   : short-term and long-term memory
Tool Context     : available tools and permissions
Policy Context   : cost, time, safety, approval rules
Observation Log  : summarized events observed so far
```

Important principle:

> Nodes should not mutate shared context arbitrarily. They should emit Events or Signals, and the Runtime should record and apply state changes.

### 5.7 Blackboard / Working Memory

LLM agents need temporary structured working memory.

Examples:

- Original user request.
- Derived subgoals.
- Retrieved documents.
- Open files.
- Test results.
- Unverified hypotheses.
- Final-answer requirements.
- Pending questions.

ABG can model this as a Blackboard:

```text
Blackboard
├─ goals
├─ assumptions
├─ observations
├─ artifacts
├─ hypotheses
├─ decisions
├─ constraints
└─ pending questions
```

The Blackboard is not the same as the LLM context window. The context window is a prompt-level representation. The Blackboard is runtime-managed structured working memory.

### 5.8 Policy

A Policy defines what the agent may or may not do.

```text
Policy
├─ tool permission
├─ cost budget
├─ time budget
├─ retry limit
├─ confidence threshold
├─ human approval requirement
├─ data access boundary
└─ final answer quality gate
```

In ABG, policy is not only configuration. It can actively participate in graph execution.

Example:

```text
LLM proposes a file deletion tool call
  -> Policy check
  -> human approval required
  -> transition to Human Approval Node
```

---

## 6. Layered Architecture

An ABG-based LLM agent can be understood as a set of layers:

```text
┌─────────────────────────────────────────────┐
│ Operator Interface                           │
│ TUI / Desktop / Logs / Timeline / Inspector  │
├─────────────────────────────────────────────┤
│ Mission Layer                                │
│ Goal, Constraints, User Intent, Run Control  │
├─────────────────────────────────────────────┤
│ Decision Layer                               │
│ Selector, Priority, Guard, Policy            │
├─────────────────────────────────────────────┤
│ Workflow Layer                               │
│ Statechart, DAG, Sequence, Recovery          │
├─────────────────────────────────────────────┤
│ Actor Execution Layer                        │
│ LLM, Tool, File, Shell, Web, Memory Actors    │
├─────────────────────────────────────────────┤
│ Stream/Event Layer                           │
│ Event Bus, Signal Stream, Backpressure        │
├─────────────────────────────────────────────┤
│ Persistence Layer                            │
│ Event Log, Snapshots, Artifacts, Metrics      │
└─────────────────────────────────────────────┘
```

### 6.1 Operator Interface

The TUI and Desktop application of `mission-control` are not just UI surfaces. They are operational interfaces.

An operator should be able to see:

- Which mission is running.
- Which nodes are active.
- Which actors are alive.
- What events have arrived.
- Why a path changed.
- Where cost was spent.
- Where human approval is required.
- Where a failed run can be resumed.

### 6.2 Mission Layer

A Mission is more than a prompt. It is a structured goal with constraints, resources, graph selection, and run state.

```text
Mission = goal + constraints + resources + graph + run state
```

Example user request:

```text
Fix the payment error in this repository and make the tests pass.
```

This can be transformed into:

```text
Goal: fix payment error
Constraints: preserve existing API compatibility, avoid destructive commands
Resources: repository files, shell, test runner, optional web search
Graph: bug-fix-agent-graph
Run State: active
```

### 6.3 Decision Layer

The Decision Layer selects the next behavior based on current events and context.

Example:

```text
Selector: next-action
├─ if user_cancelled -> cancel-current-run
├─ if policy_requires_approval -> ask-approval
├─ if insufficient_context -> gather-context
├─ if failing_tests_exist -> fix-code
├─ if patch_ready -> run-tests
├─ if answer_ready -> respond
└─ otherwise -> reflect-and-plan
```

This layer absorbs the strongest ideas from Behavior Trees.

### 6.4 Workflow Layer

The Workflow Layer ensures selected behaviors proceed safely and coherently.

Example:

```text
Code Fix Workflow
inspect -> plan_patch -> edit -> test -> review -> respond
                     \-> failure -> rollback_or_retry
```

This layer includes:

- State transitions.
- Retry.
- Timeout.
- Compensation.
- Resume.
- Branch.
- Join.
- Checkpoint.

### 6.5 Actor Execution Layer

Actors do the actual work.

Examples:

```text
LLMActor
ToolActor
ShellActor
FileActor
SearchActor
MemoryActor
TestActor
ApprovalActor
```

Actors have these properties:

- They have their own mailbox.
- They process messages sequentially.
- They emit results as events.
- They can be cancelled.
- They can be restarted.
- They can be supervised.

### 6.6 Stream/Event Layer

All meaningful outputs flow as Events or Signals.

```text
user.input
model.delta
tool.delta
tool.result
actor.failed
workflow.transition
policy.blocked
human.approved
```

This layer handles:

- Event delivery.
- Subscription management.
- Event routing.
- Backpressure.
- Correlation IDs.
- Causality tracking.
- Event log persistence.

### 6.7 Persistence Layer

LLM agent runs should leave durable traces.

Persisted data may include:

- Event logs.
- Run snapshots.
- Graph versions.
- Input and output artifacts.
- Tool call records.
- Model call metadata.
- Cost metrics.
- User approvals.
- Final results.

With this layer, `mission-control` becomes a control plane rather than a one-off execution wrapper.

---

## 7. Execution Semantics

### 7.1 ABG is event-driven, not tick-driven

Classic Behavior Trees are often tick-based:

```text
Evaluate from the root on every tick.
```

ABG is primarily event-driven:

```text
When a new event arrives, relevant nodes react.
```

This is more natural for LLM agents because important changes are caused by events:

- User sends a new message.
- A tool emits a partial result.
- A timeout occurs.
- Tests fail.
- A model stream emits a marker.
- Cost budget is reached.
- An approval is granted.

### 7.2 Node execution is an async stream

Node execution follows this shape:

```text
start node
  -> emit started
  -> emit zero or more progress events
  -> emit success | failure | cancelled
```

The result of a Node is not `Promise<Result>`. It is `AsyncIterable<Signal>`.

```ts
async function* runNode(ctx): AsyncIterable<Signal> {
  yield { type: "started", nodeId: "search" };
  yield { type: "progress", nodeId: "search", data: "query generated" };
  yield { type: "progress", nodeId: "search", data: "3 documents found" };
  yield { type: "success", nodeId: "search", result: documents };
}
```

This design naturally supports:

- Streaming UI.
- Mid-run cancellation.
- Dynamic decision changes.
- Progress updates.
- Live debugging.
- Event replay.
- Partial-result reuse.

### 7.3 The Runtime interprets Signals

Nodes should not directly mutate the whole world. Nodes emit Signals, and the Runtime interprets them.

```text
Node -> Signal -> Runtime -> Event Log / State Update / Next Action
```

Example:

```text
Signal: spawn actor(search-worker)
Runtime:
  - create actor
  - record event
  - connect actor mailbox
  - track lifecycle
```

This separation is essential for debugging, replay, and safety.

### 7.4 Causality must be tracked

Every meaningful event should carry causality metadata.

```text
user.message.received #1
  -> decision.selected #2, causationId=#1
  -> tool.started #3, causationId=#2
  -> tool.completed #4, causationId=#3
```

With causality tracking, `mission-control` can answer:

```text
Why did this happen?
Which user request caused this tool call?
Which decision caused this actor to spawn?
```

### 7.5 Deterministic shell, non-deterministic edge

The Runtime core should be as deterministic as possible:

- Event interpretation.
- State transitions.
- Policy checks.
- Graph traversal.
- Retry counts.
- Timeout rules.

External observations may be non-deterministic:

- LLM output.
- External API responses.
- File system state.
- Network behavior.
- User intervention.

ABG records non-deterministic results as Events. During replay, the runtime can reconstruct state from the recorded event log.

```text
Runtime decisions: deterministic
External observations: recorded
Replay: event-log driven
```

---

## 8. Core Node Types

### 8.1 Condition Node

Evaluates a condition.

```text
has_context?
is_user_waiting?
is_confidence_low?
are_tests_failing?
```

A Condition Node usually emits `success` or `failure` immediately.

### 8.2 Action Node

Performs real work.

```text
read_file
search_web
call_llm
run_test
edit_file
summarize
ask_user
```

Most Action Nodes emit asynchronous streams.

### 8.3 Selector Node

Chooses one behavior among several candidates.

```text
Selector: choose-next-action
├─ ask-user-if-blocked
├─ gather-context-if-needed
├─ execute-tool-if-planned
├─ repair-if-failed
└─ respond-if-ready
```

Selector strategies may include:

- Priority selector.
- First-success selector.
- Score-based selector.
- Policy-filtered selector.
- LLM-assisted selector.
- Cost-aware selector.

### 8.4 Sequence Node

Runs steps in order.

```text
Sequence
├─ analyze request
├─ gather context
├─ generate plan
├─ execute plan
└─ respond
```

A Sequence Node must define how failures are handled:

- Fail fast.
- Skip failed step.
- Compensate and fail.
- Retry and continue.

### 8.5 Parallel Node

Runs multiple tasks concurrently.

```text
Parallel
├─ search local files
├─ search memory
├─ search web
└─ ask lightweight model for query expansion
```

Parallel Nodes need completion rules:

- All succeed.
- Any succeed.
- Quorum.
- First useful result.
- Until enough context.

### 8.6 Race Node

Runs multiple tasks and selects the first valid result.

```text
Race
├─ local cache
├─ remote search
└─ timeout
```

Race Nodes are useful for reducing latency.

### 8.7 Join Node

Combines multiple results or streams.

```text
Join
├─ file search result
├─ web search result
├─ memory result
└─ user-provided context
```

Merge strategies may include:

- Append.
- Rank.
- Deduplicate.
- Summarize.
- Vote.
- Reconcile conflicts.

### 8.8 Watch Node

A Watch Node monitors events and changes the flow when needed.

```text
Watch
├─ on user.cancel -> cancel run
├─ on user.corrects_scope -> redirect workflow
├─ on budget.exceeded -> stop or ask approval
├─ on tool.failed -> recover
└─ on enough_context -> cancel remaining searches
```

Watch Nodes are crucial for LLM agents because user intervention and external events often change the correct course of action.

### 8.9 Policy Node

A Policy Node decides whether an action is allowed.

```text
Can this tool be used?
Is human approval required?
Is cost budget exceeded?
Is the action destructive?
Is confidence high enough to answer?
```

Policy Nodes are the safety boundaries of ABG.

### 8.10 Statechart Node

Encapsulates a complex long-running procedure.

```text
Statechart: code-edit-flow
states:
  inspect
  patch
  test
  review
  finalize
```

A Statechart Node consumes events and emits transitions.

### 8.11 Actor Node

Creates an actor or sends a message to an actor.

```text
spawn test-runner
send run-tests
receive test-result
```

Actor Nodes are appropriate for long-running tasks, external tools, and subagents.

### 8.12 Human Node

Waits for human input, approval, or selection.

```text
Ask approval before deleting files
Ask user to choose one of multiple strategies
Ask for missing credentials
Ask whether to continue spending tokens
```

A Human Node is also asynchronous. The user's response enters the graph as an Event.

---

## 9. Graph Control Patterns

### 9.1 Observe -> Decide -> Act -> Observe Loop

The basic LLM agent loop is:

```text
Observe
  -> Decide
  -> Act
  -> Observe
  -> Decide
  -> ...
```

ABG makes this loop explicit:

```text
Observation Stream
  -> Context Update
  -> Decision Selector
  -> Action Workflow
  -> Event Stream
```

This is related to ReAct-style agents, but ABG centers the loop around events and graph execution rather than free-form chain-of-thought text.

### 9.2 Plan -> Execute -> Monitor -> Replan

Complex tasks separate planning and execution:

```text
Plan
  -> Execute step
  -> Monitor result
  -> Replan if needed
  -> Continue
```

In ABG, a plan is not a fixed script. It is a modifiable artifact.

```text
Plan Artifact
├─ steps
├─ dependencies
├─ assumptions
├─ risks
├─ required tools
└─ validation rules
```

### 9.3 Speculative Parallelism

The agent may try several useful paths in parallel and select the best result.

```text
Parallel
├─ local repo search
├─ symbol search
├─ error message web search
└─ ask model for likely cause
```

A Join/Rank Node can then select the most useful evidence.

### 9.4 Early Stop

In streaming systems, it is often unnecessary to wait for every task to complete.

```text
enough_context_detected
  -> cancel remaining searches
  -> proceed to answer
```

This reduces latency and cost.

### 9.5 Human-in-the-loop

ABG treats humans as part of the graph, not as outside interruptions.

```text
Need approval
  -> Human Node
  -> wait for user event
  -> continue / abort / modify plan
```

Human intervention is a mission event.

### 9.6 Supervisor Pattern

Actors can fail. Therefore, they need supervision.

```text
Supervisor
├─ restart actor
├─ retry with backoff
├─ escalate to human
├─ switch fallback actor
└─ fail mission
```

Supervision makes the runtime resilient.

---

## 10. LLM-Agent-Specific Design

### 10.1 An LLM call is closer to an Actor than a plain function

An LLM call may look like a function call, but it has many runtime behaviors:

- Token streaming.
- Tool call proposals.
- Cost.
- Latency.
- Non-deterministic output.
- Context window limits.
- Message hierarchy.
- Safety and policy validation.

Therefore, ABG should often treat LLM execution as `LLMActor` behavior.

### 10.2 Decompose LLM roles

Instead of allowing one giant model call to do everything, split roles:

```text
IntentClassifier
Planner
ToolArgumentGenerator
Critic
Summarizer
Responder
PolicyExplainer
```

Each role can become a Node or Actor.

Benefits:

- Cost optimization.
- Model selection optimization.
- Better failure localization.
- Easier verification.
- Better streaming UI.

### 10.3 A tool call is a proposed action, not automatic execution

If an LLM proposes a tool call, the runtime should not blindly execute it. It should first become an Event.

```text
llm.tool_call.proposed
  -> policy check
  -> permission check
  -> argument validation
  -> execute tool actor
```

This improves safety and observability.

### 10.4 Separate context window from runtime memory

Putting everything into the LLM context window is expensive and can reduce quality. ABG separates runtime memory from prompt context.

```text
Runtime Memory
├─ event log
├─ summaries
├─ artifacts
├─ retrieved docs
├─ tool results
└─ decisions
```

A Context Packer selects only relevant material for each model call:

```text
Context Packer
  -> select relevant memory
  -> compress observations
  -> include active plan
  -> include constraints
  -> build prompt
```

### 10.5 The final response is also a stream

A final answer is not only a string. It can be modeled as an output stream:

```text
response.started
response.delta
response.citation.added
response.artifact.created
response.completed
```

This lets `mission-control` display response progress in both TUI and Desktop interfaces.

### 10.6 Critic and Quality Gate

LLM agents need review and validation.

```text
Draft Answer
  -> Critic Node
  -> Quality Gate
  -> revise or finalize
```

A Quality Gate may check:

- Whether the user request was actually satisfied.
- Whether the answer has enough evidence.
- Whether uncertainty is disclosed.
- Whether dangerous tools were used.
- Whether assumptions were presented as facts.
- Whether cost was reasonable.
- Whether validation steps were completed.

---

## 11. Mission-Control Concepts

`mission-control` may directly implement an ABG runtime, or it may operate as a control plane over several agent runtimes. In either case, its identity is:

```text
mission-control = ABG-based LLM agent operations console
```

### 11.1 Mission

A Mission is the user's productive intent turned into an executable structure.

Examples:

```text
Fix failing payment test
Generate release note
Research card benefits
Refactor auth module
Create design proposal
```

A Mission includes:

- Goal.
- Constraints.
- Graph.
- Run history.
- Artifacts.
- Approvals.
- Metrics.

### 11.2 Run

A Run is one execution instance of a Mission.

```text
Mission: fix payment bug
Run #1: failed due to missing environment variable
Run #2: succeeded after user provided environment variable
```

Each Run has its own event log and snapshots.

### 11.3 Timeline

A Timeline is the human-readable projection of the event log.

```text
10:00 user.message.received
10:01 decision.selected: gather-context
10:01 tool.started: file-search
10:02 tool.completed: file-search
10:02 decision.selected: edit-file
10:03 policy.blocked: destructive action requires approval
10:04 user.approved
10:05 tool.completed: edit-file
10:06 test.failed
10:07 decision.selected: repair
```

The Timeline should be a central UI concept in both the TUI and Desktop app.

### 11.4 Graph Inspector

The Graph Inspector displays graph structure and current execution state.

```text
[active] gather-context
[pending] plan
[running] search-files
[blocked] ask-approval
[completed] classify-intent
[failed] run-tests
```

### 11.5 Actor Inspector

The Actor Inspector shows active actors.

```text
LLMActor: streaming
ShellActor: running tests
FileActor: idle
MemoryActor: retrieving
UserActor: waiting approval
```

### 11.6 Policy Inspector

The Policy Inspector explains why an action was allowed, blocked, or escalated.

```text
Action: delete file
Policy: destructive action
Decision: human approval required
Status: waiting
```

### 11.7 Replay

Replay is not just log playback. It reconstructs run state from the event log.

```text
Event Log -> Reconstructed Run State -> Timeline / Graph State
```

Replay enables:

- Failure analysis.
- Retry from a specific point.
- Dry-run under different policies.
- Regression scenario generation.

---

## 12. State, Memory, and Log

ABG distinguishes three concepts:

```text
State  : current execution state
Memory : knowledge the agent can use
Log    : immutable record of what happened
```

### 12.1 State

State is a snapshot of the current run:

```text
current node
active actors
pending approvals
retry counts
open streams
workflow state
```

### 12.2 Memory

Memory is knowledge used to perform work:

```text
user preferences
project facts
retrieved documents
summaries
previous decisions
```

### 12.3 Log

Log is the immutable execution history:

```text
event #1 happened
event #2 happened because of #1
event #3 happened because of #2
```

### 12.4 Principle

```text
State should be reconstructable from the Log.
Memory should be selectively injected through a Context Packer.
The Log should be readable by humans and replayable by machines.
```

---

## 13. Cancellation, Timeout, Retry, and Compensation

In asynchronous workflows, failure paths are often more important than happy paths.

### 13.1 Cancellation

Cancellation is not an exception. It is normal control flow.

```text
user.cancel
policy.cancel
race.loser.cancel
timeout.cancel
superseded.cancel
```

All long-running Nodes and Actors should be cancellable.

### 13.2 Timeout

Timeouts may exist at several levels:

```text
Tool timeout: 30s
LLM timeout: 120s
Workflow timeout: 10m
Mission timeout: user-defined
```

A timeout is not always a final failure. It may lead to:

```text
timeout
  -> retry
  -> fallback model
  -> ask user
  -> partial answer
  -> fail mission
```

### 13.3 Retry

Retry should not mean blindly repeating the same action.

```text
network error -> retry with backoff
validation error -> do not retry without modification
rate limit -> wait or switch provider
test failure -> replan, not simple retry
```

### 13.4 Compensation

Some actions must be reversible or compensatable.

Example:

```text
file edited
  -> tests failed badly
  -> rollback patch
```

For side-effecting actions, ABG should define compensation when possible:

```text
Action: edit-file
Compensation: restore previous content
```

---

## 14. Backpressure and Resource Management

Streaming systems can produce too many events.

Examples:

- LLM token stream.
- Shell stdout.
- File change events.
- Log tailing.
- Multiple parallel searches.

ABG needs backpressure strategies.

### 14.1 Backpressure strategies

```text
buffer
sample
throttle
debounce
summarize
drop low-priority events
pause producer
cancel producer
```

### 14.2 LLM token stream handling

Saving every raw token forever can be expensive and noisy. Token streams should be layered:

```text
raw token stream       : UI display, optional storage
semantic delta stream  : sentence or block level
final message artifact : final persisted output
summary event          : replay/search projection
```

### 14.3 Priority

Not all streams have equal importance.

```text
High: policy violation, user cancel, tool failure
Medium: workflow transition, tool complete
Low: token delta, verbose stdout
```

The Runtime should prioritize important events.

---

## 15. Policy and Safety

ABG increases agent autonomy, so it must also define boundaries.

### 15.1 Capability-based permissions

Nodes and Actors should only use capabilities they have been granted.

```text
FileReadCapability
FileWriteCapability
ShellCapability
NetworkCapability
BrowserCapability
MemoryWriteCapability
UserMessageCapability
```

Capabilities may be constrained per Graph, Mission, Run, Node, or Actor.

### 15.2 Destructive Action Gate

The following actions should normally pass through explicit gates:

- File deletion.
- Large-scale file modification.
- Database changes.
- Deployment.
- Payment or email sending.
- Irreversible API calls.

```text
Action proposed
  -> destructive?
  -> require approval
  -> execute only after approval event
```

### 15.3 Confidence-based control

The system should prevent low-confidence actions from proceeding silently.

```text
if confidence < threshold:
  ask user
  gather more context
  run verification
  produce uncertain answer
```

Confidence should not rely only on LLM self-assessment. It should consider:

- Amount and quality of evidence.
- Tool verification.
- Test results.
- Source conflicts.
- Policy risk.
- Task criticality.

### 15.4 Cost budget

Model calls, search, build, and test execution all have costs. ABG should record costs as events and enforce budgets through policy.

```text
model.call.started
model.call.completed { inputTokens, outputTokens, costEstimate }
budget.remaining.updated
budget.exceeded
```

---

## 16. Observability

The core value of `mission-control` is observability.

### 16.1 What must be observable

```text
Graph state
Node lifecycle
Actor lifecycle
Event timeline
Tool calls
Model calls
Policy decisions
Context changes
Memory reads/writes
Artifacts
Costs
Latency
Errors
User interventions
```

### 16.2 Explainable execution

The operator should be able to ask:

- Why was this tool called?
- Why was this model used?
- Why did the runtime ask for approval?
- Why was the previous task cancelled?
- Why was the answer considered sufficient?
- What evidence supported the conclusion?

Decision events should include reasons:

```text
decision.selected
  target: run-tests
  reason: patch was applied and validation policy requires tests
  alternatives: respond, inspect-more
  rejected: respond because validation incomplete
```

### 16.3 Timeline first

In practice, the Timeline may be more important than the graph drawing. Operators often need to know what happened, in what order, and why.

Recommended perspective:

```text
Timeline = primary debugging surface
Graph = structural map
Inspector = detail panel
```

---

## 17. ABG vs Ordinary DAG

A DAG is useful for dependency execution:

```text
A and B -> C -> D
```

LLM agents are more dynamic:

```text
If A is insufficient, run B.
If the user changes the goal, redirect.
If C fails, generate a new plan.
If D becomes unnecessary, stop early.
```

| Dimension | DAG | Async Behavior Graph |
|---|---|---|
| Structure | Mostly static | Dynamically adjustable |
| Execution | Dependency completion | Event reaction |
| Mid-run intervention | Weak | Core concept |
| Streaming | Usually result-oriented | Stream-oriented |
| Decision making | Limited | Central |
| LLM agent fit | Good for some subtasks | Suitable as a full operational model |

---

## 18. ABG vs Behavior Tree

| Dimension | Behavior Tree | Async Behavior Graph |
|---|---|---|
| Basic shape | Tree | Graph |
| Execution style | Tick-based | Event/stream-based |
| Node return | SUCCESS / FAILURE / RUNNING | Signal stream |
| Async behavior | Represented through RUNNING | Native semantic layer |
| Partial result | Limited | First-class concept |
| User intervention | Usually external | Integrated as Event |
| Long workflow | Awkward | Modeled through Statecharts |
| Parallel execution | Parallel node | Actor / Parallel / Race / Join |
| Observability | Must be designed separately | Event-log-centered |
| LLM tool call | Requires extension | Native Actor/Tool model |

A Behavior Tree can be used inside ABG as a decision DSL:

```text
Behavior Tree ⊂ Async Behavior Graph
```

---

## 19. Formal Model

ABG can be written formally as:

```text
ABG = (N, E, S, C, P, R)
```

Where:

```text
N: set of Nodes
E: set of Edges
S: set of Streams
C: Context / Blackboard
P: set of Policies
R: Runtime semantics
```

Each Node can be modeled as:

```text
nᵢ: (C, S_in, P) -> S_out
```

A Node receives Context, input Streams, and Policies, then produces output Streams.

The Runtime interprets Signals and produces new Events, state updates, actor changes, or node activations.

```text
R: (GraphState, Signal) -> GraphState'
```

Execution proceeds as a loop:

```text
1. Receive an Event.
2. Record it in the Event Log.
3. Activate relevant Nodes.
4. Nodes emit Signal streams.
5. Runtime interprets Signals.
6. Runtime updates State and starts/cancels Actors or Nodes as needed.
7. If new Events occur, repeat.
```

---

## 20. Minimal Runtime Semantics

An ABG runtime should provide at least these semantics.

### 20.1 Node lifecycle

```text
idle
  -> starting
  -> running
  -> succeeded | failed | cancelled
```

### 20.2 Actor lifecycle

```text
created
  -> starting
  -> running
  -> stopping
  -> stopped | failed | restarted
```

### 20.3 Workflow lifecycle

```text
created
  -> active
  -> blocked
  -> completed | failed | cancelled
```

### 20.4 Mission lifecycle

```text
draft
  -> ready
  -> running
  -> waiting_for_user
  -> completed | failed | cancelled | archived
```

### 20.5 Event delivery

Event delivery should support at minimum:

- Ordered delivery per source.
- Global timestamps.
- Correlation IDs.
- Replay.
- Duplicate handling strategy.

### 20.6 Idempotency

For replay and retry, Nodes should be idempotent when possible.

Side-effecting Nodes require idempotency keys or compensation.

---

## 21. LLM Agent Workflow Examples

### 21.1 Research Agent Graph

```text
Mission: answer the user's question with grounded evidence

Observe user request
  -> classify intent
  -> decide if fresh information is required
  -> gather context
      ├─ memory search
      ├─ file search
      └─ web search
  -> join evidence
  -> draft answer
  -> critic check
  -> final response stream
```

Important events:

```text
user.message.received
intent.classified
context.search.started
context.item.found
evidence.joined
answer.drafted
critic.failed
answer.revised
response.completed
```

### 21.2 Coding Agent Graph

```text
Mission: fix a code issue and validate the result

User request
  -> inspect repo
  -> identify relevant files
  -> generate patch plan
  -> request approval if destructive
  -> edit files
  -> run tests
  -> if tests fail: inspect failure and repair
  -> summarize changes
```

Important Watch behavior:

```text
Watch
├─ on user.scope.changed -> cancel current search and redirect
├─ on test.failed -> replan
├─ on command.timeout -> retry or ask user
└─ on policy.blocked -> wait approval
```

### 21.3 Multi-Agent Graph

```text
Mission
  -> PlannerAgent
  -> parallel:
      ├─ ResearchAgent
      ├─ CodeAgent
      ├─ TestAgent
      └─ ReviewAgent
  -> CoordinatorAgent joins results
  -> Final Responder
```

Each Agent is an Actor. The Coordinator is a combination of Decision Node and Join Node.

---

## 22. How to Think About Graph Authoring

An ABG graph is not merely a visualization over hidden code. It is an executable expression of operational intent.

A good ABG has these qualities:

1. **Behavior selection is explicit.**  
   The graph shows why the next behavior is selected.

2. **Failure paths exist.**  
   The graph does not only describe the happy path.

3. **Human intervention points are clear.**  
   Approval and user-choice points are visible.

4. **Tool use is inspectable.**  
   Tool calls are tied to reasons, policies, and events.

5. **Partial results are useful.**  
   The graph can continue once enough information is available.

6. **Policy is visible.**  
   Cost, permissions, risk, and confidence affect execution.

7. **Runs are resumable.**  
   A failed run can resume from an appropriate checkpoint.

---

## 23. Design Principles

### 23.1 Explicit over implicit

Important agent decisions should not be hidden inside prompts.

Bad:

```text
Tell the LLM to figure everything out by itself.
```

Better:

```text
Represent candidate actions, policy gates, approvals, and validation paths in the graph.
```

### 23.2 Stream first

All long-running work should be modeled as a stream.

```text
Prefer AsyncIterable<Signal> over Promise<Result>.
```

### 23.3 Human-visible runtime

Agents should be observable.

```text
black-box agent -> glass-box agent
```

### 23.4 Bounded autonomy

Agents should be autonomous within clear boundaries.

```text
autonomy + policy + approval + audit
```

### 23.5 Recovery is first-class

Failure handling is not an afterthought. It is part of the graph.

### 23.6 Model-agnostic

ABG should not depend on a specific model. A model is just one Actor or Node implementation.

### 23.7 Tool-agnostic

Shell, web, file, database, browser, MCP, and external APIs can all be represented as Tool Actors.

### 23.8 Replayable by design

A run should be designed for replay. Non-replayable execution is difficult to debug and hard to trust.

---

## 24. Thinking Tools Provided by Mission-Control

This is not an implementation specification, but it is important to define what kinds of thinking tools `mission-control` should provide.

### 24.1 Graph as map

The Graph is the map of paths the agent may take.

### 24.2 Timeline as truth

The Timeline is the record of what actually happened.

### 24.3 Policy as boundary

Policy defines the boundary of autonomy.

### 24.4 Memory as working surface

Memory is not merely a prompt. It is the working surface managed by the runtime.

### 24.5 Actor as unit of responsibility

Actors define responsibility, isolation, and failure boundaries.

### 24.6 Mission as productive intent

A Mission turns the user's productive intent into an executable structure.

---

## 25. Glossary

| Term | Meaning |
|---|---|
| ABG | Async Behavior Graph |
| Mission | A goal and constraint bundle the user wants to accomplish |
| Run | One execution instance of a Mission |
| Node | A graph unit representing behavior, condition, policy, workflow, actor, or tool |
| Edge | Control, data, or event routing between Nodes |
| Event | A fact that happened |
| Signal | Execution meaning emitted by a Node to the Runtime |
| Actor | An isolated execution entity with a mailbox and lifecycle |
| Policy | Rules that constrain and authorize execution |
| Blackboard | Structured working memory |
| Timeline | Human-friendly projection of the Event Log |
| Replay | Reconstructing execution from the Event Log |
| Watch Node | A Node that observes specific events and redirects execution |
| Join Node | A Node that combines multiple results or streams |
| Race Node | A Node that selects the first valid result among competing tasks |
| Capability | A permission boundary for tools and side effects |
| Context Packer | A component that selects runtime memory for an LLM call |

---

## 26. Conclusion

Async Behavior Graph does not treat LLM agent workflows as simple prompt chains or tool-call loops. It treats an agent as a running system:

```text
An agent observes events,
selects behavior based on context,
executes asynchronous work,
receives partial results as streams,
stays inside policy and user-defined boundaries,
and records the entire process as an event log.
```

`mission-control` is the control plane for this system. The TUI command `mctrl` is suitable for fast operation and real-time observation. The Desktop application is suitable for timeline inspection, graph/session projections, approval review, and deeper analysis. Their essence is the same:

```text
Do not merely run an LLM agent.
Operate the behavior graph of an LLM agent.
```

The core claim of ABG is:

> The reliability of an LLM agent does not come only from a stronger model. It comes from observable execution structure, explicit policy, replayable event logs, and behavior graphs that humans can inspect and intervene in.

Therefore, the theoretical foundation of `mission-control` can be summarized as:

> mission-control organizes LLM agent reasoning, behavior selection, tool execution, streaming output, failure recovery, and user intervention into one observable mission runtime through Async Behavior Graphs.

---

## Appendix A. ABG as a One-line DSL

```text
observe events -> update context -> select behavior -> run workflow -> spawn actors -> stream signals -> apply policy -> persist log -> repeat
```

---

## Appendix B. Minimal Runtime Contract

An ABG runtime should satisfy at least the following contract:

```text
1. A Node emits a Signal stream.
2. The Runtime records important Signals in the Event Log.
3. The Runtime updates Graph State in response to Events.
4. Actors run through message passing and must be cancellable.
5. Workflows must define state transitions and failure paths.
6. Policy must be able to intervene before tool execution.
7. Human intervention must be modeled as Events.
8. Execution state must be snapshot-able.
9. Timeline and Replay must be constructible from the Event Log.
10. The LLM must be treated as one Node or Actor, not as the entire Runtime.
```

---

## Appendix C. Core Metaphors

```text
A Behavior Tree is a decision tree for behavior.
A Statechart is a map for long-running procedures.
The Actor Model is an organization chart of independent executors.
A Reactive Stream is the nervous system of the runtime.
An Event Log is the ledger of memory and audit.
A Policy is the fence around autonomy.
An Async Behavior Graph is the mission runtime that binds them together.
```

---

## Appendix D. Mission Control Implementation Status

The current `mission-control` implementation is a bounded ABG coding-agent MVP, not the full theoretical engine described above.

Implemented runtime surfaces:

- Durable JSONL session event storage under `MCTRL_DATA_DIR` or the platform application-data directory.
- Replay projections for chat, graph snapshots, transcript branches, approval state, file diffs, and command output.
- Deterministic local provider execution, OpenAI Responses, Anthropic Messages, Google Gemini, and OpenAI-compatible adapters for OpenRouter, Groq, DeepSeek, and Mistral behind stored credentials.
- Provider capability docs distinguish executable adapters from catalog/auth/model-discovery entries; a provider needs executable adapter proof before it can be documented as runnable.
- Provider-neutral streaming events, typed provider errors, and redaction metadata that avoids raw credential storage.
- Approval lifecycle events: `approval.requested`, `approval.updated`, `approval.resumed`, and `approval.blocked`.
- Permission-gated safe tools: `repo.read`, `repo.list`, `repo.search`, `file.patch`, and `command.run`.
- Reference repositories under `temp/ref-repos` are planning evidence only; runtime repo tools deny those paths by default.
- Runtime prompts and tool instructions must not load AGENTS.md or other instructions from reference repos.
- Bounded graph coordination with default graph node concurrency 2, provider parallel tool calls 4, shell/process concurrency 1, retry caps, and loop limits.
- CLI JSONL and interactive coding-agent flows.
- Desktop event inspection and timeline/graph/session projections are wired in the Tauri shell.
- Core desktop command services handle prompt, queue follow-up, steer, interrupt, resume, and approval decisions; Tauri write commands call that service through the Rust shell bridge, reuse persisted session provider selections, and return real `eventsWritten` counts.
- Desktop Tauri credential commands save and list API-key credentials through the shared auth file used by the CLI.
- Sidecar protocol v1 uses a Rust handshake with `task.run` capability negotiation and native/mock/unavailable status events.
- Sidecar protocol v2 is feature-flagged and currently limited to `task.cancel`, `task_failed`, and `task_cancelled` wire compatibility.

Still deferred:

- Full production ABG engine semantics, compensation policies, and autonomous long-running schedulers.
- Visual graph editing.
- Vector memory, persistent memory stores, and database indexes beyond JSONL storage.
- Unrestricted tools, automatic rollback, and default sidecar execution for `file.patch` or `command.run`.
- Provider adapters beyond the deterministic local path, OpenAI Responses, Anthropic Messages, Google Gemini, and the OpenAI-compatible provider family.
