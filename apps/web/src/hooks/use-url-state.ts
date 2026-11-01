import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

/**
 * Page state kept in the query string, so a view can be linked to and survives a reload.
 * `defaults` must be a module-level constant. Values equal to their default are left out of
 * the URL; updates replace the history entry.
 */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [key, params.get(key) ?? value]),
      ) as T,
    [params, defaults],
  );
  const update = useCallback(
    (patch: Partial<T>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === defaults[key]) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams, defaults],
  );
  return [state, update] as const;
}
