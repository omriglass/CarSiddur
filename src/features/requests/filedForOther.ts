// REQ §13.177 (c) (owner 2026-11-01): a request I filed for someone else and do not ride on myself — I am neither its
// requester nor a companion on it. Hidden on "my rides" unless its display option is on, and never painted as mine
// (the purple "my ride" colour) on the siddur or the /my week view.
import type { MyRequestRow } from "./api";

export function isFiledForOther(row: Pick<MyRequestRow, "filedById" | "requesterId" | "companionIds">, viewerId: string | undefined): boolean {
  return !!viewerId && row.filedById === viewerId && !!row.requesterId && row.requesterId !== viewerId
    && !(row.companionIds ?? []).includes(viewerId);
}

/** Ids of my requests that are my own trips (not only filed for someone else, nor someone's I may edit — REQ §13.202). */
export function ownRequestIds(rows: readonly (Pick<MyRequestRow, "filedById" | "requesterId" | "companionIds" | "editorOf"> & { id: string })[], viewerId: string | undefined): Set<string> {
  return new Set(rows.filter((row) => !isFiledForOther(row, viewerId) && !row.editorOf).map((row) => row.id));
}
