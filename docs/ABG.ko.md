# Async Behavior Graph 이론 설계서

**프로젝트:** mission-control / mctrl  
**문서 목적:** LLM 에이전트 워크플로우를 구축·관찰·운용하기 위한 Async Behavior Graph의 이론적 배경, 철학, 실행 의미론 정리  
**범위:** 구현 보일러플레이트, 패키지 구조, TUI/Desktop 기술 스택, 빌드·배포 절차는 제외한다. 이 문서는 `mission-control`이 어떤 실행 모델을 다루는 프로그램이어야 하는지에 대한 사상과 개념적 설계에 집중한다.

---

## 1. 요약

**Async Behavior Graph(ABG)**는 LLM 에이전트의 행동 선택, 장기 실행 워크플로우, 비동기 도구 실행, 스트리밍 관찰, 사용자 개입, 실패 복구를 하나의 실행 모델로 묶기 위한 그래프 기반 행동 오케스트레이션 개념이다.

ABG는 Behavior Tree를 대체하기보다는 확장된 상위 모델로 본다. Behavior Tree가 “현재 상황에서 어떤 행동을 선택할 것인가”에 강하다면, ABG는 여기에 다음 요소를 결합한다.

- **Behavior Tree**: 우선순위, 조건, 선택, fallback 중심의 행동 결정
- **Statechart**: 장기 실행 워크플로우와 명시적인 상태 전이
- **Actor Model**: 독립 실행 단위, 메시지 전달, 격리, 취소, 재시작
- **Reactive Stream / Dataflow**: 비동기 이벤트, 중간 결과, token stream, tool stream 처리
- **Event Sourcing**: 관찰 가능성, replay, 감사 로그, 상태 복원
- **Policy Runtime**: 비용, 시간, 안정성, 권한, 사용자 승인, confidence 기반의 실행 제약

한 문장으로 정의하면 다음과 같다.

> Async Behavior Graph는 이벤트 스트림을 관찰하면서, 상태 기반 워크플로우와 Actor 실행을 조합해 다음 행동을 선택하는 그래프 기반 의사결정·실행 모델이다.

mission-control은 이 ABG를 작성하고, 실행하고, 관찰하고, 재생하고, 조정하기 위한 **LLM 에이전트 운용 콘솔**이 된다.

---

## 2. 왜 새로운 개념이 필요한가

LLM 에이전트 시스템은 일반적인 함수 호출 흐름보다 훨씬 복잡하다.

전통적인 코드에서는 보통 다음과 같은 구조가 많다.

```text
input → function → output
```

하지만 LLM 에이전트는 다음에 가깝다.

```text
user message
  → intent analysis
  → context gathering
  → planning
  → tool execution
  → observe partial result
  → revise plan
  → ask user or continue
  → stream final answer
```

이 과정에는 다음 문제가 동시에 존재한다.

1. **상황에 따른 행동 선택**  
   지금 답변해야 하는가, 더 검색해야 하는가, 파일을 읽어야 하는가, 테스트를 실행해야 하는가, 사용자에게 물어봐야 하는가?

2. **장기 실행 워크플로우**  
   하나의 요청이 여러 단계와 여러 도구 호출로 나뉜다.

3. **비동기성과 병렬성**  
   검색, 파일 읽기, 코드 실행, 모델 호출, 외부 API 호출은 동시에 진행될 수 있다.

4. **스트리밍 결과**  
   LLM token, tool stdout, 로그, 검색 결과, 테스트 결과는 완료 시점에 한 번에 도착하지 않고 점진적으로 흘러온다.

5. **중간 개입**  
   사용자가 “그게 아니라 API 쪽 파일이야”라고 말하면 진행 중이던 작업을 취소하거나 방향을 바꿔야 한다.

6. **실패 복구**  
   tool 실패, timeout, rate limit, 테스트 실패, 모델 응답 품질 저하를 처리해야 한다.

7. **운용 가능성**  
   에이전트가 왜 그런 판단을 했는지, 어떤 이벤트 때문에 경로가 바뀌었는지, 어디서 실패했는지 볼 수 있어야 한다.

Behavior Tree, State Machine, Workflow Engine, Actor Model, Reactive Stream은 각각 이 문제의 일부를 해결한다. 그러나 LLM 에이전트 워크플로우에서는 이 요소들이 동시에 필요하다. ABG는 이들을 하나의 운용 가능한 사고 모델로 통합한다.

---

## 3. 기존 방법론과의 관계

### 3.1 Behavior Tree와의 관계

Behavior Tree는 게임 AI에서 널리 쓰이는 행동 선택 모델이다. 노드는 일반적으로 다음 상태를 반환한다.

```text
SUCCESS | FAILURE | RUNNING
```

Behavior Tree의 강점은 다음과 같다.

- 우선순위 기반 행동 선택
- 조건과 행동의 명확한 분리
- fallback 표현
- 복잡한 if/else보다 읽기 쉬운 의사결정 구조
- 실행 중인 행동을 `RUNNING`으로 표현 가능

하지만 LLM 에이전트 환경에서는 `RUNNING` 하나만으로는 부족하다.

예를 들어 “검색 중”이라는 상태에는 여러 하위 이벤트가 있다.

```text
tool.started
tool.stdout.delta
tool.partial_result
tool.rate_limited
tool.retried
tool.completed
tool.failed
```

Behavior Tree는 이 이벤트 stream을 일급 개념으로 다루지 않는다. 그래서 ABG는 Behavior Tree의 선택 구조를 유지하되, 노드의 반환값을 단순 상태가 아니라 **Signal stream**으로 확장한다.

### 3.2 Statechart와의 관계

Statechart는 상태 전이를 명확하게 표현한다.

```text
idle → planning → executing → observing → responding
```

LLM 에이전트의 장기 실행 워크플로우에는 Statechart가 적합하다. 결제, 코드 수정, 테스트, 리뷰, 배포 같은 프로세스는 단순 tree보다 명시적 상태 전이가 더 잘 맞는다.

ABG에서 Statechart는 하나의 노드 또는 서브그래프로 캡슐화될 수 있다.

```text
Decision Node
  → Workflow Node: code-fix-flow
      states:
        inspect
        patch
        test
        review
        respond
```

즉 ABG는 Statechart를 내부 구성 요소로 포함한다.

### 3.3 Actor Model과의 관계

Actor Model은 독립적인 실행 주체가 메시지를 주고받는 모델이다.

```text
PlannerActor → ToolActor → ObserverActor → MemoryActor
```

LLM 에이전트에서 Actor는 다음을 표현하기 좋다.

- 도구 실행 단위
- 서브에이전트
- 파일 감시자
- 테스트 러너
- 장기 실행 작업
- 외부 이벤트 구독자
- 모델 호출 worker

Actor는 격리, 취소, timeout, 재시작, backpressure를 다루기 좋다. ABG에서 Actor는 실행 레이어의 기본 단위가 된다.

