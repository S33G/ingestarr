export function createBeforeQuitHandler(options: {
  shutdown(): Promise<void>;
  quit(): void;
}): (event: { preventDefault(): void }) => void {
  let shuttingDown: Promise<void> | undefined;
  let readyToQuit = false;
  return (event) => {
    if (readyToQuit) return;
    event.preventDefault();
    shuttingDown ??= options.shutdown().then(
      () => {
        readyToQuit = true;
        options.quit();
      },
      () => {
        readyToQuit = true;
        options.quit();
      },
    );
  };
}
