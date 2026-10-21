"use client";

import { startTransition, useActionState, type FormEvent } from "react";

// useActionState for a form, without React's automatic form reset after the
// action runs. With only <form action={...}> React clears the fields
// afterwards, which throws away what someone typed when the server rejects
// it and leaves controlled fields showing stale values.
//
// Spread formProps onto the <form>. Once the page is interactive, onSubmit
// runs the action itself (React then skips its own run and its reset).
// Before that, the action prop still makes the browser POST the form to the
// server action, so values never end up in the URL.
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
  return { state, pending, formProps: { action: dispatch, onSubmit } };
}
