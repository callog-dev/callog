import { Badge } from "@/components/ui/badge";

export function PersonName({ name, status }: { name: string; status: "active" | "inactive" }) {
  return (
    <>
      {name}
      {status === "inactive" && (
        <Badge variant="outline" className="ml-2">
          inactive
        </Badge>
      )}
    </>
  );
}
