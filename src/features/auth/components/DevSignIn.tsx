// DEV BUILDS ONLY: `LoginPage` lazy-loads this under `import.meta.env.DEV`, so neither it nor the showcase cast
// reaches a production bundle. One-click sign-in as the seeded Nevo demo users (`supabase/seed.sql`) or the
// showcase department's cast (`npm run qa:showcase`, `scripts/qa/showcase-data.json`, docs/SHOWCASE_SCENARIOS.md).
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import showcase from "../../../../scripts/qa/showcase-data.json";

interface DevUser { email: string; name: string; hint?: string }
interface DevDepartment { id: string; name: string; password: string; users: DevUser[] }

const NEVO_USERS = ["admin", "sadran", "member1", "member2"] as const;

/** Showcase accounts are `sadran@<tag>.qa.local` and `m01…m08@<tag>.qa.local` (`scripts/qa/generate-week.mjs`); the default tag only. */
const DEPARTMENTS: DevDepartment[] = [
  {
    id: "nevo", name: he.auth.devNevo, password: "nevo-demo-1234",
    users: NEVO_USERS.map((user) => ({ email: `${user}@nevo.local`, name: he.auth.devUsers[user] })),
  },
  {
    id: "showcase", name: showcase.department.name, password: "qa-member-1234",
    users: [
      { email: "sadran@showcase.qa.local", name: he.auth.devUsers.sadran },
      ...showcase.members.map((member, index) => ({
        email: `m${String(index + 1).padStart(2, "0")}@showcase.qa.local`, name: member.name, hint: member.about,
      })),
    ],
  },
];

const STORAGE_KEY = "dev-sign-in-department";

function storedDepartment(): string {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    return DEPARTMENTS.some((department) => department.id === id) ? id! : "nevo";
  } catch {
    return "nevo";
  }
}

export default function DevSignIn() {
  const [departmentId, setDepartmentId] = useState(storedDepartment);
  const department = DEPARTMENTS.find((entry) => entry.id === departmentId) ?? DEPARTMENTS[0]!;

  function choose(id: string) {
    setDepartmentId(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* per-device convenience only */ }
  }

  async function signIn(email: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password: department.password });
    if (error) showErrorToast(error);
  }

  return (
    <div className="space-y-2">
      <Select value={department.id} onValueChange={choose}>
        <SelectTrigger className="bg-background" data-testid="dev-sign-in-department" aria-label={he.auth.devDepartment}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DEPARTMENTS.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="grid grid-cols-2 gap-2">
        {department.users.map((user) => (
          <Button
            key={user.email}
            type="button"
            variant="outline"
            className="h-auto min-h-9 whitespace-normal bg-background py-1.5"
            title={user.hint ? `${user.email} — ${user.hint}` : user.email}
            data-testid={`dev-sign-in-${user.email.split("@")[0]}`}
            onClick={() => signIn(user.email)}
          >
            {tv("auth.devSignInAs", { name: user.name })}
          </Button>
        ))}
      </div>
    </div>
  );
}
