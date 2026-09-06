import type { Car, Passengers } from './types';
/** q dominates p iff every component of q is >= the matching component of p. */
export declare function dominates(q: Passengers, p: Passengers): boolean;
/** True iff some seat configuration of `car` dominates `p`. */
export declare function fits(car: Car, p: Passengers): boolean;
/** Total slack (sum of leftover seats) of the minimal dominating configuration; null if none fits. */
export declare function slack(car: Car, p: Passengers): number | null;
/** Component-wise sum of any number of passenger sets. Nothing is ever subtracted (SOLVER §3.3). */
export declare function sum(...ps: Passengers[]): Passengers;
/** Luggage fit: number of luggage requests in a ride <= luggageCapacity(car). */
export declare function luggageFits(car: Car, luggageCount: number): boolean;
/** Chauffeur load: served requests' passengers plus one adult for the volunteer (SOLVER §3.3, REQ §13.65). */
export declare function chauffeurLoad(served: Passengers): Passengers;