### 3.4 Reactive Stream / Dataflow와의 관계

LLM 에이전트는 streaming 시스템이다. LLM의 token, 도구의 stdout, 파일 변경 이벤트, 사용자 입력, 타이머 이벤트가 모두 stream이다.

ABG는 다음을 일급 개념으로 본다.

```text
Input Event Stream
  → Decision Graph
  → Action Stream
  → Observation Stream
  → Updated Context
```

이 관점에서는 “작업이 끝났는가?”보다 “지금 어떤 이벤트가 흘러오고 있으며, 그 이벤트가 다음 행동 선택에 어떤 영향을 주는가?”가 더 중요하다.

### 3.5 Workflow Engine과의 관계

Temporal, Durable Functions, Airflow류의 Workflow Engine은 내구성, 재시도, 장기 실행, 상태 복원에 강하다. ABG는 이와 유사한 요구를 가진다.

다만 ABG는 일반 업무 프로세스보다 **에이전트적 의사결정**을 더 중심에 둔다.

Workflow Engine이 다음에 가깝다면:

```text
정해진 절차를 안정적으로 실행한다.
```

ABG는 다음에 가깝다.

```text
상황을 관찰하며 다음 절차 자체를 동적으로 선택한다.
```

---

## 4. Async Behavior Graph의 핵심 철학

### 4.1 에이전트는 함수가 아니라 실행 중인 시스템이다

LLM 에이전트는 한 번 호출되고 종료되는 함수가 아니다. 사용자의 요청을 받은 뒤에도 계속 관찰하고, 판단하고, 실행하고, 수정한다.

따라서 에이전트는 다음처럼 모델링해야 한다.

```text
Agent = policy + memory + tools + workflow + event loop
```

ABG는 에이전트를 “함수 호출 체인”이 아니라 **상태와 이벤트를 가진 실행 시스템**으로 본다.

### 4.2 행동은 결과가 아니라 과정이다

전통적인 함수 호출은 결과 중심이다.

```text
result = await runTask(input)
```

ABG는 과정을 중심으로 본다.

```text
for await (signal of runTask(input)) {
  observe(signal)
  decide(signal)
  maybeIntervene(signal)
}
```

행동은 `success` 또는 `failure` 하나로 끝나지 않는다. 행동은 시작, 진행, 중간 관찰, 부분 성공, 재시도, 취소, 실패, 복구를 포함하는 stream이다.

### 4.3 판단과 실행을 분리한다

LLM 에이전트에서 가장 흔한 실패는 “판단 로직”과 “실행 로직”이 섞이는 것이다.

예를 들어 하나의 함수 안에 다음이 모두 들어간다.

- 지금 무엇을 해야 하는지 판단
- tool 호출
- timeout 처리
- retry 처리
- 사용자에게 보여줄 메시지 작성
- 내부 상태 업데이트

ABG는 이를 분리한다.

```text
Decision Layer: 무엇을 할지 고른다.
Workflow Layer: 어떤 절차로 진행할지 관리한다.
Actor Layer: 실제 작업을 실행한다.
Stream Layer: 모든 결과와 이벤트를 흘려보낸다.
Policy Layer: 허용 범위와 우선순위를 제한한다.
```

### 4.4 모든 중요한 일은 이벤트로 남긴다

ABG에서 이벤트 로그는 단순한 디버그 로그가 아니다. 이벤트 로그는 시스템의 사실상 원장이다.

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

이 로그가 있으면 다음이 가능해진다.

- 실행 과정 replay
- 실패 지점 분석
- 상태 복원
- 비용·시간 분석
- 에이전트 판단 감사
- 사용자의 신뢰 확보
- regression test 생성

### 4.5 LLM은 뇌가 아니라 하나의 Actor 또는 Policy다

ABG에서 LLM은 전체 시스템 자체가 아니다. LLM은 다음 중 하나의 역할을 맡는다.

- planner
- policy evaluator
- summarizer
- critic
- tool argument generator
- response generator
- classifier
- memory query generator

즉 LLM은 ABG 안에서 실행되는 강력한 Actor이지만, 런타임의 모든 책임을 LLM에게 넘기지 않는다.

이 구분은 매우 중요하다. LLM에게 orchestration까지 모두 맡기면 다음 문제가 생긴다.

- 재현성 약화
- 디버깅 어려움
- 실패 복구 어려움
- 권한 제어 어려움
- 비용 폭증
- 상태 추적 어려움

ABG는 LLM의 자율성을 인정하되, 실행 구조는 명시적인 graph와 runtime으로 감싼다.

---

## 5. 핵심 개념 정의

### 5.1 Graph

ABG의 최상위 단위는 Graph다.

```text
Graph = Nodes + Edges + Event Streams + Runtime Context + Policies
```

Graph는 하나의 에이전트 워크플로우, 하나의 mission, 하나의 자동화 규칙, 또는 하나의 복합 작업을 표현한다.

예:

```text
coding-agent-review-graph
research-and-answer-graph
bug-fix-graph
release-checklist-graph
customer-support-agent-graph
```

### 5.2 Node

Node는 ABG의 기본 행동 단위다. Node는 단순 값을 반환하지 않고 Signal을 방출한다.

개념적으로 Node는 다음 함수로 볼 수 있다.

```text
Node.run(Context, InputStream) → AsyncStream<Signal>
```

TypeScript 형태로 표현하면 다음과 같다.

```ts
interface BehaviorNode {
  id: string;
  kind: NodeKind;
  run(ctx: RuntimeContext, input: AsyncIterable<Event>): AsyncIterable<Signal>;
}
```

Node는 다음 중 하나일 수 있다.

- Condition Node
- Action Node
- Selector Node
- Sequence Node
- Parallel Node
- Race Node
- Join Node
- Watch Node
- Policy Node
- Statechart Node
- Actor Node
- Memory Node
- Tool Node
- LLM Node
- Human Approval Node

### 5.3 Edge

Edge는 Node 사이의 연결이다. 단순한 제어 흐름뿐 아니라 event routing, data routing, guard, priority를 포함할 수 있다.

```text
Edge = source + target + condition + mapping + priority
```

ABG의 Edge는 다음 의미를 가질 수 있다.

- `on success → next`
- `on failure → fallback`
- `on event(user.cancel) → cancel`
- `on progress → observer`
- `on confidence.low → ask-user`
- `on timeout → recover`

### 5.4 Event

Event는 외부 또는 내부에서 발생한 사실이다.

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

예:

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

Event는 관찰된 사실이므로 되도록 불변으로 다룬다.

### 5.5 Signal

Signal은 Node가 Runtime에 보내는 실행 의도 또는 실행 결과다. Event가 “일어난 사실”이라면, Signal은 “노드가 방출한 의미 있는 상태 변화”다.

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

Behavior Tree의 `SUCCESS / FAILURE / RUNNING`은 ABG에서는 다음의 부분집합이 된다.

