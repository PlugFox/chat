/**
 * The turns this tab started (`message.send`, `turn.retry`), by the turn id
 * their answer named. A `read_history` request is answered only for one of
 * them (D-100): the server cannot make this tab read a chat it is not
 * talking in. Framework-free so it can be tested without a DOM.
 */

/** Turns remembered; older ones have ended long ago. */
const KEPT = 64;

export class OwnTurns {
  private readonly turns = new Map<string, string>();
  private readonly waiting = new Map<string, Set<(chatId: string) => void>>();

  started(turnId: string, chatId: string): void {
    this.turns.set(turnId, chatId);
    for (const old of this.turns.keys()) {
      if (this.turns.size <= KEPT) break;
      this.turns.delete(old);
    }
    for (const resolve of this.waiting.get(turnId) ?? []) resolve(chatId);
    this.waiting.delete(turnId);
  }

  /**
   * The chat of a turn this tab started; waits up to `ms` for the answer
   * that names it, which may come after the turn's first request.
   */
  chatOf(turnId: string, ms: number): Promise<string | undefined> {
    const known = this.turns.get(turnId);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const waiters = this.waiting.get(turnId) ?? new Set();
      const done = (chatId: string | undefined) => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.waiting.delete(turnId);
        resolve(chatId);
      };
      const timer = setTimeout(() => done(undefined), ms);
      waiters.add(done);
      this.waiting.set(turnId, waiters);
    });
  }
}
