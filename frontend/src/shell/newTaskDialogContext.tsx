/**
 * shell/newTaskDialogContext.tsx — context for the global "New agent task"
 * dialog.
 *
 * The dialog itself (components/NewTaskDialog.tsx) is mounted once in
 * shell/AppShell; any view under the shell opens it via `useNewTaskDialog`.
 * Split out of AppShell so entry points (e.g. CommandPalette) can consume
 * it without creating an import cycle with the shell.
 */
import { createContext, useContext } from 'react';
import type { NewTaskDialogOptions } from '../components/NewTaskDialog';

export interface NewTaskDialogApi {
  /** Open the global "New agent task" dialog. */
  openNewTask: (options?: NewTaskDialogOptions) => void;
}

export const NewTaskDialogContext = createContext<NewTaskDialogApi>({
  openNewTask: () => {},
});

/** Call from any view under the shell to open the new-task dialog. */
export function useNewTaskDialog(): NewTaskDialogApi {
  return useContext(NewTaskDialogContext);
}
