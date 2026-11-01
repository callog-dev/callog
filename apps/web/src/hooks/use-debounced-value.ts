import { useEffect, useState } from "react";

/** How long typing pauses before a search runs. */
export const TYPING_PAUSE_MS = 200;

/** `value`, but only once it has stopped changing for `delay` ms. */
export function useDebouncedValue<T>(value: T, delay = TYPING_PAUSE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
