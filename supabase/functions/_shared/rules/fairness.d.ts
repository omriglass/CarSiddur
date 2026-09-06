import type { Rule } from './types';
export interface FairnessParams {
    lookbackWeeks: number;
}
export declare const fairness: Rule<FairnessParams>;
