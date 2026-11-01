import { useQuery } from "@tanstack/react-query";
import { Route, Send, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { adminApi, api, type Me } from "@/lib/api";
import { visibleNav } from "@/lib/nav";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opens on ⌘K (Ctrl+K) anywhere, or from the sidebar's Search button. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [open, setOpen] as const;
}

/** Jump to a page, a route, a person or a notification by id. */
export function CommandPalette({
  me,
  open,
  onOpenChange,
}: {
  me: Me;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim()).toLowerCase();
  const navigate = useNavigate();
  const routes = useQuery({ queryKey: ["routes"], queryFn: api.routes, enabled: open });
  const people = useQuery({
    queryKey: ["admin", "people", { q, page: "1", status: "all" }],
    queryFn: () => adminApi.people({ q, page: "1", status: "all" }),
    enabled: open && me.isAdmin && q.length >= 2,
  });
  const close = (next: boolean) => {
    if (!next) setSearch("");
    onOpenChange(next);
  };
  const go = (url: string) => {
    close(false);
    navigate(url);
  };
  // Filtered here rather than by cmdk: people are already matched on the server (by account too).
  const matches = (text: string) => text.toLowerCase().includes(q);
  const pages = visibleNav(me.isAdmin).filter((p) => matches(p.title));
  const routeList = (routes.data?.routes ?? []).filter((r) =>
    matches(`${r.id} ${r.description ?? ""}`),
  );
  const notificationId = me.isAdmin && UUID.test(q) ? q : null;

  return (
    <CommandDialog open={open} onOpenChange={close} title="Search Callog">
      <Command shouldFilter={false}>
        <CommandInput
          placeholder={me.isAdmin ? "Pages, routes, people…" : "Pages and routes…"}
          value={search}
          onValueChange={setSearch}
        />
        <CommandList>
          <CommandEmpty>Nothing found.</CommandEmpty>
          {notificationId && (
            <CommandGroup heading="Notification">
              <CommandItem onSelect={() => go(`/manage/deliveries/${notificationId}`)}>
                <Send /> Open notification {notificationId.slice(0, 8)}…
              </CommandItem>
            </CommandGroup>
          )}
          {pages.length > 0 && (
            <CommandGroup heading="Pages">
              {pages.map((page) => (
                <CommandItem key={page.url} onSelect={() => go(page.url)}>
                  <page.icon /> {page.title}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {routeList.length > 0 && (
            <CommandGroup heading="Routes">
              {routeList.map((r) => (
                <CommandItem key={r.id} onSelect={() => go(`/routes/${encodeURIComponent(r.id)}`)}>
                  <Route /> {r.id}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {q.length >= 2 && people.data && people.data.items.length > 0 && (
            <CommandGroup heading="People">
              {people.data.items.map((p) => (
                <CommandItem key={p.id} onSelect={() => go(`/manage/people/${p.id}`)}>
                  <UserRound /> {p.name}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
