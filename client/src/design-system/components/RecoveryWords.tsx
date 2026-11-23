/**
 * The recovery key as numbered words, shown once at setup and rotation. A
 * real `ol`, so screen readers announce each word's position; monospace and
 * two columns on phones, so the words are easy to copy onto paper.
 */
import { For, type JSX } from "solid-js";
import styles from "./RecoveryWords.module.css";

export function RecoveryWords(props: { label: string; words: string[] }): JSX.Element {
  return (
    <ol class={styles["words"]} aria-label={props.label}>
      <For each={props.words}>{(word) => <li class={styles["word"]}>{word}</li>}</For>
    </ol>
  );
}
