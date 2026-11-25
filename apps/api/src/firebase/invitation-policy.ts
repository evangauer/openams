// Invitation lifetime limits, shared by hosted identity and external access control.
// Kept in their own module so neither has to import the other to read them.

/** How long a new invitation stays open unless configured (AMS_INVITATION_TTL_HOURS). */
export const DEFAULT_INVITATION_TTL_HOURS = 7 * 24;
/** The longest an invitation may stay open, whoever configures it. */
export const MAX_INVITATION_TTL_HOURS = 30 * 24;
