/**
 * The registers of the data screen: one `Registers` while the keys are
 * unlocked, loaded on every connect and `sync.reset`, kept current by the
 * register events.
 */
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Registers } from "../../registers/registers";
import { useSocket } from "../../transport/context";
import { useVault } from "../../vault/context";

export interface RegistersContext {
  /** `null` while locked. */
  registers: Accessor<Registers | null>;
  /** Changes whenever the registers do: read it to follow them. */
  version: Accessor<number>;
}

export function createRegisters(): RegistersContext {
  const { socket, state: connection, onEvent } = useSocket();
  const { vault, state: keys } = useVault();
  const [registers, setRegisters] = createSignal<Registers | null>(null);
  const [version, setVersion] = createSignal(0);
  const unlocked = createMemo(() => keys()?.kind === "unlocked");

  createEffect(
    on(
      () => [socket(), vault(), unlocked()] as const,
      ([s, v, open]) => {
        if (!s || !v || !open) {
          setRegisters(null);
          return;
        }
        const r = new Registers((type, payload, options) => s.request(type, payload, options), v);
        const unsubscribe = r.subscribe(() => setVersion((n) => n + 1));
        const unlisten = onEvent((type, payload) => {
          switch (type) {
            case "register.updated":
              r.updated(payload.entry);
              return;
            case "register.deleted":
              r.deleted(payload.entry_id, payload.metric);
              return;
            case "sync.reset":
              void r.load().catch(() => undefined);
              r.reloadHistories();
              return;
          }
        });
        setRegisters(r);
        onCleanup(() => {
          unlisten();
          unsubscribe();
        });
      },
    ),
  );

  // Every connect: changes missed while away come with the reload.
  createEffect(
    on(
      () => [registers(), connection()?.kind === "open"] as const,
      ([r, open]) => {
        if (!r || !open) return;
        void r.load().catch(() => undefined);
        r.reloadHistories();
      },
    ),
  );

  return { registers, version };
}
