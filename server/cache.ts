import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Small persistent cache for upstream evidence (Qloo, FEMA, Wikidata responses), so repeated plans
 * reuse identical evidence instead of re-spending the event key's quota. Entries expire after `ttlMs`.
 * Cached evidence keeps its original fetch time, which the UI shows.
 * Pinned entries (from a committed seed file) never expire, so the published demo shows the same
 * recorded model answer across redeploys; they keep the time they were originally fetched.
 */
export class EvidenceCache {
  private data = new Map<string, { at: number; value: unknown }>();
  private timer?: NodeJS.Timeout;
  private file?: string;
  private pinned = new Set<string>();
  constructor(
    dir = process.env.CACHE_DIR,
    private ttlMs = 7 * 24 * 3600 * 1000,
    seedFile?: string,
  ) {
    if (seedFile) this.seed(seedFile);
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      this.file = join(dir, "evidence.json");
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as [
        string,
        { at: number; value: unknown },
      ][];
      for (const [k, v] of raw)
        if (!this.pinned.has(k) && Date.now() - v.at < this.ttlMs)
          this.data.set(k, v);
    } catch {
      /* first run or unreadable cache: start empty */
    }
  }
  private seed(file: string) {
    try {
      const rows = JSON.parse(readFileSync(file, "utf8")).entries as {
        key: string;
        at: string;
        value: unknown;
      }[];
      for (const r of rows) {
        this.data.set(r.key, { at: Date.parse(r.at), value: r.value });
        this.pinned.add(r.key);
      }
    } catch {
      /* no seed: every answer is fetched live */
    }
  }
  get<T>(key: string): { at: number; value: T } | undefined {
    const e = this.data.get(key);
    if (!e || (!this.pinned.has(key) && Date.now() - e.at > this.ttlMs))
      return undefined;
    return e as { at: number; value: T };
  }
  set(key: string, value: unknown) {
    this.data.set(key, { at: Date.now(), value });
    if (this.file && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.data]));
          renameSync(`${this.file}.tmp`, this.file!);
        } catch {
          /* cache persistence is best effort */
        }
      }, 2000);
  }
  async through<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<{ value: T; cachedAt?: number }> {
    const hit = this.get<T>(key);
    if (hit) return { value: hit.value, cachedAt: hit.at };
    const value = await fn();
    this.set(key, value);
    return { value };
  }
}
