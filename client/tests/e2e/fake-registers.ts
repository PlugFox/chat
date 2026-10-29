/**
 * Registers as the test build sees them (docs/protocol.md, "Registers"),
 * answered from memory for `FakeKeys`: the catalog the server seeds, and
 * entries stored as the client sealed them. `conflictNext` makes the next
 * update fail as if another device had changed the entry first.
 */
import type {
  Metric,
  MetricCategory,
  RegisterEntry,
  RegisterInfo,
  Requests,
  ScopeKey,
} from "../../src/protocol/generated/protocol";
import { Refused } from "./fake-chats";

const metric = (
  key: string,
  names: Record<string, string>,
  unit: string,
  aggregate: string,
  integer: boolean,
  max: number,
): Metric => ({
  key,
  category: key.split(".")[0] ?? "",
  register: "measurements",
  names,
  unit,
  quantity: { kg: "mass", cm: "length", kcal: "energy" }[unit] ?? "count",
  value_type: integer ? "integer" : "decimal",
  precision: integer ? 0 : 1,
  min: integer ? 0 : 1,
  max,
  aggregate,
});

/** As `server/migrations/20261029000012_registers.sql` seeds it. */
export const CATEGORIES: MetricCategory[] = [
  { key: "body", names: { en: "Body", ru: "Тело" } },
  { key: "activity", names: { en: "Activity", ru: "Активность" } },
  { key: "exercise", names: { en: "Exercise", ru: "Упражнения" } },
  { key: "nutrition", names: { en: "Nutrition", ru: "Питание" } },
];
export const METRICS: Metric[] = [
  metric("body.weight", { en: "Weight", ru: "Вес" }, "kg", "avg", false, 500),
  metric("body.height", { en: "Height", ru: "Рост" }, "cm", "avg", false, 300),
  metric("activity.steps", { en: "Steps", ru: "Шаги" }, "count", "sum", true, 200000),
  metric("activity.active_energy", { en: "Energy burned", ru: "Сожжённые калории" }, "kcal", "sum", true, 20000),
  metric("exercise.squats", { en: "Squats", ru: "Приседания" }, "count", "sum", true, 10000),
  metric("exercise.push_ups", { en: "Push-ups", ru: "Отжимания" }, "count", "sum", true, 10000),
  metric("nutrition.energy_intake", { en: "Energy eaten", ru: "Съеденные калории" }, "kcal", "sum", true, 20000),
];

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

export class FakeRegisters {
  /** Metric → scope id. */
  readonly scopes = new Map<string, string>();
  readonly entries = new Map<string, RegisterEntry>();
  conflictNext = false;
  private clock = Date.now();

  constructor(
    private readonly keys: { scopeKeys: ScopeKey[] },
    private readonly broadcast: (type: string, payload: unknown) => void,
  ) {}

  private now(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  private registers(): RegisterInfo[] {
    return [...this.scopes].map(([metric, scope_id]) => {
      const mine = [...this.entries.values()].filter((e) => e.metric === metric);
      return {
        metric,
        scope_id,
        entries: mine.length,
        ...(mine.length > 0 ? { latest_at: Math.max(...mine.map((e) => e.occurred_at)) } : {}),
      };
    });
  }

  handle(type: string, payload: unknown): Promise<unknown> | undefined {
    switch (type) {
      case "metric.list":
        return Promise.resolve({ categories: CATEGORIES, metrics: METRICS, registers: this.registers() });
      case "register.setup": {
        const p = payload as Requests["register.setup"]["request"];
        if (!METRICS.some((m) => m.key === p.metric)) return Promise.reject(new Refused("metric.not_found"));
        if (!this.scopes.has(p.metric)) {
          this.scopes.set(p.metric, p.scope_id);
          this.keys.scopeKeys.push({
            scope_id: p.scope_id,
            key_version: 1,
            public_key: p.public_key,
            wrapped_private_key: p.wrapped_private_key,
          });
        }
        return Promise.resolve({ scope_id: this.scopes.get(p.metric) });
      }
      case "register.entries": {
        const p = payload as Requests["register.entries"]["request"];
        const limit = p.limit ?? 1000;
        const list = [...this.entries.values()]
          .filter(
            (e) =>
              e.metric === p.metric &&
              (p.from === undefined || e.occurred_at >= p.from) &&
              (p.to === undefined || e.occurred_at < p.to) &&
              (!p.before ||
                e.occurred_at < p.before.occurred_at ||
                (e.occurred_at === p.before.occurred_at && e.entry_id < p.before.entry_id)),
          )
          .sort((a, b) => b.occurred_at - a.occurred_at || (b.entry_id < a.entry_id ? -1 : 1));
        const page = list.slice(0, limit);
        const last = page.at(-1);
        return Promise.resolve({
          entries: page,
          ...(list.length > limit && last ? { next: { occurred_at: last.occurred_at, entry_id: last.entry_id } } : {}),
        });
      }
      case "register.create": {
        const p = payload as Requests["register.create"]["request"];
        if (!this.scopes.has(p.metric)) return Promise.reject(new Refused("register.not_set_up"));
        const known = this.entries.get(p.entry_id);
        if (known) {
          if (same(known.value, p.value) && known.occurred_at === p.occurred_at)
            return Promise.resolve({ entry: known });
          return Promise.reject(new Refused("register.exists"));
        }
        const entry: RegisterEntry = { ...p, updated_at: this.now(), rev: 1 };
        this.entries.set(p.entry_id, entry);
        this.broadcast("register.updated", { entry });
        return Promise.resolve({ entry });
      }
      case "register.update": {
        const p = payload as Requests["register.update"]["request"];
        const known = this.entries.get(p.entry_id);
        if (!known) return Promise.reject(new Refused("register.not_found"));
        if (same(known.value, p.value) && known.occurred_at === p.occurred_at) return Promise.resolve({ entry: known });
        if (this.conflictNext || known.rev !== p.rev) {
          this.conflictNext = false;
          return Promise.reject(new Refused("register.conflict"));
        }
        const entry = {
          ...known,
          occurred_at: p.occurred_at,
          value: p.value,
          rev: known.rev + 1,
          updated_at: this.now(),
        };
        this.entries.set(p.entry_id, entry);
        this.broadcast("register.updated", { entry });
        return Promise.resolve({ entry });
      }
      case "register.delete": {
        const { entry_id } = payload as Requests["register.delete"]["request"];
        const known = this.entries.get(entry_id);
        if (known && this.entries.delete(entry_id)) {
          this.broadcast("register.deleted", { entry_id, metric: known.metric });
        }
        return Promise.resolve({});
      }
      default:
        return undefined;
    }
  }
}
