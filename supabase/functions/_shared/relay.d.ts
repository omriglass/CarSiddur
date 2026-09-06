import type { NormalizedRequest } from './slots';
import type { Car, Window } from './types';
export interface RelayPair {
    id: string;
    outRequestId: string;
    returnRequestId: string;
    destinationId: string;
    outWindow: Window;
    returnWindow: Window;
    idleSlots: number;
    shiftCost: number;
}
export interface Candidate {
    out: NormalizedRequest;
    ret: NormalizedRequest;
    outWindow: Window;
    returnWindow: Window;
    idleSlots: number;
    shiftCost: number;
}
export declare function tryPair(out: NormalizedRequest, ret: NormalizedRequest, cars: Car[]): Candidate | null;
export interface PairRelaysResult {
    pairs: RelayPair[];
    unpaired: NormalizedRequest[];
}
export declare function pairRelays(requests: NormalizedRequest[], cars: Car[]): PairRelaysResult;
