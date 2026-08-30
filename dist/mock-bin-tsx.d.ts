declare const isTypeScriptFile: (file: string) => boolean;
/** Absolute file URL of the tsx loader, or null when tsx is not installed. */
declare const resolveTsxImportUrl: (scriptFile?: string) => string | null;
export { isTypeScriptFile, resolveTsxImportUrl };
