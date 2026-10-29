/**
 * The tab's permission requests as a Solid context (D-099): a `Permissions`
 * while the keys are unlocked, loaded on every connect and kept current by
 * `permission.request` and `permission.resolved`. It also holds the metric
 * catalog, loaded on first use, which names metrics in requests, in replies'
 * tool calls and in the access log.
 */
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  useContext,
} from "solid-js";
import type { Metric } from "../protocol/generated/protocol";
import { Registers, type Request } from "../registers/registers";
import { useSocket } from "../transport/context";
import { useVault } from "../vault/context";
import { type Asked, Permissions } from "./permissions";

export interface PermissionsContext {
  /** Waiting requests, oldest first; empty while locked. */
  pending: Accessor<Asked[]>;
  approve: (requestId: string) => Promise<void>;
  deny: (requestId: string) => Promise<void>;
  /** The catalog's metric, once loaded; reading it loads the catalog. */
  metric: (key: string) => Metric | undefined;
}

const Context = createContext<PermissionsContext>();

export function PermissionsProvider(props: { children: JSX.Element }): JSX.Element {
  const { socket, state: connection, onEvent } = useSocket();
  const { vault, state: keys } = useVault();
  const [current, setCurrent] = createSignal<Permissions | null>(null);
  const [pending, setPending] = createSignal<Asked[]>([]);
  const [catalog, setCatalog] = createSignal<{ registers: Registers; load: () => Promise<Registers> } | null>(null);
  const [version, setVersion] = createSignal(0);
  const unlocked = createMemo(() => keys()?.kind === "unlocked");

  createEffect(
    on(
      () => [socket(), vault(), unlocked()] as const,
      ([s, v, open]) => {
        if (!s || !v || !open) {
          setCurrent(null);
          setPending([]);
          setCatalog(null);
          return;
        }
        const request: Request = (type, payload, options) => s.request(type, payload, options);
        const registers = new Registers(request, v);
        let loaded: Promise<Registers> | null = null;
        const load = () => {
          loaded ??= registers.load().then(
            () => registers,
            (e: unknown) => {
              loaded = null;
              throw e;
            },
          );
          return loaded;
        };
        const unwatch = registers.subscribe(() => setVersion((n) => n + 1));
        const permissions = new Permissions({
          request,
          openReason: (id, record) => v.openAuditReason(id, record),
          registers: load,
        });
        const unsubscribe = permissions.subscribe(() => setPending(permissions.list));
        const unlisten = onEvent((type, payload) => {
          if (type === "permission.request") void permissions.receive(payload).catch(() => undefined);
          else if (type === "permission.resolved") permissions.resolved(payload.request_id);
          else if (type === "register.updated" || type === "register.deleted" || type === "sync.reset") {
            // A new register or entry changes what a request may name.
            if (loaded) {
              loaded = null;
              void load().catch(() => undefined);
            }
          }
        });
        setCatalog({ registers, load });
        setCurrent(permissions);
        onCleanup(() => {
          unlisten();
          unsubscribe();
          unwatch();
        });
      },
    ),
  );

  // Every connect: a request may have come while this tab was away or reloading.
  createEffect(
    on(
      () => [current(), connection()?.kind === "open"] as const,
      ([permissions, open]) => {
        if (permissions && open) void permissions.load().catch(() => undefined);
      },
    ),
  );

  const metric = (key: string) => {
    version();
    const known = catalog();
    if (!known) return undefined;
    if (known.registers.state.kind !== "ready") void known.load().catch(() => undefined);
    return known.registers.metric(key);
  };

  const context: PermissionsContext = {
    pending,
    approve: (id) => current()?.approve(id) ?? Promise.resolve(),
    deny: (id) => current()?.deny(id) ?? Promise.resolve(),
    metric,
  };
  return <Context.Provider value={context}>{props.children}</Context.Provider>;
}

export function usePermissions(): PermissionsContext {
  const context = useContext(Context);
  if (!context) throw new Error("usePermissions outside PermissionsProvider");
  return context;
}
