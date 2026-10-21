"use client";

import { startTransition, useActionState, type FormEvent } from "react";

// useActionState for a form, without React's automatic form reset after the
// action runs. With <form action={...}> React clears the fields afterwards,
// which throws away what someone typed when the server rejects it and leaves
// controlled fields showing stale values.
export function useFormAction<State>(
  action: (state: Awaited<State>, form: FormData) => State | Promise<State>,
  initialState: Awaited<State>,
) {
  const [state, dispatch, pending] = useActionState(action, initialState);
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => dispatch(form));
  }
  return [state, onSubmit, pending] as const;
}
