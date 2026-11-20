export const askKeys = {
  all: ["ask"] as const,
  access: (profileId: string | undefined) => ["ask", "access", profileId ?? null] as const,
  probe: () => ["ask", "probe"] as const,
};
