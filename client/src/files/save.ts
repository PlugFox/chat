/** Hands a file to the browser to save, under its name. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // The download has taken the bytes by the next task.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
