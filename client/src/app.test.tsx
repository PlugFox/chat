import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { App } from "./app";

describe("App", () => {
  it("renders the main landmark", () => {
    const { container } = render(() => <App />);
    expect(container.querySelector("main")).not.toBeNull();
  });
});
