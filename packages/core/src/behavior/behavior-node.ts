export type BehaviorNodeType =
    | 'sequence'
    | 'selector'
    | 'action'
    | 'condition'
    | 'parallel'
    | 'race'
    | 'join'
    | 'watch'
    | 'policy'
    | 'statechart'
    | 'actor'
    | 'memory'
    | 'tool'
    | 'llm'
    | 'human-approval';

export interface BehaviorNode {
    readonly id: string;
    readonly type: BehaviorNodeType;
    readonly label?: string;
}