```text
RUNNING  → started + progress stream
SUCCESS  → success signal
FAILURE  → failure signal
```

### 5.6 Context

Context는 실행 중 공유되는 상태다. 단, Context를 무분별한 전역 mutable object로 만들면 안 된다.

ABG의 Context는 다음 계층으로 나눌 수 있다.

```text
Run Context      : 현재 실행의 고유 정보
Mission Context  : 목표, 제약, 사용자 요청
Memory Context   : 장기/단기 기억
Tool Context     : 사용 가능한 도구와 권한
Policy Context   : 비용, 시간, 안전성, 승인 규칙
Observation Log  : 지금까지 관찰된 이벤트 요약
```

중요한 원칙은 다음이다.

> Node는 Context를 직접 마구 수정하기보다, Event 또는 Signal을 통해 Runtime이 상태 변화를 기록하게 해야 한다.

### 5.7 Blackboard / Working Memory

LLM 에이전트에는 임시 작업 기억이 필요하다.

예:

- 사용자의 원래 요청
- 추론 중 도출한 하위 목표
- 검색된 문서
- 열린 파일 목록
- 테스트 결과
- 아직 검증되지 않은 가설
- 최종 답변에 포함해야 할 근거

ABG에서는 이를 Blackboard 또는 Working Memory로 둔다.

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

Blackboard는 LLM context window와 다르다. LLM context는 모델 호출에 들어가는 문자열이고, Blackboard는 런타임이 관리하는 구조화된 작업 기억이다.

### 5.8 Policy

Policy는 에이전트가 해도 되는 것과 하지 말아야 하는 것을 정의한다.

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

ABG에서 Policy는 단순 설정값이 아니라 그래프 실행에 개입하는 노드 또는 레이어다.

예:

```text
LLM이 파일 삭제 tool을 호출하려 함
  → Policy 검사
  → 사용자 승인 필요
  → Human Approval Node로 전환
```

---

## 6. 계층 구조

ABG 기반 LLM 에이전트는 다음 계층으로 나눌 수 있다.

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

mission-control의 TUI와 Desktop App은 단순 UI가 아니라 **운용 인터페이스**다.

여기서 사용자는 다음을 볼 수 있어야 한다.

- 지금 어떤 mission이 실행 중인가
- 현재 어떤 Node가 실행 중인가
- 어떤 Actor가 살아 있는가
- 어떤 이벤트가 들어왔는가
- 어떤 판단으로 경로가 바뀌었는가
- 어디서 비용이 발생했는가
- 어느 단계에서 사람이 승인해야 하는가
- 실패한 작업을 어디서부터 재개할 수 있는가

### 6.2 Mission Layer

Mission은 단순 요청보다 상위 개념이다.

```text
Mission = goal + constraints + resources + graph + run state
```

예:

```text
“이 레포지터리에서 결제 오류를 수정하고 테스트까지 통과시켜라.”
```

이 요청은 다음 mission으로 변환된다.

```text
Goal: 결제 오류 수정
Constraints: 기존 API 호환성 유지, destructive command 금지
Resources: repo files, shell, test runner, web search optional
Graph: bug-fix-agent-graph
Run State: active
```

### 6.3 Decision Layer

Decision Layer는 현재 상황에서 다음 행동을 선택한다.

예:

```text
Selector: next-action
├─ if user_cancelled → cancel-current-run
├─ if policy_requires_approval → ask-approval
├─ if insufficient_context → gather-context
├─ if failing_tests_exist → fix-code
├─ if patch_ready → run-tests
├─ if answer_ready → respond
└─ otherwise → reflect-and-plan
```

Decision Layer는 Behavior Tree의 장점을 가장 많이 흡수하는 계층이다.

### 6.4 Workflow Layer

Workflow Layer는 선택된 행동을 안정적으로 진행한다.

예:

```text
Code Fix Workflow
inspect → plan_patch → edit → test → review → respond
                     ↘ failure → rollback_or_retry
```

이 계층에는 다음이 포함된다.

- 상태 전이
- retry
- timeout
- compensation
- resume
- branch
- join
- checkpoint

### 6.5 Actor Execution Layer

실제 실행은 Actor가 담당한다.

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

Actor는 다음 특징을 가진다.

- 고유한 mailbox를 가진다.
- 메시지를 순차적으로 처리한다.
- 결과를 event stream으로 방출한다.
- 취소될 수 있다.
- 재시작될 수 있다.
- supervisor의 관리를 받는다.

### 6.6 Stream/Event Layer

모든 실행 결과는 Event 또는 Signal로 흐른다.

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

이 계층의 역할은 다음이다.

- 이벤트 전달
- 구독 관리
- event routing
- backpressure
- correlation id 관리
- causality 추적
- event log 기록

### 6.7 Persistence Layer

LLM 에이전트는 실행 과정을 남겨야 한다.

Persist 대상은 다음과 같다.

- event log
- run snapshot
- graph version
- input/output artifacts
- tool call records
- model call metadata
- cost metrics
- user approvals
- final result

이 계층이 있으면 mission-control은 단순 실행기가 아니라 운용 가능한 control plane이 된다.

---

## 7. 실행 의미론

### 7.1 Tick 기반이 아니라 Event 기반이다

전통적인 Behavior Tree는 tick 기반이다.

```text
매 tick마다 root부터 평가한다.
```

ABG는 기본적으로 event 기반이다.

```text
새 이벤트가 들어오면 관련 노드가 반응한다.
```

이 방식은 LLM 에이전트에 더 자연스럽다. 에이전트의 중요한 변화는 시간 tick보다 이벤트에 의해 발생하기 때문이다.

예:

- 사용자가 새 메시지를 보냄
- tool이 partial result를 보냄
- timeout 발생
- 테스트가 실패함
- LLM stream이 특정 marker를 생성함
- 비용 한도에 도달함

### 7.2 Node 실행은 Async Stream이다

ABG에서 Node 실행은 다음처럼 해석된다.

```text
start node
  → emit started
  → emit progress events zero or more times
  → emit success | failure | cancelled
```

즉 Node의 실행 결과는 `Promise<Result>`가 아니라 `AsyncIterable<Signal>`이다.

```ts
async function* runNode(ctx): AsyncIterable<Signal> {
  yield { type: "started", nodeId: "search" };
  yield { type: "progress", nodeId: "search", data: "query generated" };
  yield { type: "progress", nodeId: "search", data: "3 documents found" };
  yield { type: "success", nodeId: "search", result: documents };
}
```

이 설계는 다음을 자연스럽게 만든다.

- streaming UI
- 중간 취소
- 중간 판단 변경
- progress update
- live debugging
- event replay
- partial result 활용

### 7.3 Runtime은 Signal을 해석한다

Node는 직접 전체 세계를 바꾸지 않는다. Node는 Signal을 방출하고 Runtime이 이를 해석한다.

```text
Node → Signal → Runtime → Event Log / State Update / Next Action
```

예:

