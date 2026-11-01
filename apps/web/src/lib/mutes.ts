import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Me, type RouteDetails, type RoutesResponse } from "@/lib/api";

/**
 * Mutes or unmutes a route's personal copies for the signed-in person. The change shows at
 * once in every cache that holds it, is restored if the server refuses, and the toast offers
 * to undo it.
 */
export function useMuteToggle() {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ routeId, muted }: { routeId: string; muted: boolean }) =>
      muted ? api.mute(routeId) : api.unmute(routeId),
    onMutate: async ({ routeId, muted }) => {
      const keys = [["routes"], ["route", routeId], ["me"]];
      // A refetch landing now would overwrite the optimistic state.
      await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
      const snapshot = keys.map((key) => [key, client.getQueryData(key)] as const);
      client.setQueryData<RoutesResponse>(
        ["routes"],
        (data) =>
          data && {
            ...data,
            routes: data.routes.map((r) => (r.id === routeId ? { ...r, muted } : r)),
          },
      );
      client.setQueryData<RouteDetails>(["route", routeId], (r) => r && { ...r, muted });
      client.setQueryData<Me>(["me"], (me) =>
        me?.person
          ? {
              ...me,
              preferences: {
                ...me.preferences,
                mutedRoutes: muted
                  ? [...new Set([...me.preferences.mutedRoutes, routeId])]
                  : me.preferences.mutedRoutes.filter((id) => id !== routeId),
              },
            }
          : me,
      );
      return snapshot;
    },
    onError: (err, _, snapshot) => {
      for (const [key, data] of snapshot ?? []) client.setQueryData(key, data);
      toast.error(err.message);
    },
    onSuccess: (preferences, { routeId, muted }) => {
      client.setQueryData<Me>(["me"], (me) => (me?.person ? { ...me, preferences } : me));
      toast.success(
        muted ? `Muted personal copies of ${routeId}` : `Personal copies of ${routeId} are back on`,
        // Runs after the row may be gone; the options callbacks above still apply.
        { action: { label: "Undo", onClick: () => mutation.mutate({ routeId, muted: !muted }) } },
      );
    },
  });
  return mutation;
}
