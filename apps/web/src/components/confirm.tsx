import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  /** The button that goes ahead, e.g. "Revoke". */
  action: string;
  destructive?: boolean;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/** `if (await confirm({...})) doIt()` — one dialog for the whole app. */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within ConfirmProvider");
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  // Options outlive `open` so the dialog keeps its text while it animates out.
  const [options, setOptions] = useState<ConfirmOptions>();
  const [open, setOpen] = useState(false);
  const resolver = useRef<(ok: boolean) => void>(undefined);
  const confirm = useCallback<Confirm>((next) => {
    resolver.current?.(false);
    setOptions(next);
    setOpen(true);
    return new Promise((resolve) => (resolver.current = resolve));
  }, []);
  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = undefined;
    setOpen(false);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={open} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description && (
              <AlertDialogDescription>{options.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={options?.destructive ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {options?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