```text
Signal: spawn actor(search-worker)
Runtime:
  - actor 생성
  - event log 기록
  - actor mailbox 연결
  - lifecycle 추적
```

이 분리는 디버깅과 replay에 중요하다.

### 7.4 Causality를 추적한다

ABG의 모든 이벤트는 원인 관계를 가져야 한다.

```text
user.message.received #1
  → decision.selected #2, causationId=#1
  → tool.started #3, causationId=#2
  → tool.completed #4, causationId=#3
```

이 관계가 있으면 mission-control은 “왜 이 작업이 실행됐는가?”에 답할 수 있다.

### 7.5 Deterministic Shell, Non-deterministic Edge

ABG에서 런타임의 핵심은 가능하면 결정적이어야 한다.

- 이벤트 해석
- 상태 전이
- 정책 검사
- graph traversal
- retry count
- timeout rule

반면 다음은 비결정적일 수밖에 없다.

- LLM 응답
- 외부 API 결과
- 파일 시스템 상태
- 네트워크 응답
- 사용자 개입

따라서 ABG는 비결정적 결과를 Event Log에 기록하고, replay 시에는 가능하면 기록된 결과를 사용한다.

```text
Runtime decisions: deterministic
External observations: recorded
Replay: event log driven
```

---

## 8. 기본 노드 유형

### 8.1 Condition Node

조건을 평가한다.

```text
has_context?
is_user_waiting?
is_confidence_low?
are_tests_failing?
```

Condition Node는 보통 즉시 `success` 또는 `failure`를 낸다.

### 8.2 Action Node

실제 행동을 수행한다.

```text
read_file
search_web
call_llm
run_test
edit_file
summarize
ask_user
```

Action Node는 대부분 비동기 stream을 낸다.

### 8.3 Selector Node

여러 후보 중 하나를 선택한다.

```text
Selector: choose-next-action
├─ ask-user-if-blocked
├─ gather-context-if-needed
├─ execute-tool-if-planned
├─ repair-if-failed
└─ respond-if-ready
```

Selector에는 다양한 전략이 있을 수 있다.

- priority selector
- first-success selector
- score-based selector
- policy-filtered selector
- LLM-assisted selector
- cost-aware selector

### 8.4 Sequence Node

순차 실행을 표현한다.

```text
Sequence
├─ analyze request
├─ gather context
├─ generate plan
├─ execute plan
└─ respond
```

Sequence는 중간 failure를 어떻게 다룰지 명시해야 한다.

- fail-fast
- skip-failed
- compensate-and-fail
- retry-and-continue

### 8.5 Parallel Node

여러 작업을 동시에 실행한다.

```text
Parallel
├─ search local files
├─ search memory
├─ search web
└─ ask lightweight model for query expansion
```

Parallel Node는 completion rule이 필요하다.

- all succeed
- any succeed
- quorum
- first useful result
- until enough context

### 8.6 Race Node

여러 작업 중 먼저 유효한 결과를 낸 작업을 선택한다.

```text
Race
├─ local cache
├─ remote search
└─ timeout
```

Race는 지연 시간을 줄이는 데 유용하다.

### 8.7 Join Node

여러 stream 또는 결과를 합친다.

```text
Join
├─ file search result
├─ web search result
├─ memory result
└─ user-provided context
```

Join Node는 merge 전략이 필요하다.

- append
- rank
- deduplicate
- summarize
- vote
- reconcile conflicts

### 8.8 Watch Node

Watch Node는 특정 이벤트를 감시하다가 흐름을 바꾼다.

```text
Watch
├─ on user.cancel → cancel run
├─ on user.corrects_scope → redirect workflow
├─ on budget.exceeded → stop or ask approval
├─ on tool.failed → recover
└─ on enough_context → cancel remaining searches
```

LLM 에이전트에는 Watch Node가 매우 중요하다. 사용자의 중간 개입과 외부 이벤트를 자연스럽게 반영할 수 있기 때문이다.

### 8.9 Policy Node

Policy Node는 행동의 허용 여부를 판단한다.

```text
Can this tool be used?
Is human approval required?
Is cost budget exceeded?
Is the action destructive?
Is confidence high enough to answer?
```

Policy Node는 ABG의 안전장치다.

### 8.10 Statechart Node

복잡한 장기 절차를 상태 머신으로 캡슐화한다.

```text
Statechart: code-edit-flow
states:
  inspect
  patch
  test
  review
  finalize
```

Statechart Node는 내부적으로 여러 이벤트를 소비하고 상태 전이를 방출한다.

### 8.11 Actor Node

Actor Node는 독립 실행 단위를 생성하거나 메시지를 보낸다.

```text
spawn test-runner
send run-tests
receive test-result
```

Actor Node는 장기 실행 작업, 외부 도구, 서브에이전트에 적합하다.

### 8.12 Human Node

Human Node는 사용자 승인, 선택, 정보 제공을 기다린다.

```text
Ask approval before deleting files
Ask user to choose one of multiple strategies
Ask for missing credential
Ask whether to continue spending tokens
```

Human Node도 비동기 Node다. 사용자의 응답은 Event로 들어온다.

---

## 9. 그래프 제어 패턴

### 9.1 Observe → Decide → Act → Observe Loop

LLM 에이전트의 기본 루프는 다음이다.

```text
Observe
  → Decide
  → Act
  → Observe
  → Decide
  → ...
```

ABG는 이 루프를 명시적으로 표현한다.

```text
Observation Stream
  → Context Update
  → Decision Selector
  → Action Workflow
  → Event Stream
```

이 루프는 ReAct 패턴과 유사하지만, ABG는 생각 텍스트보다 event와 graph를 중심으로 한다.

### 9.2 Plan → Execute → Monitor → Replan

복잡한 작업에서는 계획과 실행이 분리된다.

```text
Plan
  → Execute step
  → Monitor result
  → Replan if needed
  → Continue
```

ABG에서 plan은 고정된 script가 아니라 수정 가능한 artifact다.

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

여러 가능성을 동시에 시도하고 가장 좋은 경로를 선택할 수 있다.

```text
Parallel
├─ local repo search
├─ symbol search
├─ error message web search
└─ ask model for likely cause
```

그 후 Join/Rank Node가 가장 유용한 결과를 선택한다.

### 9.4 Early Stop

streaming 환경에서는 모든 작업 완료를 기다릴 필요가 없다.

```text
enough_context_detected
  → cancel remaining searches
  → proceed to answer
```

이것은 비용과 지연 시간을 줄인다.

### 9.5 Human-in-the-loop

ABG는 사용자를 외부 방해 요소가 아니라 그래프의 일부로 본다.

```text
Need approval
  → Human Node
  → wait for user event
  → continue / abort / modify plan
```

사용자 개입은 mission의 중요한 Event다.

### 9.6 Supervisor Pattern

Actor는 실패할 수 있다. 따라서 supervisor가 필요하다.

