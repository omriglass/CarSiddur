import type { Rule } from './types';
export interface SubmissionTimeParams {
    latePenalty: number;
}
export declare const submissionTime: Rule<SubmissionTimeParams>;
