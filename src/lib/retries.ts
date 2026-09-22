import { raw, getSettings, audit } from "./store";
export function reserveReplacement(
  title: string,
  release: string,
  now = Date.now(),
  aliases: string[] = [],
) {
  return raw()
    .transaction(() => {
      const prior = raw()
        .prepare(
          "SELECT attempts,next_at,ignored FROM retry_titles WHERE identity=?",
        )
        .get(title) as
        | { attempts: number; next_at: number; ignored: number }
        | undefined;
      const keys = [...new Set([release, ...aliases])];
      const bad = keys.some((key) =>
        Boolean(
          raw()
            .prepare("SELECT attempts FROM retry_releases WHERE identity=?")
            .get(key),
        ),
      );
      if (prior?.ignored) throw new Error("Title is manually ignored");
      if (bad)
        throw new Error(
          "The same rejected release returned; manual attention required",
        );
      if ((prior?.attempts || 0) >= getSettings().retryLimit)
        throw new Error("Title replacement retry limit exceeded");
      if (prior && prior.next_at > now)
        throw new Error("Title replacement cooldown is active");
      const attempts = (prior?.attempts || 0) + 1;
      const next =
        now +
        Math.min(
          7 * 86400000,
          getSettings().retryCooldownMinutes * 60000 * 2 ** (attempts - 1),
        );
      raw()
        .prepare(
          "INSERT INTO retry_titles VALUES(?,?,?,0) ON CONFLICT(identity) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at",
        )
        .run(title, attempts, next);
      for (const key of keys)
        raw()
          .prepare(
            "INSERT INTO retry_releases VALUES(?,?,1) ON CONFLICT(identity) DO UPDATE SET attempts=attempts+1",
          )
          .run(key, title);
      return attempts;
    })
    .immediate();
}
export function resetReplacement(title: string, actor: string) {
  raw()
    .transaction(() => {
      raw()
        .prepare("DELETE FROM retry_releases WHERE title_identity=?")
        .run(title);
      raw().prepare("DELETE FROM retry_titles WHERE identity=?").run(title);
      audit("override", `Reset replacement limits: ${title}`, actor);
    })
    .immediate();
}
