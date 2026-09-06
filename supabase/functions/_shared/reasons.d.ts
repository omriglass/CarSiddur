/**
 * Renders the Hebrew template for `code`, substituting `{key}` placeholders
 * from `params`. Unknown placeholders are left as-is; an unknown code falls
 * back to the code itself so a missing template never throws.
 */
export declare function reason(code: string, params?: Record<string, string | number>): string;
/** Hebrew description of a rule type, for the admin policy editor. */
export declare function ruleDescription(code: string): string;
/** Hebrew message for a PolicyParamsError, keyed by error code. */
export declare function paramsErrorMessage(code: string): string;
export declare const reasonCodes: string[];
