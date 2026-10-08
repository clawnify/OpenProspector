// A company's public address (info@, contact@, kantoor@): a shared inbox the
// company publishes, not a person's. It is kept on its own, never mixed into a
// campaign written to named people. OpenSequence keeps the same list in
// src/server/sequence-rules.ts: change both together.

/** Local parts that name a shared inbox, not a person. */
export const INBOX_PARTS = [
  "info", "contact", "contactus", "hello", "hi", "hallo", "office", "general", "mail", "post",
  "sales", "support", "service", "help", "team", "admin", "enquiries", "inquiries", "reception",
  "booking", "bookings", "orders",
  // Dutch
  "kantoor", "receptie", "welkom", "administratie",
  // Italian
  "segreteria", "amministrazione", "ufficio",
];

/** Whether an address is a company's shared inbox rather than a person's. */
export function isInbox(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at > 0 && INBOX_PARTS.includes(e.slice(0, at));
}

/** The same test in SQL, for a column holding an address. Its values bind to `INBOX_PARTS`. */
export function inboxSql(column: string): string {
  return `lower(substr(${column}, 1, instr(${column}, '@') - 1)) IN (${INBOX_PARTS.map(() => "?").join(", ")})`;
}