```text
Supervisor
├─ restart actor
├─ retry with backoff
├─ escalate to human
├─ switch fallback actor
└─ fail mission
```

Supervisor는 ABG의 안정성을 높인다.

---

## 10. LLM 에이전트 특화 설계

### 10.1 LLM 호출은 Action이 아니라 Actor에 가깝다

LLM 호출은 단순 함수처럼 보이지만 실제로는 다음 특성을 가진다.

- streaming token
- tool call proposal
- 비용 발생
- latency 발생
- non-deterministic output
- context window 제한
- system/developer/user message 계층
- safety/policy 검증 필요

따라서 ABG에서 LLM 호출은 `LLMActor`로 다루는 것이 자연스럽다.

### 10.2 LLM 역할 분해

하나의 거대한 LLM 호출이 모든 일을 하게 하지 않고 역할을 나눈다.

```text
IntentClassifier
Planner
ToolArgumentGenerator
Critic
Summarizer
Responder
PolicyExplainer
```

각 역할은 별도 Node 또는 Actor가 될 수 있다.

이점:

- 비용 최적화
- 모델 선택 최적화
- 실패 지점 분리
- 결과 검증 용이
- streaming UI 구성 용이

### 10.3 Tool Call은 계획이 아니라 실행 요청이다

LLM이 tool call을 제안했다고 해서 즉시 실행해서는 안 된다. ABG에서는 tool call proposal이 먼저 Event가 된다.

```text
llm.tool_call.proposed
  → policy check
  → permission check
  → argument validation
  → execute tool actor
```

이 구조는 안전성과 관찰 가능성을 높인다.

### 10.4 Context Window와 Runtime Memory를 분리한다

LLM context window에 모든 것을 넣으려 하면 비용과 품질 문제가 생긴다. ABG는 runtime memory를 별도로 관리한다.

```text
Runtime Memory
├─ event log
├─ summaries
├─ artifacts
├─ retrieved docs
├─ tool results
└─ decisions
```

LLM 호출 시에는 필요한 부분만 context packer가 선택한다.

```text
Context Packer
  → select relevant memory
  → compress observations
  → include active plan
  → include constraints
  → build prompt
```

### 10.5 Streaming Response도 그래프의 출력이다

최종 답변도 단순 문자열이 아니라 stream이다.

```text
response.started
response.delta
response.citation.added
response.artifact.created
response.completed
```

mission-control은 이 stream을 TUI/Desktop에서 표시할 수 있어야 한다.

### 10.6 Critic과 Quality Gate

LLM 에이전트는 자기 결과를 검토해야 한다.

```text
Draft Answer
  → Critic Node
  → Quality Gate
  → revise or finalize
```

Quality Gate는 다음을 검사한다.

- 사용자 요청을 실제로 충족했는가
- 필요한 근거가 있는가
- 불확실성을 표시했는가
- 위험한 tool 사용이 있었는가
- 검증되지 않은 가정을 사실처럼 말하지 않았는가
- 너무 많은 비용을 쓰지 않았는가

---

## 11. Mission-Control 관점의 핵심 개념

mission-control은 ABG runtime을 직접 구현하는 앱일 수도 있고, 여러 agent runtime을 관찰·제어하는 control plane일 수도 있다.

중요한 것은 mission-control이 단순한 “에이전트 실행 버튼”이 아니라는 점이다.

mission-control의 정체성은 다음과 같다.

```text
mission-control = ABG 기반 LLM 에이전트 운용 콘솔
```

### 11.1 Mission

Mission은 사용자가 달성하려는 목표다.

```text
Fix failing payment test
Generate release note
Research card benefits
Refactor auth module
Create design proposal
```

Mission은 다음을 가진다.

- goal
- constraints
- graph
- run history
- artifacts
- approvals
- metrics

### 11.2 Run

Run은 특정 Mission의 한 번의 실행이다.

```text
Mission: fix payment bug
Run #1: failed due to missing env
Run #2: succeeded after user provided env
```

Run은 event log와 snapshot을 가진다.

### 11.3 Timeline

Timeline은 ABG 실행을 사람이 이해할 수 있게 보여주는 축이다.

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

TUI와 Desktop 앱 모두 Timeline을 중심 UI로 삼는 것이 적합하다.

### 11.4 Graph Inspector

Graph Inspector는 현재 Graph의 구조와 실행 상태를 보여준다.

```text
[active] gather-context
[pending] plan
[running] search-files
[blocked] ask-approval
[completed] classify-intent
[failed] run-tests
```

### 11.5 Actor Inspector

Actor Inspector는 현재 실행 중인 Actor들을 보여준다.

```text
LLMActor: streaming
ShellActor: running tests
FileActor: idle
MemoryActor: retrieving
UserActor: waiting approval
```

### 11.6 Policy Inspector

Policy Inspector는 왜 어떤 행동이 허용되거나 차단되었는지 보여준다.

```text
Action: delete file
Policy: destructive action
Decision: human approval required
Status: waiting
```

### 11.7 Replay

Replay는 ABG의 핵심 기능이다.

Replay는 단순히 로그를 다시 보여주는 것이 아니다. 이벤트 로그를 기반으로 실행 상태를 재구성하는 것이다.

```text
Event Log → Reconstructed Run State → Timeline / Graph State
```

이를 통해 사용자는 다음을 할 수 있다.

- 실패한 run 분석
- 특정 지점부터 재시도
- 다른 정책으로 dry-run
- regression scenario 생성

---

## 12. 상태, 메모리, 로그의 관계

ABG에서는 세 가지를 구분해야 한다.

```text
State   : 현재 실행 상태
Memory  : 에이전트가 참고하는 지식
Log     : 실제로 발생한 사건의 기록
```

### 12.1 State

State는 현재 run의 스냅샷이다.

```text
current node
active actors
pending approvals
retry counts
open streams
workflow state
```

### 12.2 Memory

Memory는 작업을 수행하는 데 필요한 지식이다.

```text
user preferences
project facts
retrieved docs
summaries
previous decisions
```

### 12.3 Log

Log는 불변의 실행 기록이다.

```text
event #1 happened
event #2 happened because of #1
event #3 happened because of #2
```

### 12.4 원칙

```text
State는 Log로부터 복원 가능해야 한다.
Memory는 Context Packer를 통해 선택적으로 LLM에 주입되어야 한다.
Log는 사람이 읽을 수 있고 기계가 replay할 수 있어야 한다.
```

---

## 13. 취소, timeout, retry, 보상

비동기 workflow에서는 happy path보다 failure path가 더 중요하다.

### 13.1 Cancellation

취소는 예외가 아니라 정상적인 제어 흐름이다.

```text
user.cancel
policy.cancel
race.loser.cancel
timeout.cancel
superseded.cancel
```

ABG의 모든 장기 실행 Node와 Actor는 cancellation을 받을 수 있어야 한다.

### 13.2 Timeout

