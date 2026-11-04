// Substitutes ${NAME} placeholders in a manifest. Unknown placeholders are an error, so a typo can't ship a literal "${...}".
export function renderManifest(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`manifest placeholder \${${name}} has no value`);
    return v;
  });
}
