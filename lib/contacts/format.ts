type NameParts = { first_name: string | null; last_name: string | null };

export function contactDisplayName(contact: NameParts): string {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
  return name || "Unnamed contact";
}

export function contactInitials(contact: NameParts): string {
  const first = contact.first_name?.trim().charAt(0) ?? "";
  const last = contact.last_name?.trim().charAt(0) ?? "";
  const initials = `${first}${last}`.toUpperCase();
  return initials || "?";
}

export function formatContactDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
