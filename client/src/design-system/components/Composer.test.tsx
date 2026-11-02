import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Composer, type ComposerAttach } from "./Composer";

afterEach(cleanup);

it("takes a file chosen while the connection, and so the attach button, was gone", () => {
  const onPick = vi.fn();
  const attach: ComposerAttach = { label: "Attach", accept: "image/*", onPick };
  const [current, setCurrent] = createSignal<ComposerAttach | undefined>(attach);
  const { container, queryByRole } = render(() => (
    <Composer
      label="Message"
      value=""
      onInput={() => {}}
      onSend={() => {}}
      sendLabel="Send"
      stopLabel="Stop"
      attach={current()}
    />
  ));
  const input = container.querySelector<HTMLInputElement>("input[type=file]");
  if (!input) throw new Error("no file input");

  // The camera is open; the socket drops behind it.
  setCurrent(undefined);
  expect(queryByRole("button", { name: "Attach" })).toBeNull();
  expect(input.isConnected).toBe(true);

  const photo = new File(["x"], "photo.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [photo], configurable: true });
  fireEvent.change(input);
  expect(onPick).toHaveBeenCalledWith([photo]);
});