Timeout은 Node, Actor, Workflow, Mission 레벨에 모두 존재할 수 있다.

```text
Tool timeout: 30s
LLM timeout: 120s
Workflow timeout: 10m
Mission timeout: user-defined
```

Timeout은 단순 실패가 아니라 다음 경로로 이어질 수 있다.

```text
timeout
  → retry
  → fallback model
  → ask user
  → partial answer
  → fail mission
```

### 13.3 Retry

Retry는 무조건 반복이 아니다. 재시도 정책은 원인을 고려해야 한다.

```text
network error → retry with backoff
validation error → do not retry without modification
rate limit → wait or switch provider
test failure → replan, not simple retry
```

### 13.4 Compensation

이미 실행된 작업을 되돌려야 할 수 있다.

예:

```text
file edited
  → tests failed badly
  → rollback patch
```

ABG에서는 destructive 또는 state-changing action에 보상 전략을 연결하는 것이 좋다.

```text
Action: edit-file
Compensation: restore previous content
```

---

## 14. Backpressure와 자원 관리

Streaming 시스템에서는 이벤트가 너무 많이 발생할 수 있다.

예:

- LLM token stream
- shell stdout
- 파일 변경 이벤트
- 로그 tail
- 여러 병렬 search result

ABG는 backpressure를 고려해야 한다.

### 14.1 Backpressure 전략

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

### 14.2 LLM Token Stream 처리

LLM token stream을 모두 event log에 원문으로 저장하면 비용과 저장 공간이 커질 수 있다.

따라서 다음 계층화가 필요하다.

```text
raw token stream       : UI 표시용, 선택적 저장
semantic delta stream  : 문장/블록 단위
final message artifact : 최종 저장
summary event          : replay/검색용
```

### 14.3 우선순위

모든 stream이 같은 중요도를 갖지 않는다.

```text
High: policy violation, user cancel, tool failure
Medium: workflow transition, tool complete
Low: token delta, verbose stdout
```

Runtime은 중요한 이벤트를 우선 처리해야 한다.

---

## 15. Policy와 안전성

ABG는 LLM 에이전트의 자유도를 높이는 동시에 경계를 명확히 해야 한다.

### 15.1 Capability 기반 권한

Node와 Actor는 자신에게 주어진 capability만 사용할 수 있어야 한다.

```text
FileReadCapability
FileWriteCapability
ShellCapability
NetworkCapability
BrowserCapability
MemoryWriteCapability
UserMessageCapability
```

Graph 또는 Mission 단위로 capability를 제한할 수 있다.

### 15.2 Destructive Action Gate

다음 행동은 명시적 gate를 거치는 것이 좋다.

- 파일 삭제
- 대량 수정
- 데이터베이스 변경
- 외부 서비스 배포
- 결제/이메일 발송
- 비가역적 API 호출

```text
Action proposed
  → destructive?
  → require approval
  → execute only after approval event
```

### 15.3 Confidence 기반 제어

LLM이 낮은 확신으로 행동하는 것을 막아야 한다.

```text
if confidence < threshold:
  ask user
  gather more context
  run verification
  produce uncertain answer
```

Confidence는 LLM 자기평가만으로 두면 안 된다. 다음을 함께 본다.

- 근거 문서 수
- tool 검증 여부
- 테스트 결과
- 출처 충돌 여부
- policy risk
- task criticality

### 15.4 Cost Budget

모델 호출, 검색, 빌드, 테스트는 비용이 있다.

ABG는 비용을 event로 기록하고 policy로 제한한다.

```text
model.call.started
model.call.completed { inputTokens, outputTokens, costEstimate }
budget.remaining.updated
budget.exceeded
```

---

## 16. 관찰 가능성

mission-control의 핵심 가치는 observability다.

### 16.1 무엇을 관찰해야 하는가

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

### 16.2 설명 가능한 실행

사용자는 다음 질문에 답을 얻을 수 있어야 한다.

- 왜 이 도구를 호출했는가?
- 왜 이 모델을 사용했는가?
- 왜 사용자 승인을 요구했는가?
- 왜 이전 작업이 취소되었는가?
- 왜 이 답변을 충분하다고 판단했는가?
- 어떤 근거로 결론을 냈는가?

이를 위해 decision event는 이유를 포함해야 한다.

```text
decision.selected
  target: run-tests
  reason: patch was applied and validation policy requires tests
  alternatives: respond, inspect-more
  rejected: respond because validation incomplete
```

### 16.3 Timeline First

ABG UI는 graph 그림보다 timeline이 더 중요할 수 있다. 실제 운용에서는 “구조”보다 “무슨 일이 어떤 순서로 일어났는가”가 문제 해결에 더 직접적이기 때문이다.

추천 관점:

```text
Timeline = primary debugging surface
Graph = structural map
Inspector = detail panel
```

---

## 17. ABG와 일반 DAG의 차이

DAG는 의존성 실행에 좋다.

```text
A and B → C → D
```

그러나 LLM 에이전트는 단순 DAG보다 동적이다.

```text
A 결과가 불충분하면 B를 추가 실행
사용자가 중간에 목표 수정
C 도중 오류가 나면 새로운 계획 생성
D가 끝나기 전에 충분한 답을 발견하면 조기 종료
```

ABG는 다음 점에서 DAG와 다르다.

| 항목 | DAG | Async Behavior Graph |
|---|---|---|
| 구조 | 주로 정적 | 동적 변경 가능 |
| 실행 | 의존성 완료 기반 | 이벤트 반응 기반 |
| 중간 개입 | 약함 | 핵심 개념 |
| 스트림 | 보통 결과 중심 | stream 중심 |
| 의사결정 | 제한적 | 핵심 기능 |
| LLM agent | 일부 작업에 적합 | 전체 운용 모델에 적합 |

---

## 18. ABG와 Behavior Tree의 차이

| 항목 | Behavior Tree | Async Behavior Graph |
|---|---|---|
| 기본 형태 | Tree | Graph |
| 실행 방식 | Tick 기반 | Event/Stream 기반 |
| Node 반환 | SUCCESS/FAILURE/RUNNING | Signal stream |
| 비동기 | RUNNING으로 우회 | 기본 의미론 |
| 중간 결과 | 제한적 | 핵심 개념 |
| 사용자 개입 | 별도 처리 | Event로 통합 |
| 장기 workflow | 불편함 | Statechart로 표현 |
| 병렬 실행 | Parallel node | Actor/Parallel/Race/Join |
| 관찰 가능성 | 직접 설계 필요 | Event log 중심 |
| LLM 도구 호출 | 별도 확장 필요 | 기본 Actor/Tool 모델 |

Behavior Tree는 ABG 안에서 Decision DSL로 사용될 수 있다.

```text
Behavior Tree ⊂ Async Behavior Graph
```

---

## 19. 형식적 모델

ABG를 형식적으로 표현하면 다음과 같다.

```text
ABG = (N, E, S, C, P, R)
```

