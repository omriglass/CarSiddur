import { tv } from "@/i18n/he";
import type { GuardedChild } from "./api";

/** One "הורה של" row: the name, plus the age when the birth year is known (REQ §13.198 b). */
export function guardedChildLabel(child: GuardedChild): string {
  return child.age === null ? child.name : tv("profileExtra.childWithAge", { name: child.name, age: String(child.age) });
}
