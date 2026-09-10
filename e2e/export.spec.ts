import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

function readStoredEntries(bytes: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const start = offset + 30;
    const dataStart = start + nameLength + bytes.readUInt16LE(offset + 28);
    files.set(bytes.subarray(start, start + nameLength).toString("utf8"), bytes.subarray(dataStart, dataStart + size).toString("utf8"));
    offset = dataStart + size;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
  return files;
}

test("Sadran downloads the entire current week as a Hebrew Excel workbook", async ({ page }) => {
  const weekStart = await getWeekStart("live");
  const service = serviceRoleClient();
  const [{ data: requests, error: requestError }, { data: rides, error: rideError }] = await Promise.all([
    service.from("requests").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart),
    service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart).neq("status", "cancelled"),
  ]);
  if (requestError) throw requestError;
  if (rideError) throw rideError;
  expect(requests!.length).toBeGreaterThan(0);
  expect(rides!.length).toBeGreaterThan(0);
  await signIn(page, SEEDED_USERS.sadran);
  await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${weekStart}/board`);
  // The export button now lives in the board's kebab "actions" menu (UX_FLOWS.md §4.2, 2026-09-10) at every width.
  await page.getByRole("button", { name: he.sadranBoard.actionsMenu, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: he.excelExport.button, exact: true })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: he.excelExport.button, exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`siddur-${weekStart}-${NEVO_DEPARTMENT_ID}.xlsx`);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const files = readStoredEntries(await readFile(filePath!));
  const workbook = files.get("xl/workbook.xml")!;
  for (const label of [he.excelExport.requestsSheet, he.excelExport.boardSheet, he.excelExport.scoresSheet]) expect(workbook).toContain(label);
  const strings = files.get("xl/sharedStrings.xml")!;
  for (const request of requests!) expect(strings).toContain(request.id);
  for (const ride of rides!) expect(strings).toContain(ride.id);
  expect(strings).toContain(he.excelExport.notes);
  expect(files.get("xl/worksheets/sheet1.xml")!.match(/<row /g)).toHaveLength(requests!.length + 1);
  expect(files.get("xl/worksheets/sheet2.xml")!.match(/<row /g)).toHaveLength(rides!.length + 1);
  for (const content of files.values()) expect(content).not.toContain("<f>");
});
