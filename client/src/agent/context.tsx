/**
 * The tab's `Agent` as a Solid context: created once the keys are unlocked,
 * it reads the provider settings on every connect and keeps the agent session
 * started with the active provider.
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
import type { ProvidersValue } from "../protocol/generated/protocol";
import { useSocket } from "../transport/context";
import { useVault } from "../vault/context";
import { Agent, type AgentState, PROVIDERS_KEY, type ProvidersState } from "./agent";

export interface AgentContext {
  /** `null` while locked or signed out. */
  providers: Accessor<ProvidersState | null>;
  agent: Accessor<AgentState>;
  /** Changes the provider settings; throws `TransportError` when it cannot. */
  update: (change: (value: ProvidersValue) => ProvidersValue) => Promise<void>;
}

const Context = createContext<AgentContext>();

export function AgentProvider(props: { children: JSX.Element }): JSX.Element {
  const { socket, state: connection, onEvent, setResume } = useSocket();
  const { vault, state: keys } = useVault();
  const [current, setCurrent] = createSignal<Agent | null>(null);
  const [providers, setProviders] = createSignal<ProvidersState | null>(null);
  const [agentState, setAgentState] = createSignal<AgentState>({ kind: "idle" });
  // Every reconnect stores a new unlocked state: only a lock may close the agent.
  const unlocked = createMemo(() => keys()?.kind === "unlocked");

  createEffect(
    on(
      () => [socket(), vault(), unlocked()] as const,
      ([s, v, unlocked]) => {
        if (!s || !v || !unlocked) {
          setCurrent(null);
          setProviders(null);
          setAgentState({ kind: "idle" });
          return;
        }
        const agent = new Agent({
          request: (type, payload, options) => s.request(type, payload, options),
          userId: v.userId,
          seal: (plaintext) => v.sealSetting(PROVIDERS_KEY, plaintext),
          open: (record) => v.openSetting(PROVIDERS_KEY, record),
        });
        const sync = () => {
          setProviders(agent.providers);
          setAgentState(agent.state);
        };
        sync();
        const unsubscribe = agent.subscribe(sync);
        const unlisten = onEvent((type, payload) => {
          if (type === "settings.updated") void agent.receive(payload);
          else if (type === "sync.reset") void agent.load();
        });
        setResume(() => agent.sessionId);
        setCurrent(agent);
        onCleanup(() => {
          // Locked or signed out: the server drops the provider config; a
          // reply being written still finishes (D-088).
          agent.close();
          setResume(undefined);
          unlisten();
          unsubscribe();
        });
      },
    ),
  );

  // Every connect: a setting may have changed while this tab was offline.
  createEffect(
    on(
      () => [current(), connection()] as const,
      ([agent, state]) => {
        if (!agent || !state) return;
        if (state.kind === "open") void agent.load();
        agent.connected(state);
      },
    ),
  );

  const update = (change: (value: ProvidersValue) => ProvidersValue) => {
    const agent = current();
    if (!agent) return Promise.reject(new Error("locked"));
    return agent.update(change);
  };

  return <Context.Provider value={{ providers, agent: agentState, update }}>{props.children}</Context.Provider>;
}

export function useAgent(): AgentContext {
  const context = useContext(Context);
  if (!context) throw new Error("useAgent outside AgentProvider");
  return context;
}
