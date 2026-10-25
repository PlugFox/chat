import { render } from "solid-js/web";
import { App } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
render(() => <App />, root);
