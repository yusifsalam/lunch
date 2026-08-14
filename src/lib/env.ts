function required(name: string): string {
  const value = process.env[name] ?? import.meta.env?.[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  get SITE_PASSCODE() {
    return required("SITE_PASSCODE");
  },
  get ADMIN_PASSCODE() {
    return required("ADMIN_PASSCODE");
  },
  get SESSION_SECRET() {
    return required("SESSION_SECRET");
  },
};
