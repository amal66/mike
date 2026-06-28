/// <reference types="office-js" />

Office.onReady(() => {
  // no-op — ribbon commands are handled by the task pane
});

function openTaskpane(event: Office.AddinCommands.Event): void {
  Office.context.ui.openBrowserWindow("https://localhost:3000/taskpane.html");
  event.completed();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).openTaskpane = openTaskpane;