각 요소는 다음을 의미한다.

```text
N: Node 집합
E: Edge 집합
S: Stream 집합
C: Context / Blackboard
P: Policy 집합
R: Runtime 의미론
```

각 Node는 다음 함수로 볼 수 있다.

```text
nᵢ: (C, S_in, P) → S_out
```

즉 Node는 Context, 입력 Stream, Policy를 받아 출력 Stream을 만든다.

Runtime은 모든 출력 Signal을 해석하여 새로운 Event, State, Actor, Node 실행을 생성한다.

```text
R: (GraphState, Signal) → GraphState'
```

실행은 다음 반복으로 이뤄진다.

```text
1. Event를 수신한다.
2. Event를 Event Log에 기록한다.
3. Event와 관련된 Node를 활성화한다.
4. Node가 Signal stream을 방출한다.
5. Runtime이 Signal을 해석한다.
6. State를 갱신하고 필요한 Actor/Node를 실행한다.
7. 새로운 Event가 발생하면 반복한다.
```

---

## 20. ABG의 최소 의미론

ABG를 구현한다면 최소한 다음 의미론은 필요하다.

### 20.1 Node Lifecycle

```text
idle
  → starting
  → running
  → succeeded | failed | cancelled
```

### 20.2 Actor Lifecycle

```text
created
  → starting
  → running
  → stopping
  → stopped | failed | restarted
```

### 20.3 Workflow Lifecycle

```text
created
  → active
  → blocked
  → completed | failed | cancelled
```

### 20.4 Mission Lifecycle

```text
draft
  → ready
  → running
  → waiting_for_user
  → completed | failed | cancelled | archived
```

### 20.5 Event Delivery

이벤트 전달은 최소한 다음 속성을 가져야 한다.

- ordered per source
- globally timestamped
- correlation id 지원
- replay 가능
- 중복 처리 가능성 고려

### 20.6 Idempotency

Replay와 retry를 위해 Node는 가능하면 idempotent해야 한다.

특히 외부 side effect가 있는 Node는 idempotency key 또는 compensation이 필요하다.

---

## 21. LLM 에이전트 워크플로우 예시

### 21.1 Research Agent Graph

```text
Mission: 사용자의 질문에 근거 기반으로 답변하기

Observe user request
  → classify intent
  → decide if fresh info required
  → gather context
      ├─ memory search
      ├─ file search
      └─ web search
  → join evidence
  → draft answer
  → critic check
  → final response stream
```

중요한 이벤트:

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
Mission: 코드 문제를 수정하고 검증하기

User request
  → inspect repo
  → identify relevant files
  → generate patch plan
  → request approval if destructive
  → edit files
  → run tests
  → if tests fail: inspect failure and repair
  → summarize changes
```

이 그래프는 Watch Node가 중요하다.

```text
Watch
├─ on user.scope.changed → cancel current search and redirect
├─ on test.failed → replan
├─ on command.timeout → retry or ask user
└─ on policy.blocked → wait approval
```

### 21.3 Multi-Agent Graph

```text
Mission
  → PlannerAgent
  → parallel:
      ├─ ResearchAgent
      ├─ CodeAgent
      ├─ TestAgent
      └─ ReviewAgent
  → CoordinatorAgent joins results
  → Final Responder
