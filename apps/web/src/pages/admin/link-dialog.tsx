import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adminApi, type PersonOption } from "@/lib/api";

/** Invalidates everything that shows people or their accounts. */
export function usePeopleChanged() {
  const client = useQueryClient();
  return () => {
    for (const key of [
      "people",
      "people-options",
      "person",
      "unmapped",
      "suggested-links",
      "teams",
      "admins",
    ]) {
      void client.invalidateQueries({ queryKey: ["admin", key] });
    }
  };
}

/** Active people for pickers, fetched when a picker is shown. */
export function usePeopleOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "people-options"],
    queryFn: adminApi.peopleOptions,
    enabled,
  });
}

/** Confirming a suggested link and unlinking an account, wherever accounts are listed. */
export function useIdentityActions() {
  const changed = usePeopleChanged();
  const onError = (e: Error) => toast.error(e.message);
  const confirm = useMutation({
    mutationFn: adminApi.confirmIdentity,
    onSuccess: () => (toast.success("Confirmed"), changed()),
    onError,
  });
  const unlink = useMutation({
    mutationFn: adminApi.unlinkIdentity,
    onSuccess: () => (toast.success("Unlinked"), changed()),
    onError,
  });
  return { confirm: confirm.mutate, unlink: unlink.mutate };
}

/** Links an account to a person; `personId` fixes the person (from their page). */
export function LinkDialog({
  initialRef,
  personId: fixedPerson,
  onClose,
}: {
  initialRef: string;
  personId?: string;
  onClose: () => void;
}) {
  const people = usePeopleOptions(!fixedPerson);
  const [ref, setRef] = useState(initialRef);
  const [personId, setPersonId] = useState(fixedPerson);
  const changed = usePeopleChanged();
  const link = useMutation({
    mutationFn: () => adminApi.link(personId!, ref.trim()),
    onSuccess: () => {
      toast.success(`Linked ${ref}`);
      changed();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link an account</DialogTitle>
          <DialogDescription>
            Admin links are trusted as verified — make sure the account is theirs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ref">Account</Label>
            <Input
              id="ref"
              value={ref}
              placeholder="github:octocat, email:…, telegram:<user id>"
              onChange={(e) => setRef(e.target.value)}
            />
          </div>
          {!fixedPerson && (
            <div className="space-y-1">
              <Label>Person</Label>
              <PersonSelect people={people.data ?? []} value={personId} onChange={setPersonId} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => link.mutate()}
            disabled={!personId || !ref.trim() || link.isPending}
          >
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PersonSelect({
  people,
  value,
  onChange,
}: {
  people: PersonOption[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Choose a person" />
      </SelectTrigger>
      <SelectContent>
        {people.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
