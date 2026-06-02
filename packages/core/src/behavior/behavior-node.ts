export type BehaviorNodeType = 'sequence' | 'selector' | 'action' | 'condition' | 'parallel';

export interface BehaviorNode {
    readonly id: string;
    readonly type: BehaviorNodeType;
    readonly label?: string;
}