```

여기서 각 Agent는 Actor다. Coordinator는 Decision Node와 Join Node의 조합이다.

---

## 22. Graph 작성의 사상

ABG의 그래프는 코드를 숨기기 위한 시각화가 아니다. 그래프는 실행 사상을 명시하는 문서이자 런타임 구조다.

좋은 ABG는 다음 특징을 가진다.

1. **행동 선택이 명시적이다.**  
   왜 다음 행동이 선택되는지 graph에서 보인다.

2. **실패 경로가 존재한다.**  
   happy path만 그리지 않는다.

3. **사용자 개입 지점이 명확하다.**  
   어디서 승인이 필요한지 보인다.

4. **도구 사용이 감시 가능하다.**  
   어떤 tool이 어떤 근거로 호출되는지 기록된다.

5. **중간 결과를 활용한다.**  
   모든 작업 완료를 기다리지 않고 충분한 정보가 모이면 다음 단계로 간다.

6. **정책이 그래프에 드러난다.**  
   비용, 권한, 위험도, confidence가 실행에 영향을 준다.

7. **재시작 가능하다.**  
   실패한 run을 처음부터 다시 하지 않고 적절한 checkpoint에서 이어갈 수 있다.

---

## 23. 설계 원칙

### 23.1 Explicit over Implicit

에이전트의 중요한 판단은 암묵적인 prompt 안에 숨기지 않는다.

나쁜 예:

```text
LLM에게 “알아서 필요한 일을 해”라고 시킨다.
```

좋은 예:

```text
Graph에 다음 행동 후보, policy, approval, validation path를 명시한다.
```

### 23.2 Stream First

모든 장기 실행 작업은 stream으로 본다.

```text
Promise<Result>보다 AsyncIterable<Signal>
```

### 23.3 Human-visible Runtime

에이전트는 사용자가 관찰할 수 있어야 한다.

```text
black box agent → glass box agent
```

### 23.4 Bounded Autonomy

에이전트는 자율적으로 행동하되, 경계 안에서만 행동한다.

```text
autonomy + policy + approval + audit
```

### 23.5 Recovery is First-class

실패 처리는 나중에 붙이는 예외 처리 코드가 아니라 graph의 핵심 구조다.

### 23.6 Model-Agnostic

ABG는 특정 LLM 모델에 종속되지 않는다. 모델은 Actor 또는 Node 구현체 중 하나다.

### 23.7 Tool-Agnostic

도구도 마찬가지다. Shell, web, file, database, browser, MCP, API는 모두 Tool Actor로 추상화할 수 있다.

### 23.8 Replayable by Design

실행은 replay 가능하게 설계한다. replay가 불가능한 실행은 디버깅과 신뢰 확보가 어렵다.

---

## 24. mission-control이 제공해야 할 사고 도구

이 문서는 구현 스펙이 아니지만, mission-control이 어떤 사고 도구를 제공해야 하는지는 이론적으로 중요하다.

### 24.1 Graph as Map

Graph는 에이전트가 갈 수 있는 경로의 지도다.

### 24.2 Timeline as Truth

Timeline은 실제로 무슨 일이 일어났는지에 대한 진실의 기록이다.

### 24.3 Policy as Boundary

Policy는 에이전트의 자율성 경계다.

### 24.4 Memory as Working Surface

Memory는 LLM prompt가 아니라 agent runtime이 관리하는 작업 표면이다.

### 24.5 Actor as Unit of Responsibility

Actor는 책임과 실패 격리의 단위다.

### 24.6 Mission as Productive Intent

Mission은 사용자의 생산적 의도를 실행 가능한 구조로 변환한 것이다.

---

## 25. 용어 정리

| 용어 | 의미 |
|---|---|
| ABG | Async Behavior Graph |
| Mission | 사용자가 달성하려는 목표와 제약의 묶음 |
| Run | Mission의 한 실행 인스턴스 |
| Node | 행동, 조건, 정책, workflow, actor 등을 표현하는 그래프 단위 |
| Edge | Node 간 제어·데이터·이벤트 흐름 |
| Event | 실제 발생한 사실 |
| Signal | Node가 Runtime에 방출하는 실행 의미 |
| Actor | 독립 실행 주체 |
| Policy | 실행 제약과 허용 규칙 |
| Blackboard | 구조화된 작업 기억 |
| Timeline | Event Log의 인간 친화적 표현 |
| Replay | Event Log를 기반으로 실행을 재구성하는 행위 |
| Watch Node | 특정 이벤트를 감시하고 경로를 바꾸는 노드 |
| Join Node | 여러 결과나 stream을 합치는 노드 |
| Race Node | 여러 작업 중 먼저 유효한 결과를 선택하는 노드 |

---

## 26. 결론

Async Behavior Graph는 LLM 에이전트 워크플로우를 단순한 prompt chain이나 tool call loop로 보지 않는다. ABG는 에이전트를 다음과 같은 실행 시스템으로 본다.

```text
에이전트는 이벤트를 관찰하고,
상황에 따라 행동을 선택하며,
비동기 작업을 실행하고,
중간 결과를 stream으로 받아들이며,
정책과 사용자 개입에 의해 경계를 유지하고,
모든 과정을 event log로 남기는 시스템이다.
```

mission-control은 이 시스템을 위한 control plane이다. TUI의 `mctrl`은 빠른 운용과 실시간 관찰에 적합하고, Desktop App은 timeline 분석, graph/session projection, approval 검토, 더 깊은 분석에 적합하다. 그러나 두 인터페이스의 본질은 같다.

```text
LLM 에이전트를 실행하는 것이 아니라,
LLM 에이전트의 행동 그래프를 운용한다.
```

ABG의 핵심 명제는 다음과 같다.

> LLM 에이전트의 신뢰성은 더 강한 모델 하나에서 나오지 않는다.  
> 신뢰성은 관찰 가능한 실행 구조, 명시적인 정책, replay 가능한 이벤트 로그, 그리고 사람이 개입할 수 있는 행동 그래프에서 나온다.

따라서 mission-control의 이론적 기반은 다음 문장으로 요약된다.

> mission-control은 Async Behavior Graph를 통해 LLM 에이전트의 사고, 행동, 도구 실행, stream, 실패 복구, 사용자 개입을 하나의 관찰 가능한 mission runtime으로 조직하는 시스템이다.

---

## 부록 A. ABG를 한 줄 DSL로 생각하기

```text
observe events → update context → select behavior → run workflow → spawn actors → stream signals → apply policy → persist log → repeat
```

---

## 부록 B. 최소 Runtime Contract

ABG runtime은 최소한 다음 contract를 만족해야 한다.

```text
1. Node는 Signal stream을 방출한다.
2. Runtime은 모든 중요한 Signal을 Event Log에 기록한다.
3. Runtime은 Event에 따라 Graph State를 갱신한다.
4. Actor는 메시지 기반으로 실행되고 취소 가능해야 한다.
5. Workflow는 상태 전이와 실패 경로를 명시해야 한다.
6. Policy는 tool 실행 전 개입할 수 있어야 한다.
7. 사용자 개입은 Event로 모델링되어야 한다.
8. 실행 상태는 Snapshot으로 저장될 수 있어야 한다.
9. Event Log로 Timeline과 Replay를 구성할 수 있어야 한다.
10. LLM은 Runtime 전체가 아니라 Node 또는 Actor 중 하나로 취급되어야 한다.
```

---

## 부록 C. 핵심 비유

```text
Behavior Tree는 행동의 의사결정 트리다.
Statechart는 장기 실행 절차의 지도다.
Actor Model은 독립 실행자들의 조직도다.
Reactive Stream은 시스템의 신경망이다.
Event Log는 기억과 감사의 원장이다.
Policy는 자율성의 울타리다.
Async Behavior Graph는 이 모든 것을 묶는 mission runtime이다.
```

---

## 부록 D. Mission Control 구현 상태

현재 `mission-control` 구현은 위 이론 전체를 완성한 엔진이 아니라, 범위가 제한된 ABG coding-agent MVP다.

구현된 runtime surface:

- `MCTRL_DATA_DIR` 또는 플랫폼 application-data 디렉터리 아래의 durable JSONL session event storage.
- chat, graph snapshot, transcript branch, approval state, file diff, command output을 재구성하는 replay projection.
- deterministic local provider 실행, 저장된 credential 뒤의 OpenAI Responses, Anthropic Messages, Google Gemini, 그리고 OpenRouter, Groq, DeepSeek, Mistral용 OpenAI-compatible adapter.
- provider capability 문서는 executable adapter와 catalog/auth/model-discovery entry를 구분한다. provider가 runnable로 문서화되려면 executable adapter proof가 필요하다.
- raw credential 저장을 피하는 provider-neutral streaming event, typed provider error, redaction metadata.
- `approval.requested`, `approval.updated`, `approval.resumed`, `approval.blocked` approval lifecycle event.
- `repo.read`, `repo.list`, `repo.search`, `file.patch`, `command.run` safe tool set과 permission gate.
- `temp/ref-repos` 아래 reference repository는 planning evidence 전용이며 runtime repo tool은 기본적으로 해당 경로를 거부한다.
- Runtime prompt와 tool instruction은 reference repo의 AGENTS.md 또는 다른 instruction을 로드하면 안 된다.
- 기본 graph node concurrency 2, provider parallel tool call 4, shell/process concurrency 1, retry cap, loop limit을 가진 bounded graph coordination.
- CLI JSONL 및 interactive coding-agent flow.
- Desktop event inspection과 timeline/graph/session projection은 Tauri shell에 연결되어 있다.
- core desktop command service는 prompt, queue follow-up, steer, interrupt, resume, approval decision을 처리한다. Tauri write command는 Rust shell bridge를 통해 해당 service를 호출하고 저장된 session provider selection을 재사용하며 실제 `eventsWritten` count를 반환한다.
- Desktop Tauri credential command는 CLI와 같은 shared auth file을 통해 API-key credential을 저장하고 나열한다.
- `task.run` capability를 협상하는 Sidecar protocol v1 Rust handshake와 native/mock/unavailable status event.

아직 연기된 범위:

- full production ABG engine semantics, compensation policy, autonomous long-running scheduler.
- visual graph editing.
- vector memory, persistent memory store, JSONL을 넘어서는 database index.
- unrestricted tool, automatic rollback, `file.patch` 또는 `command.run`의 기본 sidecar 실행.
- deterministic local path, OpenAI Responses, Anthropic Messages, Google Gemini, OpenAI-compatible provider family를 넘어서는 provider adapter.
