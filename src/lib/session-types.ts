/** The logged-in user as the browser sees it (never contains secrets). */
export type LocalUser = {
  username: string;
  displayName: string;
  role: string;
  isAdmin: boolean;
  pinEnabled?: boolean;
  mustChangePassword?: boolean;
  /** Changes whenever the profile picture changes (null = no picture). */
  avatarVersion?: number | null;
  /** Last time the user's browser pinged the server (ISO), for the "online" dot. */
  lastSeenAt?: string | null;
};
