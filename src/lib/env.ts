function read(name: string): string | undefined {
  return process.env[name] ?? import.meta.env?.[name];
}

function required(name: string): string {
  const value = read(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  get SESSION_SECRET() {
    return required("SESSION_SECRET");
  },
  /** Unset = no superadmin login possible. */
  get SUPERADMIN_PASSCODE() {
    return read("SUPERADMIN_PASSCODE");
  },
};
