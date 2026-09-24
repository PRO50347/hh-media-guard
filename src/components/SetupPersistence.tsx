"use client";
import {
  createContext,
  useContext,
  useLayoutEffect,
  type RefObject,
} from "react";
export const SetupPersistence = createContext<{
  register: (save: () => Promise<void>) => () => void;
} | null>(null);

/** Wizard navigation shares the form's normal validated save path. */
export function useSetupSave(
  form: RefObject<HTMLFormElement | null>,
  busy: boolean,
  save: () => Promise<boolean>,
) {
  const context = useContext(SetupPersistence);
  useLayoutEffect(
    () =>
      context?.register(async () => {
        if (busy)
          throw new Error(
            "Wait for the current operation to finish, then continue.",
          );
        if (form.current && !form.current.reportValidity())
          throw new Error("Correct the highlighted fields before continuing.");
        if (!(await save()))
          throw new Error(
            "The form could not be saved. Check its error message before continuing.",
          );
      }),
    [context, form, busy, save],
  );
}
